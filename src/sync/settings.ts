import { savedCollectionUrl } from "./connection";
import { isRecord } from "./validation";

export function loadSettings(value: unknown) {
	const raw = isRecord(value) ? value : {};
	return {
		url: savedCollectionUrl(raw.url),
		username: typeof raw.username === "string" ? raw.username : "",
		mock: raw.mock === true,
	};
}
