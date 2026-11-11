import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { seed, setup, sync } from "./helpers";

it("resumes a local overwrite interrupted after parking the old inode", async () => {
	const s = await setup();
	await seed(s);
	s.server.put("n.md", "remote edit");
	s.A.local.change = async (path, _expected, _source, id) => {
		await mkdir(join(s.a, ".plain-sync/displaced"), { recursive: true });
		await rename(join(s.a, path), join(s.a, ".plain-sync/displaced", id));
		throw new Error("process killed");
	};
	await expect(sync(s.A)).rejects.toThrow("killed");
	const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
	await restart.recover();
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe("remote edit");
	expect(Object.keys((await restart.journal.load()).pending)).toHaveLength(0);
});
it("keeps a newly created target after the old inode was parked", async () => {
	const s = await setup();
	await seed(s);
	s.server.put("n.md", "remote edit");
	s.A.local.change = async (path, _expected, _source, id) => {
		await rename(join(s.a, path), join(s.a, ".plain-sync/displaced", id));
		await writeFile(join(s.a, path), "new local edit");
		throw new Error("process killed");
	};
	await expect(sync(s.A)).rejects.toThrow();
	const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
	await restart.recover();
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe("new local edit");
	expect(
		(await restart.preview()).rows.find((r) => r.path === "n.md")?.kind,
	).toBe("conflict");
});
it("preserves an editor write arriving during the upload", async () => {
	const s = await setup();
	await seed(s);
	await writeFile(join(s.a, "n.md"), "upload");
	s.server.hooks.beforeCommit = async () => {
		await writeFile(join(s.a, "n.md"), "typing during upload");
	};
	await expect(sync(s.A)).rejects.toThrow("Local changed");
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
		"typing during upload",
	);
	await s.A.recover();
	expect((await s.A.preview()).rows.find((r) => r.path === "n.md")?.kind).toBe(
		"conflict",
	);
});
it("keeps successful per-file baselines when a later operation fails", async () => {
	const s = await setup();
	await writeFile(join(s.a, "a.md"), "a");
	await writeFile(join(s.a, "b.md"), "b");
	s.server.hooks.beforeCommit = async (e) => {
		if (e.path === "b.md") throw new Error("injected error");
	};
	await expect(sync(s.A)).rejects.toThrow();
	const state = await s.A.journal.load();
	expect(state.baseline["a.md"]).toMatch(/^[a-f0-9]{64}$/);
	expect(state.baseline["b.md"]).toBeUndefined();
	s.server.hooks.beforeCommit = null;
	await s.A.recover();
	await sync(s.A);
	expect(s.server.counters.put).toBe(2);
});
it("refuses corrupt latest state instead of silently using an older baseline", async () => {
	const s = await setup();
	await seed(s);
	const checkpoints = (await readdir(s.A.journal.dir))
		.filter((n) => n.endsWith(".json"))
		.sort();
	await writeFile(
		join(s.A.journal.dir, checkpoints[checkpoints.length - 1] as string),
		"broken",
	);
	await expect(s.A.preview()).rejects.toThrow();
});
it("ignores uncommitted checkpoint fragments on restart", async () => {
	const s = await setup();
	await seed(s);
	await writeFile(join(s.A.journal.dir, ".checkpoint-unfinished"), "partial");
	expect((await s.A.preview()).writes).toBe(0);
});
it("does not mutate anything after a local directory listing failure", async () => {
	const s = await setup();
	await seed(s);
	s.A.local.list = async () => {
		throw new Error("permission denied");
	};
	const p = await s.A.preview();
	await expect(s.A.run(p)).rejects.toThrow("Incomplete");
	expect(s.server.files.has("n.md")).toBe(true);
});
it("does not propagate a partial local file read as deletion", async () => {
	const s = await setup();
	await seed(s);
	s.A.local.read = async () => {
		throw new Error("read failed");
	};
	const p = await s.A.preview();
	expect(p.rows.some((r) => r.kind === "unknown")).toBe(true);
	await expect(s.A.run(p)).rejects.toThrow();
	expect(s.server.counters.delete).toBe(0);
});
it("excludes symlinks and refuses a redirected metadata directory before writing a lock", async () => {
	const s = await setup();
	await writeFile(join(s.b, "outside.txt"), "outside");
	await symlink(s.b, join(s.a, "linked"));
	const p = await s.A.preview();
	expect(p.rows.find((r) => r.path === "linked")?.kind).toBe("excluded");
	await symlink(s.b, join(s.a, ".plain-sync"));
	await expect(s.A.run(p)).rejects.toThrow("Unsafe");
	expect(await readdir(s.b)).toEqual(["outside.txt"]);
});
it("handles prototype-shaped file names as ordinary byte content", async () => {
	const s = await setup();
	for (const path of ["__proto__", "constructor", "toString"])
		await writeFile(join(s.a, path), "content");
	await sync(s.A);
	await sync(s.B);
	for (const path of ["__proto__", "constructor", "toString"])
		expect(await readFile(join(s.b, path), "utf8")).toBe("content");
});
it("blocks case collisions in parent directories and file/folder collisions", async () => {
	const s = await setup();
	s.server.dirs.add("A");
	s.server.dirs.add("a");
	s.server.put("A/x.md", "x");
	s.server.put("a/y.md", "y");
	await writeFile(join(s.a, "A"), "local file");
	const p = await s.A.preview();
	expect(
		p.rows
			.filter((r) => r.path.startsWith("A") || r.path.startsWith("a"))
			.every((r) => r.kind === "conflict"),
	).toBe(true);
	await sync(s.A);
	expect(s.server.counters.put).toBe(0);
});
it("rejects an overlapping conditional delete after another writer replaces the bytes", async () => {
	const s = await setup();
	await seed(s);
	await rm(join(s.a, "n.md"));
	await writeFile(join(s.b, "n.md"), "B edit");
	const pa = await s.A.preview(),
		pb = await s.B.preview();
	let enter!: () => void, release!: () => void;
	const hit = new Promise<void>((r) => (enter = r)),
		gate = new Promise<void>((r) => (release = r));
	s.server.hooks.beforeCommit = async (e) => {
		if (e.method === "DELETE") {
			enter();
			await gate;
		}
	};
	const deleting = s.A.run(pa);
	await hit;
	await s.B.run(pb);
	release();
	await expect(deleting).rejects.toThrow("precondition");
	expect(s.server.files.get("n.md").body.toString()).toBe("B edit");
});
it("will not retry a confirmed remote write after an external revert", async () => {
	const s = await setup();
	await seed(s);
	await writeFile(join(s.a, "n.md"), "new");
	const save = s.A.journal.save.bind(s.A.journal);
	let n = 0;
	s.A.journal.save = async (state) => {
		await save(state);
		if (++n === 2) throw new Error("crash");
	};
	await expect(sync(s.A)).rejects.toThrow();
	s.server.put("n.md", "base");
	const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
	await restart.recover();
	expect(s.server.files.get("n.md").body.toString()).toBe("base");
	expect(
		(await restart.preview()).rows.find((r) => r.path === "n.md")?.kind,
	).toBe("conflict");
});
it("rejects overlapping text edits and allows explicit side selection with both versions retained", async () => {
	const s = await setup();
	await seed(s);
	await writeFile(join(s.a, "n.md"), "left");
	s.server.put("n.md", "right");
	const row = (await s.A.preview()).rows.find((r) => r.path === "n.md");
	if (!row) throw new Error("missing row");
	await expect(s.A.resolve(row, "merge")).rejects.toThrow("Overlapping");
	await s.A.resolve(row, "remote");
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe("right");
	expect((await readdir(s.A.journal.blobs)).length).toBeGreaterThanOrEqual(3);
});

