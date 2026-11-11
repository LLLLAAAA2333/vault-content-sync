import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { mergeText } from "@/merge";
import { sharedText } from "./content";
import { digest, hashFile, textFile } from "./files";
import { localVersion } from "./local-version";
import {
	hashOf,
	type Intent,
	type Preview,
	plan,
	type Row,
	type Seen,
	type State,
	type Store,
	scan,
} from "./model";
import { Journal } from "./state";

export class PlainEngine {
	readonly journal: Journal;
	constructor(
		readonly local: Store,
		readonly remote: Store,
		root: string,
	) {
		this.journal = new Journal(root, `${local.identity}|${remote.identity}`);
	}
	private requireWriteMode() {
		if (!this.remote.writable)
			throw new Error("Write capability unknown; this connection is read-only");
	}

	async preview(): Promise<Preview> {
		const state = await this.journal.load();
		const l = await scan(this.local),
			r = await scan(this.remote);
		return plan(state, l, r);
	}
	async run(
		preview: Preview,
	): Promise<{ completed: number; remaining: number }> {
		this.requireWriteMode();
		return this.journal.locked(async () => {
			const state = await this.journal.load();
			let completed = 0;
			if (
				Object.keys(preview.local.errors).length ||
				Object.keys(preview.remote.errors).length
			)
				throw new Error("Incomplete preview; no mutations allowed");
			await this.recoverState(state);
			const refreshed = new Map(
				plan(state, preview.local, preview.remote).rows.map((r) => [r.path, r]),
			);
			for (const row of preview.rows) {
				if (
					["unknown", "excluded", "conflict"].includes(row.kind) ||
					state.pending[row.path]
				)
					continue;
				// A verified unchanged agreement needs no new snapshot or checkpoint.
				if (
					row.kind === "equal" &&
					state.baseline[row.path] === hashOf(row.local)
				)
					continue;
				// A different process may have advanced the baseline since this preview.
				const current = refreshed.get(row.path);
				if (!current || current.kind !== row.kind)
					throw new Error("Plan changed; preview again");
				await this.start(
					state,
					row,
					row.kind === "upload" || row.kind === "delete-remote"
						? hashOf(row.local)
						: hashOf(row.remote),
				);
				completed++;
			}
			return { completed, remaining: Object.keys(state.pending).length };
		});
	}
	async recover() {
		this.requireWriteMode();
		return this.journal.locked(async () => {
			const state = await this.journal.load();
			await this.recoverState(state);
			return state;
		});
	}
	private async recoverState(state: State) {
		for (const intent of Object.values(state.pending)) {
			if (intent.blocked) continue;
			try {
				await this.finish(state, intent, true);
			} catch {
				intent.blocked = true;
				await this.journal.save(state);
			}
		}
	}
	private async verified(
		store: Store,
		path: string,
		expected: Seen,
	): Promise<Seen> {
		const actual = await store.read(path, this.journal.blobs);
		if ((actual?.hash ?? null) !== (expected?.hash ?? null))
			throw new Error("Content changed after preview; compare again");
		return actual;
	}
	private async start(state: State, row: Row, desired: string | null) {
		const l = await this.verified(this.local, row.path, row.local);
		const r = await this.verified(this.remote, row.path, row.remote);
		if (desired !== hashOf(r) && !this.remote.writable)
			throw new Error("Remote writes disabled: capability unknown");
		if (desired === hashOf(l) && desired === hashOf(r)) {
			if (state.baseline[row.path] !== desired) {
				state.baseline[row.path] = desired;
				await this.journal.save(state);
			}
			return;
		}
		if (
			desired &&
			(await hashFile(this.journal.blob(desired)))?.hash !== desired
		)
			throw new Error("Missing durable target version");
		const intent: Intent = {
			id: randomUUID(),
			path: row.path,
			local: l,
			remote: r,
			desired,
			localDesired: await localVersion(this.journal, row.path, desired, l),
			phase: "prepared",
		};
		state.pending[row.path] = intent;
		await this.journal.save(state);
		await this.finish(state, intent, false);
	}
	private async finish(state: State, intent: Intent, recovery: boolean) {
		const source = intent.desired ? this.journal.blob(intent.desired) : null;
		const localSource = intent.localDesired
			? this.journal.blob(intent.localDesired)
			: null;
		if (
			localSource &&
			(await hashFile(localSource))?.hash !== intent.localDesired
		)
			throw new Error("Local target version corrupt or missing");
		if (source && (await hashFile(source))?.hash !== intent.desired)
			throw new Error("Target version corrupt or missing");
		// Re-read both sides before any resumed mutation. An unexpected edit freezes the intent.
		const l = await this.local.read(intent.path),
			r = await this.remote.read(intent.path);
		const parked = recovery && !l ? await this.local.parked?.(intent.id) : null;
		if (
			(intent.phase !== "prepared" && hashOf(r) !== intent.desired) ||
			(intent.phase === "local" && hashOf(l) !== intent.desired)
		)
			throw new Error("Previously confirmed result was edited");
		if (
			recovery &&
			r &&
			intent.remote &&
			hashOf(r) !== intent.desired &&
			r.version !== intent.remote.version
		)
			throw new Error("Remote version changed after interruption");
		const allowed = (now: Seen, before: Seen) =>
			hashOf(now) === hashOf(before) || hashOf(now) === intent.desired;
		if (
			(!allowed(l, intent.local) &&
				!(parked && intent.local && parked.hash === intent.local.hash)) ||
			!allowed(r, intent.remote)
		)
			throw new Error("Interrupted operation conflicts with a newer edit");
		if (hashOf(r) !== intent.desired) {
			await this.remote.change(intent.path, r, source, intent.id);
			if (hashOf(await this.remote.read(intent.path)) !== intent.desired)
				throw new Error("Remote result unconfirmed");
		}
		intent.phase = "remote";
		await this.journal.save(state);
		// The local source may have changed while uploading. Keep the intent, do not overwrite it.
		const local = await this.local.read(intent.path);
		if (hashOf(local) !== intent.desired) {
			if (
				hashOf(local) !== hashOf(intent.local) &&
				!(recovery && !local && parked?.hash === intent.local?.hash)
			)
				throw new Error("Local changed during transfer");
			await this.local.change(
				intent.path,
				intent.local,
				localSource,
				intent.id,
			);
		}
		intent.phase = "local";
		await this.journal.save(state);
		if (
			hashOf(await this.local.read(intent.path)) !== intent.desired ||
			hashOf(await this.remote.read(intent.path)) !== intent.desired
		)
			throw new Error("Final agreement unconfirmed");
		state.baseline[intent.path] = intent.desired;
		delete state.pending[intent.path];
		await this.journal.save(state);
	}
	async inspect(row: Row) {
		if (["excluded", "unknown"].includes(row.kind))
			throw new Error("Cannot inspect an unknown or excluded path");
		const l = await this.local.read(row.path),
			r = await this.remote.read(row.path);
		if (
			(l?.hash ?? null) !== (row.local?.hash ?? null) ||
			(r?.hash ?? null) !== (row.remote?.hash ?? null)
		)
			throw new Error("Content changed after preview");
		const state = await this.journal.load();
		const base = state.baseline[row.path];
		const baseSeen = base ? await hashFile(this.journal.blob(base)) : null;
		if (base && baseSeen?.hash !== base)
			throw new Error("Baseline content missing or corrupt");
		return {
			local: sharedText(row.path, await this.local.text(row.path, l)),
			remote: sharedText(row.path, await this.remote.text(row.path, r)),
			base: baseSeen
				? await textFile(this.journal.blob(baseSeen.hash), baseSeen)
				: null,
		};
	}

