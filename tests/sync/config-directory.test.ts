import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { parseExcludedFolders } from "@/sync/settings";
import { WebDavStore } from "@/sync/webdav";
import { setup, sync } from "./helpers";

it.each([".custom-config", "settings/obsidian", ".alma", "项目/缓存"])(
	"excludes %s on both sides, including absent paths from an earlier baseline",
	async (configDir) => {
		const s = await setup();
		const local = new LocalStore(s.a, [configDir]);
		const remote = new WebDavStore({
			url: s.server.url,
			isolatedMock: true,
			excludedRoots: [configDir],
		});
		const engine = new PlainEngine(local, remote, s.a);
		const configFile = `${configDir}/plugins/test/data.json`;
		await mkdir(join(s.a, configDir, "plugins/test"), { recursive: true });
		await writeFile(join(s.a, configFile), "local synthetic config");
		s.server.put(configFile, "remote synthetic config");
		await writeFile(join(s.a, `${configDir}-notes.md`), "ordinary note");
		const requests = vi.spyOn(remote, "call");
		const preview = await engine.preview();
		expect(preview.rows.find((r) => r.path === configDir)?.kind).toBe(
			"excluded",
		);
		expect(
			preview.rows.find((r) => r.path === `${configDir}-notes.md`)?.kind,
		).toBe("upload");
		expect(
			requests.mock.calls.some(([path]) => path.startsWith(`${configDir}/`)),
		).toBe(false);
		await engine.run(preview);
		expect(s.server.files.get(configFile).body.toString()).toBe(
			"remote synthetic config",
		);
		expect(await readFile(join(s.a, configFile), "utf8")).toBe(
			"local synthetic config",
		);
		expect(s.server.files.get(`${configDir}-notes.md`).body.toString()).toBe(
			"ordinary note",
		);
		const state = await engine.journal.load();
		state.baseline[`${configDir}/missing.json`] =
			state.baseline[`${configDir}-notes.md`]!;
		await engine.journal.save(state);
		expect(
			(await engine.preview()).rows.find(
				(r) => r.path === `${configDir}/missing.json`,
			)?.kind,
		).toBe("excluded");
		const before = s.server.counters.put;
		await sync(engine);
		expect(s.server.counters.put).toBe(before);
	},
);

it.each(["/", "/absolute", "C:\\absolute", "../elsewhere", "a/../b", "a//b"])(
	"rejects invalid folder exclusion %s",
	(path) => {
		expect(() => parseExcludedFolders(path)).toThrow("Unsafe relative path");
	},
);

it("keeps excluded pending changes intact while syncing other paths", async () => {
	const s = await setup();
	const hidden = ".alma/state.md";
	await mkdir(join(s.a, ".alma"));
	await writeFile(join(s.a, hidden), "agent data");
	s.server.hooks.beforeCommit = async () => {
		throw new Error("interrupted");
	};
	await expect(sync(s.A)).rejects.toThrow();
	const { pending } = await s.A.journal.load();
	expect(pending[hidden]).toBeDefined();
	s.server.hooks.beforeCommit = null;
	await writeFile(join(s.a, "note.md"), "note content");
	const before = await s.A.preview();
	const excludedRoots = parseExcludedFolders(" .alma/\r\n 项目\\缓存\n.ALMA ");
	expect(excludedRoots).toEqual([".alma", "项目/缓存"]);
	const remote = new WebDavStore({
		url: s.server.url,
		isolatedMock: true,
		excludedRoots,
	});
	const engine = new PlainEngine(
		new LocalStore(s.a, excludedRoots),
		remote,
		s.a,
	);
	const requests = vi.spyOn(remote, "call");
	await engine.recover();
	const conflict = before.rows.find((row) => row.path === hidden);
	assert(conflict?.kind === "conflict");
	await expect(engine.inspect(conflict)).rejects.toThrow("excluded");
	await expect(engine.resolve(conflict, "local")).rejects.toThrow("Excluded");
	await engine.run(before);
	expect((await engine.journal.load()).pending).toEqual(pending);
	expect(s.server.files.get("note.md").body.toString()).toBe("note content");
	expect(s.server.files.has(hidden)).toBe(false);
	expect(requests.mock.calls.every(([path]) => !path.startsWith(".alma"))).toBe(
		true,
	);
	await s.A.recover();
	expect((await s.A.journal.load()).pending).toEqual({});
	expect(s.server.files.get(hidden).body.toString()).toBe("agent data");
});

it("blocks direct reads, conflict inspection and mutations of excluded configuration before I/O", async () => {
	const s = await setup();
	const configDir = ".custom-config",
		path = `${configDir}/data.json`;
	const local = new LocalStore(s.a, [configDir]);
	const remote = new WebDavStore({
		url: s.server.url,
		isolatedMock: true,
		excludedRoots: [configDir],
	});
	const requests = vi.spyOn(remote, "call");
	for (const store of [local, remote]) {
		await expect(store.read(path)).rejects.toThrow("Excluded");
		await expect(
			store.text(path, { hash: "synthetic", size: 1, version: "synthetic" }),
		).rejects.toThrow("Excluded");
		await expect(store.change(path, null, null, "unused")).rejects.toThrow(
			"Excluded",
		);
	}
	expect(
		requests.mock.calls.filter(([, method]) =>
			["PUT", "DELETE"].includes(method),
		),
	).toHaveLength(0);
	expect(s.server.counters.get).toBe(0);
});

it("refuses unsafe configuration roots instead of weakening exclusions", async () => {
	const s = await setup();
	for (const name of ["", "../outside", "/absolute", "settings/../outside"]) {
		expect(() => new LocalStore(s.a, [name])).toThrow("Unsafe");
		expect(
			() => new WebDavStore({ url: s.server.url, excludedRoots: [name] }),
		).toThrow("Unsafe");
	}
});

it("excludes the previous sync client's trash on both sides and in old baselines", async () => {
	const s = await setup();
	await mkdir(join(s.a, ".sync_trash"));
	await writeFile(join(s.a, ".sync_trash/local.md"), "discarded");
	s.server.dirs.add(".sync_trash");
	s.server.put(".sync_trash/remote.md", "discarded");
	const state = await s.A.journal.load();
	state.baseline[".sync_trash/prior.md"] = "a".repeat(64);
	await s.A.journal.save(state);
	const plan = await s.A.preview();
	expect(plan.rows.find((r) => r.path === ".sync_trash/prior.md")?.kind).toBe(
		"excluded",
	);
	expect(plan.writes).toBe(0);
	expect(plan.readBytes).toBe(0);
	expect(s.server.counters.get).toBe(0);
});
