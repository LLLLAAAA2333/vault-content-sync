import { savedCollectionUrl } from "./connection";
import { isRecord } from "./validation";

export function loadSettings(value: unknown) {
	const raw = isRecord(value) ? value : {};
	return {
		url: savedCollectionUrl(raw.url),
		username: typeof raw.username === "string" ? raw.username : "",
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
