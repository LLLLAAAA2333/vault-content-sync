import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { absent, syncDir } from "./files";
import { META, type State, safePath } from "./model";

export class Journal {
	readonly dir: string;
	readonly blobs: string;
	constructor(
		root: string,
		readonly identity: string,
	) {
		this.dir = join(root, META);
		this.blobs = join(this.dir, "versions");
	}
	async load(): Promise<State> {
		const st = await absent(this.dir);
		if (!st)
			return {
				format: 2,
				identity: this.identity,
				baseline: Object.create(null),
				pending: Object.create(null),
			};
		if (!st.isDirectory() || st.isSymbolicLink())
			throw new Error("Invalid state directory");
		const files = (await fs.readdir(this.dir))
			.filter((n) => /^\d{12}\.json$/.test(n))
			.sort();
		if (!files.length)
			return {
				format: 2,
				identity: this.identity,
				baseline: Object.create(null),
				pending: Object.create(null),
			};
		const value: State = JSON.parse(
			await fs.readFile(join(this.dir, files.slice(-1)[0]!), "utf8"),
		);
		if (
			value.format !== 2 ||
			value.identity !== this.identity ||
			!value.baseline ||
			!value.pending
		)
			throw new Error(
				"State identity or format mismatch; legacy byte-only checkpoints require explicit migration",
			);
		for (const [path, hash] of Object.entries(value.baseline)) {
			safePath(path);
			if (hash !== null && !/^[a-f0-9]{64}$/.test(hash))
				throw new Error("Corrupt baseline");
		}
		for (const [path, intent] of Object.entries(value.pending)) {
			safePath(path);
			if (
				!intent ||
				intent.path !== path ||
				!["prepared", "remote", "local"].includes(intent.phase) ||
				![intent.local, intent.remote].every(
					(v) =>
						v === null ||
						(v &&
							/^[a-f0-9]{64}$/.test(v.hash) &&
							(v.syncHash === undefined || /^[a-f0-9]{64}$/.test(v.syncHash)) &&
							typeof v.version === "string" &&
							Number.isSafeInteger(v.size) &&
							v.size >= 0),
				) ||
				!/^[a-f0-9-]{36}$/.test(intent.id) ||
				(intent.desired !== null && !/^[a-f0-9]{64}$/.test(intent.desired)) ||
				(intent.localDesired !== null &&
					!/^[a-f0-9]{64}$/.test(intent.localDesired))
			)
				throw new Error("Corrupt intent");
		}
		value.baseline = Object.assign(Object.create(null), value.baseline);
		value.pending = Object.assign(Object.create(null), value.pending);
		return value;
	}
	private async ensure() {
		for (const dir of [this.dir, this.blobs, join(this.dir, "displaced")]) {
			const before = await absent(dir);
			if (before && (!before.isDirectory() || before.isSymbolicLink()))
				throw new Error("Unsafe journal directory");
			if (!before)
				await fs.mkdir(dir).catch((e) => {
					if (e.code !== "EEXIST") throw e;
				});
			const after = await fs.lstat(dir);
			if (!after.isDirectory() || after.isSymbolicLink())
				throw new Error("Unsafe journal directory");
		}
	}

	blob(hash: string) {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid content hash");
		return join(this.blobs, hash);
	}
	async save(state: State) {
		await this.ensure();
		const latest = (await fs.readdir(this.dir))
			.filter((n) => /^\d{12}\.json$/.test(n))
			.sort()
			.slice(-1)[0];
		const next = String(latest ? Number(latest.slice(0, 12)) + 1 : 1).padStart(
			12,
			"0",
		);
		const temp = join(this.dir, `.checkpoint-${randomUUID()}`);
		const h = await fs.open(temp, "wx", 0o600);
		try {
			await h.writeFile(JSON.stringify(state));
			await h.sync();
		} finally {
			await h.close();
		}
		await fs.rename(temp, join(this.dir, `${next}.json`));
		await syncDir(this.dir);
	}
	async locked<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensure();
		const own = `${process.pid}-${randomUUID()}.lock`;
		const lock = join(this.dir, own);
		const h = await fs.open(lock, "wx", 0o600);
		await h.close();
		try {
			for (const name of await fs.readdir(this.dir)) {
				if (name === own || !/^\d+-[a-f0-9-]+\.lock$/.test(name)) continue;
				const pid = Number(name.split("-")[0]);
				try {
					process.kill(pid, 0);
					throw new Error("Another operation holds the journal");
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
				}
			}
			return await fn();
		} finally {
			await fs.unlink(lock);
		}
	}
}
