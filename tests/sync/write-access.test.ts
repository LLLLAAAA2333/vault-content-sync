import { expect, it } from "vitest";
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
		"写入验证未通过",
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
