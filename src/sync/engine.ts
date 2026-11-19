import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { mergeText } from "@/merge";
import { isMarkdown, sharedText } from "./content";
import { digest, hashFile, textFile } from "./files";
import { localVersion } from "./local-version";
import {
	hashOf,
	type Intent,
	isCreation,
	type Preview,
	plan,
	type Row,
	type Scan,
	type ScanProgress,
	type Seen,
	type State,
	type Store,
	scan,
} from "./model";
import { RecoveryConflict } from "./recovery-conflict";
import { Journal } from "./state";
import { dictionary } from "./validation";
import { VerificationCache, type VerificationMode } from "./verification-cache";

export type ConflictChoice = "local" | "remote" | "merge" | { text: string };

export class PlainEngine {
	readonly journal: Journal;
	constructor(
		readonly local: Store,
		readonly remote: Store,
		root: string,
		private readonly verificationCache = new VerificationCache(),
	) {
		this.journal = new Journal(root, `${local.identity}|${remote.identity}`);
	}
	private requireWriteMode() {
		if (!this.remote.writable)
			throw new Error("Write capability unknown; this connection is read-only");
	}
	private writing<T>(task: () => Promise<T>) {
		this.requireWriteMode();
		return this.journal.locked(() =>
			this.remote.exclusive ? this.remote.exclusive(task) : task(),
		);
	}

