import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { setup, sync } from "./helpers";

const many = (prefix: string) =>
	Array.from({ length: 4000 }, (_, i) => `${prefix} ${i}\n`).join("");
it.each([
	["overlap", "a\nb\n", "A\nb\n", "X\nb\n", "Overlapping"],
	["insertion boundary", "a\nb\n", "a\nx\nb\n", "A\nb\n", "Overlapping"],
	[
		"ambiguous repeat",
		"a\nx\nx\nz\n",
		"a\nx\nz\n",
		"A\nx\nx\nz\n",
		"ambiguous-alignment",
	],
	[
		"aggregate input",
		"b".repeat(550000),
		"l".repeat(550000),
		"r".repeat(550000),
		"input-limit",
	],
	[
		"aggregate lines",
		"a\n".repeat(21000),
		"b\n".repeat(21000),
		"c\n".repeat(21000),
		"line-limit",
	],
	["whole task work", many("base"), many("left"), many("right"), "work-limit"],
	["no baseline", null, "left", "right", "baseline"],
])(
	"never mutates either side, intent or baseline after %s",
	async (_name, base, local, remote, reason) => {
		const s = await setup();
		if (base !== null) {
			await writeFile(join(s.a, "n.md"), base);
			await sync(s.A);
		}
		await writeFile(join(s.a, "n.md"), local);
		s.server.put("n.md", remote);
		const row = (await s.A.preview()).rows[0]!;
		const state = await s.A.journal.load();
		const changes = [
			vi.spyOn(s.A.local, "change"),
			vi.spyOn(s.A.remote, "change"),
		];
		const puts = s.server.counters.put,
			deletes = s.server.counters.delete;
		await expect(s.A.resolve(row, "merge")).rejects.toThrow(reason);
		for (const spy of changes) expect(spy).not.toHaveBeenCalled();
		expect(s.server.counters.put).toBe(puts);
		expect(s.server.counters.delete).toBe(deletes);
		expect(await s.A.journal.load()).toEqual(state);
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(local);
		expect(s.server.files.get("n.md").body.toString()).toBe(remote);
	},
);

it("preserves BOM and mixed endings through engine output without whole-file conversion", async () => {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "\ufeffhead\r\nmid\ntail");
	await sync(s.A);
	await writeFile(join(s.a, "n.md"), "\ufeffHEAD\r\nmid\ntail");
	s.server.put("n.md", "\ufeffhead\r\nmid\nTAIL\n");
	await s.A.resolve((await s.A.preview()).rows[0]!, "merge");
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
		"\ufeffHEAD\r\nmid\nTAIL\n",
	);
	expect(s.server.files.get("n.md").body.toString()).toBe(
		"\ufeffHEAD\r\nmid\nTAIL\n",
	);
});

it("rechecks raw updated-only edits before starting a merge", async () => {
	const s = await setup();
	const note = (time: string, body: string) =>
		`---\nupdated: ${time}\n---\n${body}`;
	await writeFile(join(s.a, "n.md"), note("A", "a\nb\n"));
	await sync(s.A);
	await writeFile(join(s.a, "n.md"), note("A", "A\nb\n"));
	s.server.put("n.md", "a\nB\n");
	const row = (await s.A.preview()).rows[0]!;
	const state = await s.A.journal.load(),
		puts = s.server.counters.put;
	await writeFile(join(s.a, "n.md"), note("new timestamp", "A\nb\n"));
	await expect(s.A.resolve(row, "merge")).rejects.toThrow("changed");
	expect(s.server.counters.put).toBe(puts);
	expect(await s.A.journal.load()).toEqual(state);
});

it("rechecks after computing and archiving a merge before any destination mutation", async () => {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "a\nb\n");
	await sync(s.A);
	await writeFile(join(s.a, "n.md"), "A\nb\n");
	s.server.put("n.md", "a\nB\n");
	const row = (await s.A.preview()).rows[0]!;
	const save = s.A.journal.save.bind(s.A.journal);
	s.A.journal.save = async (state) => {
		await writeFile(join(s.a, "n.md"), "late edit");
		return save(state);
	};
	const remoteChange = vi.spyOn(s.A.remote, "change");
	await expect(s.A.resolve(row, "merge")).rejects.toThrow("changed");
	expect(remoteChange).not.toHaveBeenCalled();
	expect((await s.A.journal.load()).pending).toEqual({});
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe("late edit");
});

it("recovers a merged target once, keeping local updated and format 2", async () => {
	const s = await setup();
	const note = (body: string) => `---\nupdated: local\n---\n${body}`;
	await writeFile(join(s.a, "n.md"), note("a\nb\n"));
	await sync(s.A);
	await writeFile(join(s.a, "n.md"), note("A\nb\n"));
	s.server.put("n.md", "a\nB\n");
	s.server.hooks.loseResponse = true;
	await expect(
		s.A.resolve((await s.A.preview()).rows[0]!, "merge"),
	).rejects.toThrow();
	const writes = s.server.counters.put;
	const restarted = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
	await restarted.recover();
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(note("A\nB\n"));
	expect(s.server.files.get("n.md").body.toString()).toBe("A\nB\n");
	expect(await restarted.journal.load()).toMatchObject({
		format: 2,
		pending: {},
	});
	const checkpoints = (await readdir(restarted.journal.dir)).filter((x) =>
		x.endsWith(".json"),
	);
	await restarted.recover();
	await sync(restarted);
	expect(s.server.counters.put).toBe(writes);
	expect(
		(await readdir(restarted.journal.dir)).filter((x) => x.endsWith(".json")),
	).toEqual(checkpoints);
});
