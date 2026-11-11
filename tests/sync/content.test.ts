import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEADER_LIMIT, MarkdownProjection, sharedText } from "@/sync/content";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { setup, sync } from "./helpers";

const note = (updated: string, body = "body", area = "lab") =>
	`---\narea: ${area}\nupdated: ${updated}\ndoneTime: 2026-01-01\n---\n${body}\n`;
const shared = (body = "body", area = "lab") =>
	`---\narea: ${area}\ndoneTime: 2026-01-01\n---\n${body}\n`;

describe("local Markdown updated projection", () => {
	it.each([
		["updated: old\n", ""],
		["'updated': old # local comment\n", ""],
		["updated:\n", ""],
		["updated: |\n  first\n  second\n", ""],
		['"updat\\u0065d": old\n', ""],
		[
			"nested:\n  updated: shared\nupdated: old\n",
			"nested:\n  updated: shared\n",
		],
		["Updated: shared\nupdated: old\n", "Updated: shared\n"],
	])("removes only the top-level updated field: %s", (input, rest) => {
		const before = `---\n${input}area: lab # keep\n---\nupdated: body\n`;
		expect(sharedText("a.md", before)).toBe(
			`---\n${rest}area: lab # keep\n---\nupdated: body\n`,
		);
		expect(sharedText("a.components", before)).toBe(before);
	});
	it("preserves BOM, CRLF, comments and arbitrary body bytes across small stream chunks", () => {
		const input = Buffer.from(
			"\ufeff---\r\n# keep\r\nupdated: old\r\narea: x\r\n---\r\n中文正文\u0000",
		);
		const projection = new MarkdownProjection();
		const chunks: Buffer[] = [];
		for (let i = 0; i < input.length; i += 2)
			chunks.push(projection.push(input.subarray(i, i + 2)));
		chunks.push(projection.push(Buffer.alloc(0), true));
		expect(Buffer.concat(chunks)).toEqual(
			Buffer.from("\ufeff---\r\n# keep\r\narea: x\r\n---\r\n中文正文\u0000"),
		);
	});
	it("treats a header containing only updated as an absent shared header", () => {
		expect(sharedText("a.MD", "---\nupdated: old\n---\nbody")).toBe("body");
		expect(sharedText("a.md", "---\n---\nbody")).toBe("body");
		expect(sharedText("a.md", "body\n---\nupdated: content\n---")).toBe(
			"body\n---\nupdated: content\n---",
		);
	});
	it.each([
		"---\nupdated: a\nupdated: b\n---\nbody",
		"---\nupdated: [broken\n---\nbody",
		"---\nupdated: a\nbody",
		"---\nupdated: &time a\nother: *time\n---\nbody",
		"---\n{ updated: a, area: lab }\n---\nbody",
		"---\n? updated\n: a\n---\nbody",
		`---\nupdated: ${"x".repeat(HEADER_LIMIT)}\n---\nbody`,
	])("fails closed for ambiguous or unsupported frontmatter", (input) => {
		expect(() => sharedText("n.md", input)).toThrow();
	});
});

