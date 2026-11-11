import {
	mkdir,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { WebDavStore } from "@/sync/webdav";
import { seed, setup, sync } from "./helpers";

describe("plain-directory transactions", () => {
	it("adopts identical bytes without ordinary rewrites, independent of timestamps, then stays stable", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), "same");
		await utimes(join(s.a, "n.md"), 1, 1);
		s.server.put("n.md", "same");
		const p = await s.A.preview();
		expect(p.rows[0]?.kind).toBe("equal");
		expect(await readdir(s.a)).toEqual(["n.md"]);
		await s.A.run(p);
		await sync(s.A);
		expect(s.server.counters.put).toBe(0);
		expect((await s.A.preview()).writes).toBe(0);
	});
	it("classifies first conflicts, one-sided files and remote-only binary attachments", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), "local");
		s.server.put("n.md", "remote");
		await writeFile(join(s.a, "custom.zby"), "x");
		s.server.put("audio.mp3", Buffer.from([0, 255, 13]));
		expect((await s.A.preview()).rows.map((r) => [r.path, r.kind])).toEqual([
			["audio.mp3", "download"],
			["custom.zby", "upload"],
			["n.md", "conflict"],
		]);
		await sync(s.A);
		expect(await readFile(join(s.a, "audio.mp3"))).toEqual(
			Buffer.from([0, 255, 13]),
		);
		expect(s.server.files.get("n.md").body.toString()).toBe("remote");
	});
	it("finds same-size content edits with restored old mtime", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "EDIT");
		await utimes(join(s.a, "n.md"), 1, 1);
		expect(
			(await s.A.preview()).rows.find((r) => r.path === "n.md")?.kind,
		).toBe("upload");
	});
	it("converges identical dual edits, protects differing dual edits and delete versus modify", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "same edit");
		s.server.put("n.md", "same edit");
		await sync(s.A);
		await writeFile(join(s.a, "n.md"), "left");
		s.server.put("n.md", "right");
		expect(
			(await s.A.preview()).rows.find((r) => r.path === "n.md")?.kind,
		).toBe("conflict");
		await rm(join(s.a, "n.md"));
		expect(
			(await s.A.preview()).rows.find((r) => r.path === "n.md")?.kind,
		).toBe("conflict");
		await sync(s.A);
		expect(s.server.files.get("n.md").body.toString()).toBe("right");
	});
	it("propagates guarded deletes and retains recoverable baseline bytes", async () => {
		const s = await setup();
		await seed(s);
		await rm(join(s.a, "n.md"));
		await sync(s.A);
		await sync(s.B);
		expect(s.server.files.has("n.md")).toBe(false);
		const states = await s.B.journal.load();
		expect(states.baseline["n.md"]).toBe(null);
		expect((await readdir(s.B.journal.blobs)).length).toBeGreaterThan(0);
	});
	it("does not lose distinct additions in the upstream overlapping-publish schedule", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "a.md"), "A");
		await writeFile(join(s.b, "b.md"), "B");
		const pa = await s.A.preview(),
			pb = await s.B.preview();
		await Promise.all([s.A.run(pa), s.B.run(pb)]);
		await sync(s.A);
		await sync(s.B);
		expect([...s.server.files.keys()].sort()).toEqual(["a.md", "b.md", "n.md"]);
		expect(await readFile(join(s.a, "b.md"), "utf8")).toBe("B");
	});
	it("atomically rejects simultaneous creation of the same path", async () => {
		const s = await setup();
		await writeFile(join(s.a, "new.md"), "A");
		await writeFile(join(s.b, "new.md"), "B");
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((r) => (release = r)),
			hit = new Promise<void>((r) => (entered = r));
		let n = 0;
		s.server.hooks.beforeCommit = async () => {
			if (++n === 1) {
				entered();
				await gate;
			}
		};
		const pa = await s.A.preview(),
			pb = await s.B.preview();
		const a = s.A.run(pa);
		await hit;
		await s.B.run(pb);
		release();
		await expect(a).rejects.toThrow("precondition");
		expect(s.server.files.get("new.md").body.toString()).toBe("B");
		expect(await readFile(join(s.a, "new.md"), "utf8")).toBe("A");
	});
	it("rejects overlapping stale conditional overwrite and delete", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "A");
		await writeFile(join(s.b, "n.md"), "B");
		const pa = await s.A.preview(),
			pb = await s.B.preview();
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((r) => (release = r)),
			hit = new Promise<void>((r) => (entered = r));
		let n = 0;
		s.server.hooks.beforeCommit = async () => {
			if (++n === 1) {
				entered();
				await gate;
			}
		};
		const a = s.A.run(pa);
		await hit;
		await s.B.run(pb);
		release();
		await expect(a).rejects.toThrow("precondition");
		expect(s.server.files.get("n.md").body.toString()).toBe("B");
	});
	it.each(["local", "remote"])(
		"rechecks %s edits after preview",
		async (side) => {
			const s = await setup();
			await seed(s);
			await writeFile(join(s.a, "n.md"), "a");
			const p = await s.A.preview();
			if (side === "local") await writeFile(join(s.a, "n.md"), "newer");
			else s.server.put("n.md", "newer");
			await expect(s.A.run(p)).rejects.toThrow("changed");
			expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
				side === "local" ? "newer" : "a",
			);
		},
	);
	it.each(["list", "403", "download"])(
		"treats %s failure as unknown and never propagates deletion",
		async (fault) => {
			const s = await setup();
			await seed(s);
			await rm(join(s.a, "n.md"));
			if (fault === "list") s.server.hooks.failList = true;
			if (fault === "403") s.server.hooks.forbidden = "n.md";
			if (fault === "download") s.server.hooks.truncateGet = true;
			const p = await s.A.preview();
			expect(p.rows.some((r) => r.kind === "unknown")).toBe(true);
			await expect(s.A.run(p)).rejects.toThrow();
			expect(s.server.files.has("n.md")).toBe(true);
		},
	);
	it("recovers a lost response and restart without resending the completed upload", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "edited");
		s.server.hooks.loseResponse = true;
		await expect(sync(s.A)).rejects.toThrow();
		const writes = s.server.counters.put;
		const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
		await restart.recover();
		await sync(restart);
		expect(s.server.counters.put).toBe(writes);
		expect((await restart.journal.load()).pending).toEqual({});
	});
	it("recovers after mutation succeeded but checkpoint failed", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "edited");
		const save = s.A.journal.save.bind(s.A.journal);
		let n = 0;
		s.A.journal.save = async (st) => {
			if (++n === 2) throw new Error("disk full");
			await save(st);
		};
		await expect(sync(s.A)).rejects.toThrow("disk full");
		const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
		await restart.recover();
		expect(
			(await restart.preview()).rows.find((r) => r.path === "n.md")?.kind,
		).toBe("equal");
	});
	it("preserves unexpected edits during recovery as a stable conflict", async () => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "edited");
		s.server.hooks.loseResponse = true;
		await expect(sync(s.A)).rejects.toThrow();
		s.server.put("n.md", "external");
		await s.A.recover();
		await s.A.recover();
		await sync(s.A);
		expect(s.server.files.get("n.md").body.toString()).toBe("external");
		expect(
			(await s.A.preview()).rows.find((r) => r.path === "n.md")?.kind,
		).toBe("conflict");
	});
	it("handles Chinese, spaces, percent and custom extensions; blocks case collisions and metadata", async () => {
		const s = await setup();
		await mkdir(join(s.a, "中文 空格"));
		await writeFile(join(s.a, "中文 空格", "a%?#.zby"), "bytes");
		await mkdir(join(s.a, ".obsidian"));
		await writeFile(join(s.a, ".obsidian", "secret"), "not synced");
		await sync(s.A);
		await sync(s.B);
		expect(await readFile(join(s.b, "中文 空格", "a%?#.zby"), "utf8")).toBe(
			"bytes",
		);
		expect(s.server.files.has(".obsidian/secret")).toBe(false);
		s.server.put("Case.md", "1");
		s.server.put("case.md", "2");
		expect(
			(await s.A.preview()).rows
				.filter((r) => r.path.toLowerCase() === "case.md")
				.every((r) => r.kind === "conflict"),
		).toBe(true);
	});
	it("defaults remote capabilities to read-only even on loopback", async () => {
		const s = await setup();
		const e = new PlainEngine(
			new LocalStore(s.a),
			new WebDavStore({ url: s.server.url }),
			s.a,
		);
		await writeFile(join(s.a, "n.md"), "n");
		await expect(sync(e)).rejects.toThrow("capability");
		expect(s.server.counters.put).toBe(0);
	});
	it("supports explicit conflict choice with preserved versions and clean text merge", async () => {
		const s = await setup();
		await writeFile(join(s.a, "n.md"), "one\ntwo\nthree\n");
		await sync(s.A);
		await writeFile(join(s.a, "n.md"), "ONE\ntwo\nthree\n");
		s.server.put("n.md", "one\ntwo\nTHREE\n");
		const row = (await s.A.preview()).rows.find((r) => r.path === "n.md")!;
		await s.A.resolve(row, "merge");
		expect(await readFile(join(s.a, "n.md"), "utf8")).toBe("ONE\ntwo\nTHREE\n");
		expect((await s.A.preview()).writes).toBe(0);
	});
});