it("compares text read-only without creating metadata and rejects stale preview text", async () => {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "left");
	s.server.put("n.md", "right");
	const row = (await s.A.preview()).rows.find((r) => r.path === "n.md");
	if (!row) throw new Error("missing row");
	expect(await s.A.inspect(row)).toEqual({
		local: "left",
		remote: "right",
		base: null,
	});
	expect((await readdir(s.a)).includes(".plain-sync")).toBe(false);
	s.server.put("n.md", "changed");
	await expect(s.A.inspect(row)).rejects.toThrow("changed");
});
it("preserves local CRLF endings when merging non-overlapping text", async () => {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "one\r\ntwo\r\nthree\r\n");
	await sync(s.A);
	await writeFile(join(s.a, "n.md"), "ONE\r\ntwo\r\nthree\r\n");
	s.server.put("n.md", "one\r\ntwo\r\nTHREE\r\n");
	const row = (await s.A.preview()).rows.find((r) => r.path === "n.md");
	if (!row) throw new Error("missing row");
	await s.A.resolve(row, "merge");
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe(
		"ONE\r\ntwo\r\nTHREE\r\n",
	);
});

it("read-only capability blocks local downloads as well as remote writes, before creating metadata", async () => {
	const s = await setup();
	s.remote.writable = false;
	s.server.put("remote.md", "read only");
	const p = await s.A.preview();
	await expect(s.A.run(p)).rejects.toThrow("capability");
	expect(await readdir(s.a)).toEqual([]);
});

it("a repeated unchanged sync neither captures bytes again nor adds checkpoints", async () => {
	const s = await setup();
	await seed(s);
	const before = (await readdir(s.A.journal.dir)).filter((p) =>
		p.endsWith(".json"),
	);
	let captures = 0;
	const read = s.A.local.read.bind(s.A.local);
	s.A.local.read = async (path, archive) => {
		if (archive) captures++;
		return read(path, archive);
	};
	await sync(s.A);
	expect(captures).toBe(0);
	expect(
		(await readdir(s.A.journal.dir)).filter((p) => p.endsWith(".json")),
	).toEqual(before);
});
