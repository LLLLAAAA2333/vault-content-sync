import { createHash } from "node:crypto";
import { collectionUrl } from "./connection";

export type WriteMode = "full" | "create-only";

export interface WriteAccess {
	readonly verifiedAt: number;
}
const grants = new WeakMap<WriteAccess, { scope: string; mode: WriteMode }>();
export function writeScope(options: {
	url: string;
	username?: string;
	password?: string;
}) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				collectionUrl(options.url).href,
				options.username ?? "",
				options.password ?? "",
			]),
		)
		.digest("hex");
}
/** Session-only capability. Serialized or copied objects never grant write access. */
export function grantWriteAccess(
	scope: string,
	mode: WriteMode = "full",
): WriteAccess {
	const access = Object.freeze({ verifiedAt: Date.now() });
	grants.set(access, { scope, mode });
	return access;
}
export function grantedWriteMode(
	access: WriteAccess | undefined,
	scope: string,
) {
	const grant = access && grants.get(access);
	return grant?.scope === scope ? grant.mode : undefined;
}
export function revokeWriteAccess(access: WriteAccess | undefined) {
	if (access) grants.delete(access);
}