	async preview(
		onProgress?: (
			progress: ScanProgress & { side: "local" | "remote" },
		) => void,
		mode: VerificationMode = "full",
	): Promise<Preview> {
		const scope = JSON.stringify([
			this.local.identity,
			this.remote.identity,
			this.local.excludedRoots ?? [],
			this.remote.excludedRoots ?? [],
		]);
		const ticket = this.verificationCache.begin(scope, mode);
		try {
			const state = await this.journal.load();
			const l = await scan(
				this.local,
				(progress) => onProgress?.({ ...progress, side: "local" }),
				ticket.previous?.local,
			);
			const r = await scan(
				this.remote,
				(progress) => onProgress?.({ ...progress, side: "remote" }),
				ticket.previous?.remote,
			);
			const result = { ...plan(state, l, r), verificationMode: mode };
			this.verificationCache.finish(ticket.generation, l, r);
			return result;
		} catch (error) {
			this.verificationCache.finish(ticket.generation);
			throw error;
		}
	}
	async refreshPaths(
		preview: Preview,
		paths: readonly string[],
	): Promise<Preview> {
		const refresh = async (store: Store, previous: Scan): Promise<Scan> => {
			const files = Object.assign(dictionary<Seen>(), previous.files);
			for (const path of paths) {
				const seen = await store.read(path);
				if (seen) files[path] = seen;
				else delete files[path];
			}
			return { ...previous, files };
		};
		const [local, remote] = await Promise.all([
			refresh(this.local, preview.local),
			refresh(this.remote, preview.remote),
		]);
		return plan(await this.journal.load(), local, remote);
	}
	async run(
		preview: Preview,
	): Promise<{ completed: number; remaining: number }> {
		this.requireWriteMode();
		return this.writing(async () => {
			const state = await this.journal.load();
			let completed = 0;
			if (
				Object.keys(preview.local.errors).length ||
				Object.keys(preview.remote.errors).length
			)
				throw new Error("Incomplete preview; no mutations allowed");
			// Recovery is a separate, explicit operation; a selected-file plan must not resume other paths.
			const refreshed = new Map(
				plan(state, preview.local, preview.remote).rows.map((r) => [r.path, r]),
			);
			for (const row of preview.rows) {
				if (
					["unknown", "excluded", "conflict"].includes(row.kind) ||
					(this.remote.writeMode === "create-only" && !isCreation(row)) ||
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
	async recover(confirmed?: ReadonlyMap<string, string>) {
		this.requireWriteMode();
		return this.writing(async () => {
			const state = await this.journal.load();
			await this.recoverState(state, confirmed);
			return state;
		});
	}
	private async recoverState(
		state: State,
		confirmed?: ReadonlyMap<string, string>,
	) {
		for (const intent of Object.values(state.pending)) {
			if (
				intent.blocked ||
				(this.remote.writeMode === "create-only" &&
					!this.createsFile(intent)) ||
				(confirmed && confirmed.get(intent.path) !== intent.id)
			)
				continue;
			try {
				await this.finish(state, intent, true);
			} catch (error) {
				if (!(error instanceof RecoveryConflict)) throw error;
				intent.blocked = true;
				await this.journal.save(state);
			}
		}
	}
	async recordCompletedCommit(path: string): Promise<boolean> {
		if ((await this.journal.load()).pending[path]?.phase !== "local")
			return false;
		return this.journal.locked(async () => {
			const state = await this.journal.load();
			const intent = state.pending[path];
			if (intent?.phase !== "local") return false;
			const [local, remote] = await Promise.all([
				this.local.read(path),
				this.remote.read(path),
			]);
			if (hashOf(local) !== intent.desired || hashOf(remote) !== intent.desired)
				return false;
			await this.recordAgreement(state, intent);
			return true;
		});
	}
	private async recordAgreement(state: State, intent: Intent) {
		state.baseline[intent.path] = intent.desired;
		delete state.pending[intent.path];
		await this.journal.save(state);
	}
	private matchesReview(
		store: Store,
		path: string,
		current: Seen,
		reviewed: Seen,
	) {
		return (
			(current?.hash ?? null) === (reviewed?.hash ?? null) ||
			(store === this.local &&
				isMarkdown(path) &&
				hashOf(current) === hashOf(reviewed))
		);
	}
	private async verified(
		store: Store,
		path: string,
		expected: Seen,
		conflictReview = false,
	): Promise<Seen> {
		const actual = await store.read(path, this.journal.blobs);
		if (
			conflictReview
				? !this.matchesReview(store, path, actual, expected)
				: (actual?.hash ?? null) !== (expected?.hash ?? null)
		)
			throw new Error("Content changed after preview; compare again");
		return actual;
	}
	private async start(
		state: State,
		row: Row,
		desired: string | null,
		captured?: { local: Seen; remote: Seen },
	) {
		this.requireWriteMode();
		this.remote.checkWriteLease?.();
		const l = captured
			? captured.local
			: await this.verified(this.local, row.path, row.local);
		const r = captured
			? captured.remote
			: await this.verified(this.remote, row.path, row.remote);
		if (desired !== hashOf(r) && !this.remote.writable)
			throw new Error("Remote writes disabled: capability unknown");
		if (desired === hashOf(l) && desired === hashOf(r)) {
			this.remote.checkWriteLease?.();
			if (state.baseline[row.path] !== desired || state.pending[row.path]) {
				delete state.pending[row.path];
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
	private createsFile(intent: Intent): boolean {
		const { desired, local, remote, localDesired } = intent;
		return (
			desired !== null &&
			((local === null &&
				hashOf(remote) === desired &&
				localDesired === desired) ||
				(remote === null &&
					hashOf(local) === desired &&
					localDesired === local?.hash))
		);
	}
	private async finish(state: State, intent: Intent, recovery: boolean) {
		this.requireWriteMode();
		this.remote.checkWriteLease?.();
		const source = intent.desired ? this.journal.blob(intent.desired) : null;
		const localSource = intent.localDesired
			? this.journal.blob(intent.localDesired)
			: null;
		if (
			localSource &&
			(await hashFile(localSource))?.hash !== intent.localDesired
		)
			throw new RecoveryConflict("Local target version corrupt or missing");
		if (source && (await hashFile(source))?.hash !== intent.desired)
			throw new RecoveryConflict("Target version corrupt or missing");
		// Re-read both sides before any resumed mutation. An unexpected edit freezes the intent.
		const l = await this.local.read(intent.path),
			r = await this.remote.read(intent.path);
		const creationOnly = this.remote.writeMode === "create-only";
		if (
			creationOnly &&
			(!this.createsFile(intent) ||
				(intent.local
					? l?.hash !== intent.local.hash
					: l && l.hash !== intent.localDesired) ||
				(intent.remote
					? r?.hash !== intent.remote.hash
					: r && r.hash !== intent.desired))
		)
			throw new RecoveryConflict(
				"Source changed or operation requires full write access",
			);
		const parked =
			recovery && !creationOnly && !l
				? await this.local.parked?.(intent.id)
				: null;
		if (
			(intent.phase !== "prepared" && hashOf(r) !== intent.desired) ||
			(intent.phase === "local" && hashOf(l) !== intent.desired)
		)
			throw new RecoveryConflict("Previously confirmed result was edited");
		if (
			recovery &&
			r &&
			intent.remote &&
			hashOf(r) !== intent.desired &&
			r.version !== intent.remote.version &&
			!(
				r.hash === intent.remote.hash &&
				intent.remote.version.startsWith("W/") &&
				r.version === intent.remote.version.slice(2)
			)
		)
			throw new RecoveryConflict("Remote version changed after interruption");
		const allowed = (now: Seen, before: Seen) =>
			hashOf(now) === hashOf(before) || hashOf(now) === intent.desired;
		if (
			(!allowed(l, intent.local) &&
				!(parked && intent.local && parked.hash === intent.local.hash)) ||
			!allowed(r, intent.remote)
		)
			throw new RecoveryConflict(
				"Interrupted operation conflicts with a newer edit",
			);
		if (hashOf(r) !== intent.desired) {
			await this.remote.change(intent.path, r, source, intent.id);
			if (hashOf(await this.remote.read(intent.path)) !== intent.desired)
				throw new RecoveryConflict("Remote result unconfirmed");
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
				throw new RecoveryConflict("Local changed during transfer");
			if (creationOnly && (local || intent.local || !localSource))
				throw new RecoveryConflict(
					"Create-only synchronization cannot replace the local file",
				);
			this.requireWriteMode();
			this.remote.checkWriteLease?.();
			await this.local.change(
				intent.path,
				intent.local,
				localSource,
				intent.id,
			);
		}
		intent.phase = "local";
		await this.journal.save(state);
		const finalLocal = await this.confirmLocalResult(intent, creationOnly);
		const finalRemote = await this.remote.read(intent.path);
		if (
			hashOf(finalLocal) !== intent.desired ||
			hashOf(finalRemote) !== intent.desired ||
			(creationOnly &&
				(finalLocal?.hash !== intent.localDesired ||
					finalRemote?.hash !== (intent.remote?.hash ?? intent.desired)))
		)
			throw new RecoveryConflict("Final agreement unconfirmed");
		this.remote.checkWriteLease?.();
		await this.recordAgreement(state, intent);
	}
	private async confirmLocalResult(
		intent: Intent,
		creationOnly: boolean,
	): Promise<Seen> {
		// Obsidian can update local metadata after publishing the replacement file.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const current = await this.local.read(intent.path);
				if (creationOnly || hashOf(current) === intent.desired || attempt === 2)
					return current;
			} catch (error) {
				if (
					attempt === 2 ||
					!(error instanceof Error) ||
					error.message !== "File changed during read"
				)
					throw error;
			}
			await delay(120);
		}
		return null;
	}
	async inspect(row: Row) {
		if (["excluded", "unknown"].includes(row.kind))
			throw new Error("Cannot inspect an unknown or excluded path");
		const l = await this.local.read(row.path),
			r = await this.remote.read(row.path);
		if (
			!this.matchesReview(this.local, row.path, l, row.local) ||
			!this.matchesReview(this.remote, row.path, r, row.remote)
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

	async resolve(row: Row, choice: ConflictChoice) {
		this.requireWriteMode();
		if (this.remote.writeMode === "create-only")
			throw new Error("Conflict resolution requires full write access");
		if (
			row.kind !== "conflict" ||
			(row.reason && row.reason !== "Unfinished operation requires recovery")
		)
			throw new Error("This conflict requires a new scan or path repair");
		return this.writing(async () => {
			const state = await this.journal.load();
			const local = await this.verified(this.local, row.path, row.local, true);
			const remote = await this.verified(
				this.remote,
				row.path,
				row.remote,
				true,
			);
			let desired = hashOf(choice === "remote" ? row.remote : row.local);
			if (typeof choice === "object") {
				if (
					!isMarkdown(row.path) ||
					/\.excalidraw\.md$/i.test(row.path) ||
					!row.local ||
					!row.remote ||
					choice.text.includes("\0") ||
					Buffer.byteLength(choice.text) > 1024 * 1024
				)
					throw new Error("合并结果需为 1 MiB 以内的 Markdown 文本。");
				const text = sharedText(row.path, choice.text) ?? "";
				desired = (
					await digest(Readable.from([Buffer.from(text)]), this.journal.blobs)
				).hash;
			}
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
			// Replace any prior pending operation only when the new intent is saved.
			await this.start(state, row, desired, { local, remote });
		});
	}
}
