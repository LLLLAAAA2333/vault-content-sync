import type { Scan, Seen } from "./model";
import { dictionary } from "./validation";

export type VerificationMode = "incremental" | "full";
type Snapshot = { local: Record<string, Seen>; remote: Record<string, Seen> };

/** Session-only digests, never file bodies or persistent synchronization state. */
export class VerificationCache {
	private generation = 0;
	private scope = "";
	private snapshot?: Snapshot;
	constructor(
		private readonly maxEntries = 20_000,
		private readonly maxBytes = 16 * 1024 * 1024,
	) {}
	clear() {
		this.generation++;
		this.snapshot = undefined;
		this.scope = "";
	}
	begin(scope: string, mode: VerificationMode) {
		if (scope !== this.scope || mode === "full") this.clear();
		this.scope = scope;
		return { generation: ++this.generation, previous: this.snapshot };
	}
	finish(generation: number, local?: Scan, remote?: Scan) {
		// A superseded or invalidated request must never repopulate the cache.
		if (generation !== this.generation) return;
		this.snapshot = undefined;
		if (
			!local ||
			!remote ||
			Object.keys(local.errors).length ||
			Object.keys(remote.errors).length
		)
			return;
		let entries = 0,
			bytes = 0;
		const snapshot: Snapshot = {
			local: dictionary<Seen>(),
			remote: dictionary<Seen>(),
		};
		for (const side of ["local", "remote"] as const) {
			for (const [path, seen] of Object.entries(
				side === "local" ? local.files : remote.files,
			)) {
				if (!seen) continue;
				// Bound retained strings and record count, not engine-wide JS RSS.
				bytes += 2 * (path.length + seen.version.length + 256);
				if (++entries > this.maxEntries || bytes > this.maxBytes) return;
				snapshot[side][path] = { ...seen };
			}
		}
		this.snapshot = snapshot;
	}
}
