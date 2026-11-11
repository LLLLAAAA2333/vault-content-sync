export const META = ".plain-sync";
export const EXCLUDED = [
	".obsidian",
	".claudian",
	".git",
	".sync_state.json",
	".DS_Store",
	META,
	".trash",
];
export type Seen = {
	hash: string;
	syncHash?: string;
	size: number;
	version: string;
} | null;
export type Kind =
	| "equal"
	| "upload"
	| "download"
	| "delete-local"
	| "delete-remote"
	| "conflict"
	| "unknown"
	| "excluded";
export interface Row {
	path: string;
	kind: Kind;
	local: Seen;
	remote: Seen;
	reason?: string;
}
export interface Listing {
	files: string[];
	excluded: string[];
	folders: string[];
}
export interface Store {
	identity: string;
	list(): Promise<Listing>;
	read(path: string, archive?: string): Promise<Seen>;
	text(path: string, expected: Seen): Promise<string | null>;
	change(
		path: string,
		expected: Seen,
		source: string | null,
		id: string,
	): Promise<void>;
	parked?(id: string): Promise<Seen>;
	writable: boolean;
}
export interface Scan {
	files: Record<string, Seen>;
	excluded: string[];
	folders: string[];
	errors: Record<string, string>;
	bytes: number;
}
export interface Intent {
	id: string;
	path: string;
	local: Seen;
	remote: Seen;
	desired: string | null;
	localDesired: string | null;
	phase: "prepared" | "remote" | "local";
	blocked?: boolean;
}
export interface State {
	format: 2;
	identity: string;
	baseline: Record<string, string | null>;
	pending: Record<string, Intent>;
}
export interface Preview {
	rows: Row[];
	local: Scan;
	remote: Scan;
	readBytes: number;
	writes: number;
}
export function hashOf(seen: Seen): string | null {
	return seen?.syncHash ?? seen?.hash ?? null;
}
export function safePath(path: string): string {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		[...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
		path.split("/").some((p) => !p || p === "." || p === "..")
	)
		throw new Error("Unsafe relative path");
	return path;
}
export function excluded(path: string): boolean {
	return path
		.split("/")
		.some((p) => EXCLUDED.some((x) => x.toLowerCase() === p.toLowerCase()));
}
export function classify(
	base: string | null | undefined,
	l: Seen,
	r: Seen,
): Kind {
	const a = hashOf(l),
		b = hashOf(r);
	if (a === b) return "equal";
	if (base === undefined)
		return a === null ? "download" : b === null ? "upload" : "conflict";
	if (a === base) return b === null ? "delete-local" : "download";
	if (b === base) return a === null ? "delete-remote" : "upload";
	return "conflict";
}
export async function scan(store: Store): Promise<Scan> {
	const result: Scan = {
		files: Object.create(null),
		excluded: [],
		folders: [],
		errors: Object.create(null),
		bytes: 0,
	};
	try {
		const listing = await store.list();
		result.excluded = listing.excluded;
		result.folders = listing.folders;
		let cursor = 0;
		await Promise.all(
			[0, 1].map(async () => {
				while (cursor < listing.files.length) {
					const path = listing.files[cursor++];
					if (!path) continue;
					try {
						const seen = await store.read(path);
						if (!seen) throw new Error("Listed file disappeared");
						result.files[path] = seen;
						result.bytes += seen.size;
					} catch {
						result.errors[path] = "File could not be fully verified";
					}
				}
			}),
		);
	} catch {
		result.errors["/"] = "Directory listing incomplete or unavailable";
	}
	return result;
}
export function plan(state: State, local: Scan, remote: Scan): Preview {
	const paths = new Set([
		...Object.keys(state.baseline),
		...Object.keys(state.pending),
		...Object.keys(local.files),
		...Object.keys(remote.files),
		...Object.keys(local.errors),
		...Object.keys(remote.errors),
	]);
	const spellings = new Map<string, Set<string>>();
	for (const path of [...paths, ...local.folders, ...remote.folders]) {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const k = prefix.normalize("NFC").toLowerCase();
			const set = spellings.get(k) ?? new Set();
			set.add(prefix);
			spellings.set(k, set);
		}
	}
	const incomplete =
		Object.keys(local.errors).length + Object.keys(remote.errors).length > 0;
	const rows: Row[] = [...paths].sort().map((path) => {
		const l = local.files[path] ?? null,
			r = remote.files[path] ?? null;
		const parts = path.split("/");
		const clash =
			parts.some(
				(_, i) =>
					(spellings.get(
						parts
							.slice(0, i + 1)
							.join("/")
							.normalize("NFC")
							.toLowerCase(),
					)?.size ?? 0) > 1,
			) ||
			local.folders.includes(path) ||
			remote.folders.includes(path);
		const isExcluded =
			excluded(path) ||
			[...local.excluded, ...remote.excluded].some(
				(p) => path === p || path.startsWith(`${p}/`),
			);
		return {
			path,
			local: l,
			remote: r,
			kind: isExcluded
				? "excluded"
				: incomplete
					? "unknown"
					: clash || state.pending[path]
						? "conflict"
						: classify(state.baseline[path], l, r),
			reason: incomplete
				? "Incomplete scan; no actions allowed"
				: clash
					? "Case, normalization or file/folder collision"
					: state.pending[path]
						? "Unfinished operation requires recovery"
						: l && r && hashOf(l) === hashOf(r) && l.hash !== r.hash
							? "Shared content matches; local updated excluded"
							: undefined,
		};
	});
	for (const path of new Set([...local.excluded, ...remote.excluded]))
		if (!paths.has(path))
			rows.push({ path, kind: "excluded", local: null, remote: null });
	return {
		rows,
		local,
		remote,
		readBytes: local.bytes + remote.bytes,
		writes: rows.filter((r) =>
			["upload", "download", "delete-local", "delete-remote"].includes(r.kind),
		).length,
	};
}