describe("updated stays local through synchronization and recovery", () => {
	it("adopts different timestamps without ordinary writes, then ignores timestamp-only edits", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("2026-01-01"));
		s.server.put("n.md", note("2026-02-02"));
		const preview = await s.A.preview();
		expect(preview.rows[0]?.kind).toBe("equal");
		expect(preview.rows[0]?.local?.hash).not.toBe(
			preview.rows[0]?.remote?.hash,
		);
		expect(preview.rows[0]?.local?.syncHash).toBe(
			preview.rows[0]?.remote?.syncHash,
		);
		expect(await readdir(s.a)).toEqual(["n.md"]);
		await s.A.run(preview);
		await writeFile(join(s.a, "n.md"), note("2026-03-03"));
		await sync(s.A);
		expect(s.server.counters.put).toBe(0);
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(note("2026-03-03"));
		expect(s.server.files.get("n.md").body.toString()).toBe(note("2026-02-02"));
		const state = await s.A.journal.load();
		expect(
			await readFile(s.A.journal.blob(state.baseline["n.md"]!), "utf8"),
		).toBe(shared());
	});
	it("uploads shared bytes only and keeps each device's updated during content changes", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("A"));
		await sync(s.A);
		await sync(s.B);
		expect(s.server.files.get("n.md").body.toString()).toBe(shared());
		expect(await readFile(join(s.b, "n.md"), "utf8")).toBe(shared());
		await writeFile(join(s.b, "n.md"), note("B"));
		await writeFile(join(s.a, "n.md"), note("A2", "new body", "new area"));
		await sync(s.A);
		await sync(s.B);
		const b = await readFile(join(s.b, "n.md"), "utf8");
		expect(b).toContain("updated: B\n");
		expect(sharedText("n.md", b)).toBe(shared("new body", "new area"));
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
			note("A2", "new body", "new area"),
		);
		expect(s.server.files.get("n.md").body.toString()).toBe(
			shared("new body", "new area"),
		);
		const writes = s.server.counters.put;
		await sync(s.A);
		await sync(s.B);
		expect(s.server.counters.put).toBe(writes);
	});
	it("does not import a remote updated into an existing note without that property", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), shared());
		await sync(s.A);
		s.server.put("n.md", note("remote", "changed"));
		await sync(s.A);
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(shared("changed"));
	});
	it("preserves a local property when the shared content has no frontmatter", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), "---\nupdated: A\n---\nbody");
		await sync(s.A);
		s.server.put("n.md", "new body");
		await sync(s.A);
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
			"---\nupdated: A\n---\nnew body",
		);
	});
	it.each(["area", "doneTime", "nested", "body"])(
		"still detects changes to %s",
		async (field) => {
			const s = await setup();
			await writeFile(join(s.a, "n.md"), note("A"));
			let remote = note("B");
			if (field === "area") remote = remote.replace("area: lab", "area: other");
			if (field === "doneTime")
				remote = remote.replace("doneTime: 2026-01-01", "doneTime: 2026-01-02");
			if (field === "nested")
				remote = remote.replace(
					"area: lab",
					"area: lab\nnested:\n  updated: changed",
				);
			if (field === "body") remote += "updated: actual body\n";
			s.server.put("n.md", remote);
			expect((await s.A.preview()).rows[0]?.kind).toBe("conflict");
		},
	);
	it("retains raw preconditions for an updated-only edit after preview", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("A"));
		await sync(s.A);
		s.server.put("n.md", shared("remote body"));
		const p = await s.A.preview();
		await writeFile(join(s.a, "n.md"), note("new local timestamp"));
		await expect(s.A.run(p)).rejects.toThrow("changed");
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
			note("new local timestamp"),
		);
	});
	it("recovers lost upload acknowledgement without uploading local metadata", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("A"));
		s.server.hooks.loseResponse = true;
		await expect(sync(s.A)).rejects.toThrow();
		const puts = s.server.counters.put;
		const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
		await restart.recover();
		expect(s.server.counters.put).toBe(puts);
		expect(s.server.files.get("n.md").body.toString()).toBe(shared());
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(note("A"));
		expect((await restart.journal.load()).pending).toEqual({});
	});
	it("durably retains local updated across a crash after parking the original inode", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("A"));
		await sync(s.A);
		s.server.put("n.md", note("remote", "new body"));
		s.A.local.change = async (path, _expected, _source, id) => {
			await mkdir(join(s.a, ".plain-sync/displaced"), { recursive: true });
			await rename(join(s.a, path), join(s.a, ".plain-sync/displaced", id));
			throw new Error("crash");
		};
		await expect(sync(s.A)).rejects.toThrow("crash");
		const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
		await restart.recover();
		const actual = await readFile(join(s.a, "n.md"), "utf8");
		expect(actual).toContain("updated: A\n");
		expect(sharedText("n.md", actual)).toBe(shared("new body"));
		expect((await restart.journal.load()).pending).toEqual({});
	});
	it("merges shared content and preserves local updated instead of the chosen remote time", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("A", "one\ntwo\nthree"));
		await sync(s.A);
		await writeFile(join(s.a, "n.md"), note("A2", "ONE\ntwo\nthree"));
		s.server.put("n.md", note("remote", "one\ntwo\nTHREE"));
		const row = (await s.A.preview()).rows[0]!;
		expect((await s.A.inspect(row)).local).not.toContain("updated:");
		await s.A.resolve(row, "merge");
		const actual = await readFile(join(s.a, "n.md"), "utf8");
		expect(actual).toContain("updated: A2\n");
		expect(sharedText("n.md", actual)).toBe(shared("ONE\ntwo\nTHREE"));
		expect(s.server.files.get("n.md").body.toString()).toBe(
			shared("ONE\ntwo\nTHREE"),
		);
	});
	it("marks malformed frontmatter unknown instead of uploading a timestamp", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), "---\nupdated: [bad\n---\nbody");
		const p = await s.A.preview();
		expect(p.rows[0]?.kind).toBe("unknown");
		await expect(s.A.run(p)).rejects.toThrow("Incomplete");
		expect(s.server.counters.put).toBe(0);
	});
	it("refuses legacy raw-byte checkpoints without changing their interpretation or files", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), note("A"));
		await sync(s.A);
		const paths = (await readdir(s.A.journal.dir))
			.filter((x) => x.endsWith(".json"))
			.sort();
		const path = join(s.A.journal.dir, paths.at(-1)!);
		const legacy = JSON.parse(await readFile(path, "utf8"));
		legacy.format = 1;
		await writeFile(path, JSON.stringify(legacy));
		await expect(s.A.preview()).rejects.toThrow("explicit migration");
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(note("A"));
	});
});
