/** Validate before persisting or displaying a WebDAV endpoint. Never echo input. */
export function collectionUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Enter a complete WebDAV collection URL");
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!["https:", "http:"].includes(url.protocol)
	)
		throw new Error(
			"Use a plain WebDAV collection URL; credentials are separate",
		);
	if (url.protocol !== "https:" && !isLoopback(url))
		throw new Error("HTTPS required outside loopback");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url;
}
export function isLoopback(url: URL) {
	return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
export function savedCollectionUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "";
	try {
		return collectionUrl(value.trim()).href;
	} catch {
		return "";
	}
}
