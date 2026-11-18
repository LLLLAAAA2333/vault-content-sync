import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthenticationError } from "@/sync/auth";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { type Store, scan } from "@/sync/model";
import { WebDavStore } from "@/sync/webdav";
import { seed, setup, sync } from "./helpers";

it("missing password rejects before any I/O for an authenticated endpoint", async () => {
	const s = await setup();
	expect(
		() => new WebDavStore({ url: s.server.url, username: "user" }),
	).toThrow("尚未填写密码");
	expect(s.server.counters).toEqual({
		get: 0,
		propfind: 0,
		put: 0,
		delete: 0,
		bodies: 0,
		notModified: 0,
	});
	expect(await readdir(s.a)).toEqual([]);
});
it.each(["", "nested"])(
	"401 at directory %s raises one authentication error, not an unknown plan",
	async (path) => {
		const s = await setup();
		await writeFile(join(s.a, "local.md"), "local");
		s.server.put("nested/file.md", "remote");
		s.server.dirs.add("nested");
		s.server.hooks.unauthorized = path;
		await expect(s.A.preview()).rejects.toBeInstanceOf(AuthenticationError);
		expect(
			s.server.counters.put + s.server.counters.delete + s.server.counters.get,
		).toBe(0);
		expect(await readdir(s.a)).toEqual(["local.md"]);
	},
);
it("401 during file reads rejects a partial scan and stops scheduling further reads", async () => {
	const s = await setup();
	for (let i = 0; i < 30; i++)
		s.server.put(`n${String(i).padStart(2, "0")}.md`, "x");
	s.server.hooks.unauthorized = "n00.md";
	await expect(s.A.preview()).rejects.toThrow("认证失败");
	expect(s.server.counters.get).toBeLessThanOrEqual(1);
	expect(s.server.counters.put + s.server.counters.delete).toBe(0);
	expect(await readdir(s.a)).toEqual([]);
});
it("waits for an in-flight worker to finish before returning an auth failure", async () => {
	let finish: (() => void) | undefined,
		settled = false;
	const store: Store = {
		identity: "synthetic",
		writable: false,
		list: async () => ({ files: ["a", "b", "c"], excluded: [], folders: [] }),
		read: async (p) => {
			if (p === "a") {
				await Promise.resolve();
				throw new AuthenticationError();
			}
			await new Promise<void>((r) => {
				finish = r;
			});
			return { hash: "x", size: 1, version: "v" };
		},
		text: async () => null,
		change: async () => {
			throw Error("must not write");
		},
	};
	const result = scan(store).catch((e) => {
		settled = true;
		throw e;
	});
	await new Promise((r) => setTimeout(r, 10));
	expect(settled).toBe(false);
	finish?.();
	await expect(result).rejects.toBeInstanceOf(AuthenticationError);
	expect(settled).toBe(true);
});
it("a fresh valid scan can succeed after a 401 without saving partial state", async () => {
	const s = await setup();
	await writeFile(join(s.a, "n.md"), "x");
	s.server.put("n.md", "x");
	s.server.hooks.unauthorized = "";
	await expect(s.A.preview()).rejects.toThrow("认证失败");
	s.server.hooks.unauthorized = null;
	expect((await s.A.preview()).rows.find((r) => r.path === "n.md")?.kind).toBe(
		"equal",
	);
	expect(await readdir(s.a)).toEqual(["n.md"]);
});

it.each(["401", "network"])(
	"recovery propagates %s and retries the same pending intent after repair",
	async (failure) => {
		const s = await setup();
		await seed(s);
		await writeFile(join(s.a, "n.md"), "new");
		s.server.hooks.loseResponse = true;
		await expect(sync(s.A)).rejects.toThrow();
		s.server.hooks.loseResponse = false;
		const restart = new PlainEngine(new LocalStore(s.a), s.remote, s.a);
		const before = await restart.journal.load();
		expect(Object.keys(before.pending)).toEqual(["n.md"]);
		const read = s.remote.read.bind(s.remote);
		s.remote.read = async () => {
			throw failure === "401"
				? new AuthenticationError()
				: new Error("network unavailable");
		};
		await expect(restart.recover()).rejects.toThrow(
			failure === "401" ? "认证失败" : "network unavailable",
		);
		expect(await restart.journal.load()).toEqual(before);
		s.remote.read = read;
		await restart.recover();
		expect(Object.keys((await restart.journal.load()).pending)).toEqual([]);
		await restart.recover();
		expect(s.server.files.get("n.md").body.toString()).toBe("new");
	},
);
