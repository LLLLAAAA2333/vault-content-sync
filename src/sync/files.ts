import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { isMarkdown, MarkdownProjection } from "./content";
import {
	excluded,
	type Listing,
	META,
	type Seen,
	type Store,
	safePath,
} from "./model";

export async function absent(path: string) {
	try {
		return await fs.lstat(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}
export async function syncDir(path: string) {
	const h = await fs.open(path, "r");
	try {
		await h.sync();
	} finally {
		await h.close();
	}
}
export async function digest(
	stream: Readable,
	archive?: string,
	path = "",
): Promise<{ hash: string; size: number; syncHash?: string }> {
	const raw = createHash("sha256"),
		shared = createHash("sha256");
	const projection = isMarkdown(path) ? new MarkdownProjection() : null;
	let size = 0;
	const captures: {
		temp: string;
		handle: Awaited<ReturnType<typeof fs.open>>;
	}[] = [];
	try {
		if (archive) {
			await fs.mkdir(archive, { recursive: true });
			for (let i = 0; i < (projection ? 2 : 1); i++) {
				const temp = join(archive, `.capture-${randomUUID()}`);
				captures.push({ temp, handle: await fs.open(temp, "wx", 0o600) });
			}
		}
		for await (const chunk of stream) {
			const bytes = Buffer.from(chunk);
			raw.update(bytes);
			size += bytes.length;
			await captures[0]?.handle.writeFile(bytes);
			if (projection) {
				const value = projection.push(bytes);
				shared.update(value);
				await captures[1]?.handle.writeFile(value);
			}
		}
		if (projection) {
			const tail = projection.push(Buffer.alloc(0), true);
			shared.update(tail);
			await captures[1]?.handle.writeFile(tail);
		}
		const hash = raw.digest("hex"),
			syncHash = projection ? shared.digest("hex") : undefined;
		for (const [i, capture] of captures.entries()) {
			await capture.handle.sync();
			const version = i === 0 ? hash : syncHash!;
			await fs.link(capture.temp, join(archive!, version)).catch(async (e) => {
				if (e.code !== "EEXIST") throw e;
				if ((await hashFile(join(archive!, version)))?.hash !== version)
					throw new Error("Existing recovery version is corrupt");
			});
		}
		if (archive) await syncDir(archive);
		return { hash, size, ...(syncHash ? { syncHash } : {}) };
	} finally {
		for (const capture of captures) {
			await capture.handle.close();
			await fs.unlink(capture.temp).catch(() => undefined);
		}
	}
}
export async function hashFile(
	path: string,
	archive?: string,
	logicalPath = "",
): Promise<Seen> {
	const h = await fs
		.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
		.catch((e) => {
			if (e.code === "ENOENT") return null;
			throw e;
		});
	if (!h) return null;
	try {
		const before = await h.stat();
		if (!before.isFile()) throw new Error("Not a regular file");
		const value = await digest(
			h.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }),
			archive,
			logicalPath,
		);
		const after = await h.stat();
		if (
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			value.size !== after.size
		)
			throw new Error("File changed during read");
		return { ...value, version: `${after.dev}:${after.ino}:${after.ctimeMs}` };
	} finally {
		await h.close();
	}
}
export async function smallText(
	stream: Readable,
	expected: Seen,
): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		size += chunk.length;
		if (size > 1024 * 1024) return null;
		chunks.push(Buffer.from(chunk));
	}
	const bytes = Buffer.concat(chunks);
	if (createHash("sha256").update(bytes).digest("hex") !== expected?.hash)
		throw new Error("Content changed after preview");
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return null;
	}
}
export async function textFile(
	path: string,
	expected: Seen,
): Promise<string | null> {
	if (!expected || expected.size > 1024 * 1024) return null;
	const h = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await smallText(
			h.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }),
			expected,
		);
	} finally {
		await h.close();
	}
}
export class LocalStore implements Store {
	identity: string;
	writable = true;
	constructor(readonly root: string) {
		this.root = resolve(root);
		this.identity = `local:${this.root}`;
	}
	async path(path: string, parents = false) {
		safePath(path);
		const parts = path.split("/");
		if (
			process.platform === "win32" &&
			parts.some(
				(p) =>
					/[<>:"|?*]/.test(p) ||
					/[. ]$/.test(p) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
			)
		)
			throw new Error("Unsupported Windows path");
		for (let i = 0; i < parts.length; i++) {
			const current = join(this.root, ...parts.slice(0, i + 1));
			let st = await absent(current);
			if (!st && parents && i < parts.length - 1) {
				await fs.mkdir(current).catch(async (e) => {
					if (e.code !== "EEXIST") throw e;
				});
				st = await fs.lstat(current);
			}
			if (
				st?.isSymbolicLink() ||
				(st && i < parts.length - 1 && !st.isDirectory())
			)
				throw new Error("Symlink or non-directory ancestor refused");
		}
		const result = resolve(this.root, path);
		if (!result.startsWith(this.root + sep))
			throw new Error("Path escapes root");
		return result;
	}
	async list(): Promise<Listing> {
		const rootStat = await fs.lstat(this.root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
			throw new Error("Invalid local root");
		const result: Listing = { files: [], excluded: [], folders: [] };
		const walk = async (dir: string): Promise<void> => {
			for (const item of await fs.readdir(
				dir ? await this.path(dir) : this.root,
				{ withFileTypes: true },
			)) {
				const p = dir ? `${dir}/${item.name}` : item.name;
				if (excluded(p) || item.isSymbolicLink()) {
					result.excluded.push(p);
					continue;
				}
				safePath(p);
				if (item.isDirectory()) {
					result.folders.push(p);
					await walk(p);
				} else if (item.isFile()) result.files.push(p);
				else throw new Error("Unsupported filesystem object");
			}
		};
		await walk("");
		return result;
	}
	async read(path: string, archive?: string) {
		return hashFile(await this.path(path), archive, path);
	}
	async text(path: string, expected: Seen) {
		return textFile(await this.path(path), expected);
	}
	async parked(id: string) {
		return hashFile(await this.path(`${META}/displaced/${safePath(id)}`));
	}
	async change(
		path: string,
		expected: Seen,
		source: string | null,
		id: string,
	) {
		if (excluded(path)) throw new Error("Excluded target");
		const target = await this.path(path, true);
		const displaced = await this.path(
			`${META}/displaced/${safePath(id)}`,
			true,
		);
		const parked = await hashFile(displaced);
		const now = await hashFile(target);
		if (parked) {
			if (parked.hash !== expected?.hash || now)
				throw new Error("Recovery target changed; preserved displaced version");
		} else {
			if ((now?.hash ?? null) !== (expected?.hash ?? null))
				throw new Error("Local precondition failed");
			if (expected) {
				await fs.rename(target, displaced);
				await syncDir(dirname(target));
				await syncDir(dirname(displaced));
				if ((await hashFile(displaced))?.hash !== expected.hash) {
					await fs.link(displaced, target).catch(() => undefined);
					throw new Error(
						"Local edit raced with write; preserved displaced version",
					);
				}
			}
		}
		if (source) {
			// Publish a new inode exclusively. Existing names, including newly created files, are never replaced.
			const stage = `${displaced}.new-${randomUUID()}`;
			await fs.copyFile(source, stage, constants.COPYFILE_EXCL);
			const h = await fs.open(stage, "r");
			try {
				await h.sync();
			} finally {
				await h.close();
			}
			await fs.link(stage, target);
			await fs.unlink(stage);
		}
		await syncDir(dirname(target));
	}
}
