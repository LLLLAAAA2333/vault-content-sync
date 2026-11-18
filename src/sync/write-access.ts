import { createHash } from "node:crypto";
import { collectionUrl } from "./connection";

export interface WriteAccess {
	readonly verifiedAt: number;
}
const grants = new WeakMap<WriteAccess, string>();
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
export function grantWriteAccess(scope: string): WriteAccess {
	const access = Object.freeze({ verifiedAt: Date.now() });
	grants.set(access, scope);
	return access;
}
export function permitsWrite(access: WriteAccess | undefined, scope: string) {
	return !!access && grants.get(access) === scope;
}
export function revokeWriteAccess(access: WriteAccess | undefined) {
	if (access) grants.delete(access);
}
