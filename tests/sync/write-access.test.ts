import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { excluded } from "@/sync/model";
import { WebDavStore } from "@/sync/webdav";
import {
	grantWriteAccess,
	revokeWriteAccess,
	writeScope,
} from "@/sync/write-access";
import { verifyWriteAccess } from "@/sync/write-probe";
import { setup } from "./helpers";

it("binds session write access to normalized collection and exact credentials, rejects copied grants", () => {
	const options = {
		url: "https://example.test/notes",
		username: "test",
		password: "synthetic",
	};
	const access = grantWriteAccess(writeScope(options));
	const store = new WebDavStore({
		...options,
		url: `${options.url}/`,
		writeAccess: access,
	});
	expect(store.writable).toBe(true);
	for (const patch of [
		{ url: "https://example.test/other/" },
		{ username: "other" },
		{ password: "different" },
	])
		expect(
			new WebDavStore({ ...options, ...patch, writeAccess: access }).writable,
		).toBe(false);
	expect(
		new WebDavStore({ ...options, writeAccess: { ...access } }).writable,
	).toBe(false);
	revokeWriteAccess(access);
	expect(store.writable).toBe(false);
});

it("cannot write with a valid grant outside an acquired collection lock", async () => {
	const s = await setup();
	const options = { url: s.server.url };
	const remote = new WebDavStore({
		...options,
		writeAccess: grantWriteAccess(writeScope(options)),
	});
	await expect(remote.change("new.md", null, null, "test")).rejects.toThrow(
		"独占目录锁",
	);
	expect(s.server.counters.put).toBe(0);
});

it("does not enable a server without locking or touch existing files during verification", async () => {
	const s = await setup();
	s.server.put("untouched.md", "sentinel");
	await expect(verifyWriteAccess({ url: s.server.url })).rejects.toThrow(
		"WebDAV 写入检测未通过",
	);
	expect(s.server.files.get("untouched.md").body.toString()).toBe("sentinel");
	expect(s.server.counters.put).toBe(0);
	expect(new WebDavStore({ url: s.server.url }).writable).toBe(false);
});

it("cancels before creating test files when the connection changes", async () => {
	const s = await setup();
	await expect(
		verifyWriteAccess({ url: s.server.url }, () => false),
	).rejects.toThrow("连接已改变");
	expect([...s.server.dirs]).toEqual([""]);
});

it("excludes retained verification directories on both sides at every nesting level", () => {
	expect(excluded(".vault-content-sync-check-test/sample.txt")).toBe(true);
	expect(excluded("nested/.VAULT-CONTENT-SYNC-CHECK-test/sample.txt")).toBe(
		true,
	);
	expect(excluded("my-check-note.md")).toBe(false);
});

it("verifies conditional creation and only creates missing files on either side", async () => {
	const s = await setup();
	const options = { url: s.server.url };
	const { access, checks } = await verifyWriteAccess(
		options,
		undefined,
		"create-only",
	);
	expect(checks).toContain("并发同名新建只有一项成功");
	const remote = new WebDavStore({ ...options, writeAccess: access });
	const engine = new PlainEngine(new LocalStore(s.a), remote, s.a);
	expect(remote.writeMode).toBe("create-only");
	await writeFile(
		join(s.a, "upload.md"),
		"---\nupdated: 2026-01-01\n---\nlocal",
	);
	await writeFile(join(s.a, "conflict.md"), "local conflict");
	await writeFile(join(s.a, "equal.md"), "same");
	s.server.put("download.md", "---\nupdated: 2026-01-01\n---\nremote");
	s.server.put("conflict.md", "remote conflict");
	s.server.put("equal.md", "same");
	const preview = await engine.preview();
	expect(await engine.run(preview)).toEqual({ completed: 2, remaining: 0 });
	expect(await readFile(join(s.a, "download.md"), "utf8")).toBe("remote");
	expect(s.server.files.get("upload.md").body.toString()).toBe("local");
	expect(await readFile(join(s.a, "conflict.md"), "utf8")).toBe(
		"local conflict",
	);
	expect(s.server.files.get("conflict.md").body.toString()).toBe(
		"remote conflict",
	);
	expect(Object.keys((await engine.journal.load()).baseline).sort()).toEqual([
		"download.md",
		"upload.md",
	]);
	const conflict = preview.rows.find((row) => row.kind === "conflict");
	if (!conflict) throw new Error("Missing conflict fixture");
	await expect(engine.resolve(conflict, "local")).rejects.toThrow(
		"full write access",
	);
	const existing = await remote.read("upload.md");
	await remote.exclusive(async () => {
		await expect(
			remote.change("upload.md", existing, join(s.a, "upload.md"), "test"),
		).rejects.toThrow("仅允许新建");
		await expect(
			remote.change("upload.md", existing, null, "test"),
		).rejects.toThrow("仅允许新建");
	});
});

it("keeps a remote file created after the final read and leaves the upload for recovery", async () => {
	const s = await setup();
	const options = { url: s.server.url };
	const remote = new WebDavStore({
		...options,
		writeAccess: grantWriteAccess(writeScope(options), "create-only"),
	});
	const engine = new PlainEngine(new LocalStore(s.a), remote, s.a);
	await writeFile(join(s.a, "n.md"), "planned upload");
	const preview = await engine.preview();
	s.server.hooks.beforeCommit = async () => {
		s.server.put("n.md", "arrived during upload");
	};
	await expect(engine.run(preview)).rejects.toThrow(
		"Remote precondition failed",
	);
	expect(s.server.files.get("n.md").body.toString()).toBe(
		"arrived during upload",
	);
	expect((await engine.recover()).pending["n.md"]?.blocked).toBe(true);
	expect(await readFile(join(s.a, "n.md"), "utf8")).toBe("planned upload");
});
