import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthenticationError } from "@/sync/auth";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { VerificationCache } from "@/sync/verification-cache";
import { WebDavStore } from "@/sync/webdav";
import { seed, setup } from "./helpers";

const incremental = (engine: PlainEngine) =>
	engine.preview(undefined, "incremental");
async function pair() {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "base");
	s.server.put("n.md", "base");
	return s;
}
it("cold refresh reads bodies; unchanged refresh checks versions without bodies, state or writes", async () => {
	const s = await pair();
	const reads = vi.spyOn(s.A.local, "read");
	const first = await incremental(s.A);
	expect(first.readBytes).toBe(8);
	const second = await incremental(s.A);
	expect(second.rows).toEqual(first.rows);
	expect(second.readBytes).toBe(0);
	expect([second.local.reused, second.remote.reused]).toEqual([1, 1]);
	expect(reads).toHaveBeenCalledTimes(1);
	expect(s.server.counters).toMatchObject({
		get: 2,
		bodies: 1,
		notModified: 1,
		propfind: 2,
		put: 0,
		delete: 0,
	});
	expect(await readdir(s.a)).toEqual(["n.md"]);
});
it("same-size local edits with restored mtime still rehash through ctime; unchanged remote sends no body", async () => {
	const s = await pair();
	await incremental(s.A);
	const old = await stat(join(s.a, "n.md"));
	await writeFile(join(s.a, "n.md"), "EDIT");
	await utimes(join(s.a, "n.md"), old.atime, old.mtime);
	const next = await incremental(s.A);
	expect(next.rows[0]?.kind).toBe("conflict");
	expect([next.local.reused, next.remote.reused, next.readBytes]).toEqual([
		0, 1, 4,
	]);
});
it("replacement inode and symlink substitution cannot reuse an earlier local digest", async () => {
	const s = await pair();
	await incremental(s.A);
	await writeFile(join(s.a, "stage"), "EDIT");
	await rename(join(s.a, "stage"), join(s.a, "n.md"));
	expect((await incremental(s.A)).local.reused).toBe(0);
	await rm(join(s.a, "n.md"));
	await symlink(join(s.a, "missing"), join(s.a, "n.md"));
	const next = await incremental(s.A);
	expect(next.rows.find((r) => r.path === "n.md")?.kind).toBe("excluded");
	expect(next.local.files["n.md"]).toBeUndefined();
});
it("remote edits including updated-only changes reread bytes and retain distinct raw/shared hashes", async () => {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "---\nupdated: local\n---\nbody\n");
	s.server.put("n.md", "---\nupdated: remote\n---\nbody\n");
	const first = await incremental(s.A);
	s.server.put("n.md", "---\nupdated: changed\n---\nbody\n");
	const second = await incremental(s.A);
	expect(second.rows[0]?.kind).toBe("equal");
	expect(second.remote.files["n.md"]?.hash).not.toBe(
		first.remote.files["n.md"]?.hash,
	);
	expect(second.remote.files["n.md"]?.syncHash).toBe(
		first.remote.files["n.md"]?.syncHash,
	);
	expect([second.local.reused, second.remote.reused]).toEqual([1, 0]);
	expect(await readFile(join(s.a, "n.md"), "utf8")).toContain("updated: local");
});
it("fresh listings detect additions, deletions, renames and file/directory collisions", async () => {
	const s = await pair();
	await incremental(s.A);
	await rename(join(s.a, "n.md"), join(s.a, "renamed.md"));
	s.server.files.delete("n.md");
	s.server.put("n.md/child.md", "new");
	s.server.dirs.add("n.md");
	const next = await incremental(s.A);
	expect(next.local.files["n.md"]).toBeUndefined();
	expect(next.remote.files["n.md"]).toBeUndefined();
	expect(next.rows.find((r) => r.path === "renamed.md")?.kind).toBe("upload");
	await rename(join(s.a, "renamed.md"), join(s.a, "n.md"));
	expect(
		(await incremental(s.A)).rows.find((r) => r.path === "n.md/child.md")?.kind,
	).toBe("conflict");
});
it.each(["", 'W/"weak"', "unquoted"])(
	"missing or unreliable ETag %j always reads the body",
	async (etag) => {
		const s = await pair();
		s.server.hooks.responseEtag = etag;
		await incremental(s.A);
		expect((await incremental(s.A)).remote.reused).toBe(0);
		expect(s.server.counters.bodies).toBe(2);
	},
);
it("a server ignoring conditions safely returns a fresh digest", async () => {
	const s = await pair();
	await incremental(s.A);
	s.server.hooks.ignoreConditional = true;
	expect((await incremental(s.A)).remote.reused).toBe(0);
	expect(s.server.counters.bodies).toBe(2);
});
it.each(["", '"different"', 'W/"weak"'])(
	"304 with unconfirmed validator %j falls back to an unconditional body read",
	async (etag) => {
		const s = await pair();
		await incremental(s.A);
		s.server.hooks.notModifiedEtag = etag;
		const next = await incremental(s.A);
		expect(next.remote.reused).toBe(0);
		expect(s.server.counters).toMatchObject({
			get: 3,
			bodies: 2,
			notModified: 1,
		});
	},
);
it("a weak response matching the cached opaque tag is not sufficient for raw byte reuse", async () => {
	const s = await pair();
	const first = await incremental(s.A);
	s.server.hooks.responseEtag = `W/${first.remote.files["n.md"]?.version}`;
	expect((await incremental(s.A)).remote.reused).toBe(0);
	expect(s.server.counters.bodies).toBe(2);
});
it("remote change after listing is observed by conditional GET rather than trusting a directory ETag", async () => {
	const s = await pair();
	await incremental(s.A);
	s.server.hooks.beforeGet = () => {
		s.server.put("n.md", "late edit");
		s.server.hooks.beforeGet = null;
	};
	expect((await incremental(s.A)).rows[0]?.kind).toBe("conflict");
});
it("local path changes during a body read invalidate the result and the whole cache", async () => {
	const s = await pair();
	const realRead = s.A.local.read.bind(s.A.local);
	vi.spyOn(s.A.local, "read").mockImplementationOnce(async (path) => {
		const seen = await realRead(path);
		await writeFile(join(s.a, path), "raced");
		return seen;
	});
	const next = await incremental(s.A);
	expect(next.rows[0]?.kind).toBe("unknown");
	await expect(s.A.run(next)).rejects.toThrow("Incomplete");
	expect(s.server.counters.put).toBe(0);
});
it.each(["list", "forbidden", "truncated", "disappeared"])(
	"%s failure cannot reuse stale content and clears the cache",
	async (failure) => {
		const s = await pair();
		await incremental(s.A);
		if (failure === "list") s.server.hooks.failList = true;
		if (failure === "forbidden") s.server.hooks.forbidden = "n.md";
		if (failure === "truncated") {
			s.server.put("n.md", "longer");
			s.server.hooks.truncateGet = true;
		}
		if (failure === "disappeared")
			s.server.hooks.beforeGet = () => s.server.files.delete("n.md");
		const next = await incremental(s.A);
		expect(next.rows.some((r) => r.kind === "unknown")).toBe(true);
		expect(next.remote.files["n.md"]).toBeUndefined();
		expect(s.server.counters.put + s.server.counters.delete).toBe(0);
		s.server.hooks.failList = false;
		s.server.hooks.forbidden = null;
		s.server.hooks.beforeGet = null;
		s.server.put("n.md", "base");
		const retry = await incremental(s.A);
		expect([retry.local.reused, retry.remote.reused]).toEqual([0, 0]);
		await expect(s.A.run(next)).rejects.toThrow("Incomplete");
	},
);
it("401 after a warm cache still fails authentication, with no stale plan or writes", async () => {
	const s = await pair();
	await incremental(s.A);
	s.server.hooks.unauthorized = "n.md";
	await expect(incremental(s.A)).rejects.toBeInstanceOf(AuthenticationError);
	s.server.hooks.unauthorized = null;
	expect((await incremental(s.A)).remote.reused).toBe(0);
	expect(s.server.counters.put + s.server.counters.delete).toBe(0);
});
it("manual full verification bypasses cache, repairs an incorrectly unchanged server ETag, then warms the next refresh", async () => {
	const s = await pair();
	await incremental(s.A);
	s.server.files.get("n.md").body = Buffer.from("EDIT"); // deliberately broken validator
	expect((await incremental(s.A)).rows[0]?.kind).toBe("equal");
	const full = await s.A.preview(undefined, "full");
	expect(full.rows[0]?.kind).toBe("conflict");
	expect([full.local.reused, full.remote.reused]).toEqual([0, 0]);
	const next = await incremental(s.A);
	expect(next.rows).toEqual(full.rows);
	expect(next.readBytes).toBe(0);
});
it("cache never substitutes for execution/inspection raw-byte preconditions", async () => {
	const s = await setup();
	await seed(s);
	await writeFile(join(s.a, "n.md"), "local edit");
	await incremental(s.A);
	const warm = await incremental(s.A);
	s.server.files.get("n.md").body = Buffer.from("changed after preview");
	const before = s.server.counters.put;
	const row = warm.rows.find((r) => r.path === "n.md");
	if (!row) throw new Error("Fixture row missing");
	await expect(s.A.inspect(row)).rejects.toThrow("changed");
	await expect(s.A.run(warm)).rejects.toThrow("changed");
	expect(s.server.counters.put).toBe(before);
});
it("cache scope includes local root, remote identity and exclusions; newly constructed engines share only an explicit cache", async () => {
	const s = await pair(),
		cache = new VerificationCache();
	const create = (root = s.a, excluded: string[] = [], username = "") =>
		new PlainEngine(
			new LocalStore(root, excluded),
			new WebDavStore({
				url: s.server.url,
				username,
				password: username ? "synthetic" : "",
			}),
			root,
			cache,
		);
	await incremental(create());
	expect((await incremental(create())).remote.reused).toBe(1);
	expect((await incremental(create(s.b))).remote.reused).toBe(0);
	expect(
		(await incremental(create(s.a, ["n.md"]))).local.files["n.md"],
	).toBeUndefined();
	expect((await incremental(create(s.a, [], "other-user"))).remote.reused).toBe(
		0,
	);
	expect(
		(await incremental(new PlainEngine(s.A.local, s.remote, s.a))).remote
			.reused,
	).toBe(0);
});
it.each([
	[1, 100000],
	[20000, 1],
])(
	"bounded cache falls back to reads when limits are %j/%j",
	async (entries, bytes) => {
		const s = await pair(),
			engine = new PlainEngine(
				s.A.local,
				s.remote,
				s.a,
				new VerificationCache(entries, bytes),
			);
		await incremental(engine);
		expect((await incremental(engine)).readBytes).toBe(8);
	},
);
it("superseded completion and invalidation cannot resurrect an older snapshot; preview mutations do not poison the cache", async () => {
	const s = await pair(),
		cache = new VerificationCache();
	const p = await incremental(s.A);
	const older = cache.begin("scope", "incremental"),
		newer = cache.begin("scope", "incremental");
	cache.finish(newer.generation, p.local, p.remote);
	cache.finish(older.generation);
	expect(cache.begin("scope", "incremental").previous).toBeDefined();
	cache.clear();
	cache.finish(newer.generation, p.local, p.remote);
	expect(cache.begin("scope", "incremental").previous).toBeUndefined();
	if (p.local.files["n.md"]) p.local.files["n.md"].hash = "tampered";
	expect((await incremental(s.A)).rows[0]?.kind).toBe("equal");
});
it("generated edit sequences give the same raw/shared hashes and classifications as independent full reads", async () => {
	const s = await setup();
	await mkdir(join(s.a, "folder"));
	s.server.dirs.add("folder");
	const fullEngine = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
	for (let i = 0; i < 24; i++) {
		const path = `folder/${i % 4}.md`,
			file = join(s.a, path);
		const content = `---\nupdated: ${i}\n---\n中文 😀 ${i % 7}\r\n`;
		if (i % 3 === 0) {
			await writeFile(file, content);
			s.server.put(path, content);
		} else if (i % 3 === 1) await writeFile(file, content);
		else {
			s.server.files.delete(path);
			await rm(file, { force: true });
		}
		const next = await incremental(s.A),
			full = await fullEngine.preview();
		expect(next.rows).toEqual(full.rows);
		expect(next.local.files).toEqual(full.local.files);
		expect(next.remote.files).toEqual(full.remote.files);
	}
	expect(s.server.counters.put + s.server.counters.delete).toBe(0);
});