	async resolve(row: Row, choice: "local" | "remote" | "merge") {
		this.requireWriteMode();
		if (
			row.kind !== "conflict" ||
			(row.reason && row.reason !== "Unfinished operation requires recovery")
		)
			throw new Error("This conflict requires a new scan or path repair");
		return this.journal.locked(async () => {
			const state = await this.journal.load();
			await this.verified(this.local, row.path, row.local);
			await this.verified(this.remote, row.path, row.remote);
			let desired = hashOf(choice === "remote" ? row.remote : row.local);
			if (choice === "merge") {
				const base = state.baseline[row.path];
				if (
					!base ||
					!row.local ||
					!row.remote ||
					!/\.md$/i.test(row.path) ||
					/\.excalidraw\.md$/i.test(row.path)
				)
					throw new Error(
						"Merge requires ordinary Markdown and a shared text baseline",
					);
				const hashes = [base, hashOf(row.local)!, hashOf(row.remote)!];
				const texts: string[] = [];
				for (const hash of hashes) {
					const path = this.journal.blob(hash);
					if ((await fs.stat(path)).size > 1024 * 1024)
						throw new Error("Text exceeds merge budget");
					const bytes = await fs.readFile(path);
					if (bytes.includes(0)) throw new Error("Binary content cannot merge");
					if (createHash("sha256").update(bytes).digest("hex") !== hash)
						throw new Error("Merge version corrupt");
					texts.push(
						new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
							bytes,
						),
					);
				}
				const merged = mergeText(texts[0]!, texts[1]!, texts[2]!);
				if (merged.status === "stopped")
					throw new Error(
						`Automatic merge stopped: ${merged.reason}; choose a side or edit manually`,
					);
				if (merged.status === "conflict") {
					const ranges = merged.regions
						.map(({ base }) => `[${base.start}, ${base.end})`)
						.join(", ");
					throw new Error(
						`Overlapping text edits at base line ranges ${ranges} (zero-based); choose a side or edit manually`,
					);
				}
				desired = (
					await digest(
						Readable.from([Buffer.from(merged.text)]),
						this.journal.blobs,
					)
				).hash;
			}
			// Explicit resolution retires only this path's blocked intent; its versions/checkpoints remain.
			delete state.pending[row.path];
			await this.journal.save(state);
			await this.start(state, row, desired);
		});
	}
}
