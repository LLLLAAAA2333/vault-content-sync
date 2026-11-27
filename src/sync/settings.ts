import { savedCollectionUrl } from "./connection";
import { safePath } from "./model";
import { isRecord } from "./validation";

export function parseExcludedFolders(value: string): string[] {
	const folders = new Map<string, string>();
	for (const line of value.split(/\r?\n/)) {
		const relative = line.trim().replaceAll("\\", "/");
		if (!relative) continue;
		if (/^[a-z]:/i.test(relative)) throw new Error("Unsafe relative path");
		const path = safePath(relative.replace(/\/+$/, ""));
		const key = path.normalize("NFC").toLowerCase();
		if (!folders.has(key)) folders.set(key, path);
	}
	return [...folders.values()];
}

export function loadSettings(value: unknown) {
	const raw = isRecord(value) ? value : {};
	return {
		url: savedCollectionUrl(raw.url),
		username: typeof raw.username === "string" ? raw.username : "",
		excludedFolders: Array.isArray(raw.excludedFolders)
			? raw.excludedFolders.filter(
					(folder): folder is string => typeof folder === "string",
				)
			: [],
		passwordMode:
			raw.passwordMode === "secret"
				? ("secret" as const)
				: ("session" as const),
		secretName:
			typeof raw.secretName === "string" &&
			/^[a-z0-9-]{1,64}$/.test(raw.secretName)
				? raw.secretName
				: "",
		credentialScope:
			typeof raw.credentialScope === "string" &&
			/^[a-f0-9]{64}$/.test(raw.credentialScope)
				? raw.credentialScope
				: "",
	};
}

export type SyncSettings = ReturnType<typeof loadSettings>;
