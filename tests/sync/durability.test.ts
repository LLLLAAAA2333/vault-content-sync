import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./helpers";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, open: vi.fn(original.open) };
});

afterEach(() => vi.mocked(fs.open).mockReset());

async function failFlush(code: string, directory: boolean) {
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	const failed = vi.fn(async () => {
		throw Object.assign(new Error(`${code}: operation failed, fsync`), {
			code,
			syscall: "fsync",
		});
	});
	vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
		const handle = await original.open(path, flags, mode);
		if ((await handle.stat()).isDirectory() === directory) handle.sync = failed;
		return handle;
	});
	return failed;
}

async function conflictingFile() {
	const s = await setup();
	const path = "conflict.md";
	await fs.writeFile(join(s.a, path), "local content");
	s.server.put(path, "remote content");
	const row = (await s.A.preview()).rows.find((item) => item.path === path);
	assert(row?.kind === "conflict" && row.local && row.remote);
	return { s, path, row, local: row.local, remote: row.remote };
}

it.runIf(process.platform !== "win32").each(["EPERM", "EINVAL", "ENOTSUP"])(
	"commits the whole local version despite %s from directory fsync",
	async (code) => {
		const { s, path, row, local, remote } = await conflictingFile();
		const flush = await failFlush(code, true);
		await s.A.resolve(row, "local");
		expect(flush).toHaveBeenCalled();
		expect(await fs.readFile(join(s.a, path), "utf8")).toBe("local content");
		expect(s.server.files.get(path).body.toString()).toBe("local content");
		expect(await fs.readFile(s.A.journal.blob(remote.hash), "utf8")).toBe(
			"remote content",
		);
		const state = await s.A.journal.load();
		expect(state.baseline[path]).toBe(local.hash);
		expect(state.pending).toEqual({});
	},
);

it.each([
	{ code: "EPERM", directory: false },
	{ code: "EIO", directory: true },
])("stops on $code with directory=$directory", async ({ code, directory }) => {
	if (directory && process.platform === "win32") return;
	const { s, path, row } = await conflictingFile();
	await failFlush(code, directory);
	await expect(s.A.resolve(row, "local")).rejects.toThrow(`${code}:`);
	expect(s.server.counters.put).toBe(0);
	expect(s.server.files.get(path).body.toString()).toBe("remote content");
	expect(await fs.readFile(join(s.a, path), "utf8")).toBe("local content");
});
