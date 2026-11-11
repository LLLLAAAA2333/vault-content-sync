import { type Intent, type Seen, type State, safePath } from "./model";
import { dictionary, isRecord } from "./validation";

function hash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function nullableHash(value: unknown): value is string | null {
	return value === null || hash(value);
}
function seen(value: unknown): value is Seen {
	return (
		value === null ||
		(isRecord(value) &&
			hash(value.hash) &&
			(value.syncHash === undefined || hash(value.syncHash)) &&
			typeof value.version === "string" &&
			typeof value.size === "number" &&
			Number.isSafeInteger(value.size) &&
			value.size >= 0)
	);
}
function intent(value: unknown, path: string): value is Intent {
	return (
		isRecord(value) &&
		value.path === path &&
		typeof value.id === "string" &&
		/^[a-f0-9-]{36}$/.test(value.id) &&
		(value.phase === "prepared" ||
			value.phase === "remote" ||
			value.phase === "local") &&
		(value.blocked === undefined || typeof value.blocked === "boolean") &&
		seen(value.local) &&
		seen(value.remote) &&
		nullableHash(value.desired) &&
		nullableHash(value.localDesired)
	);
}

/** Validate before recovery can use any persisted path, version or phase. */
export function checkpoint(value: unknown, identity: string): State {
	if (
		!isRecord(value) ||
		value.format !== 2 ||
		value.identity !== identity ||
		!isRecord(value.baseline) ||
		!isRecord(value.pending)
	) {
		throw new Error(
			"State identity or format mismatch; legacy byte-only checkpoints require explicit migration",
		);
	}
	const baseline = dictionary<string | null>();
	const pending = dictionary<Intent>();
	for (const [path, version] of Object.entries(value.baseline)) {
		safePath(path);
		if (!nullableHash(version)) throw new Error("Corrupt baseline");
		baseline[path] = version;
	}
	for (const [path, entry] of Object.entries(value.pending)) {
		safePath(path);
		if (!intent(entry, path)) throw new Error("Corrupt intent");
		pending[path] = entry;
	}
	return { format: 2, identity, baseline, pending };
}
