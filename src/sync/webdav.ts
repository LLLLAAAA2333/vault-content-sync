import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { Readable } from "node:stream";
import * as timers from "node:timers";
import { collectionUrl, isLoopback } from "./connection";
import { digest, smallText } from "./files";
import {
	excluded,
	type Listing,
	type Seen,
	type Store,
	safePath,
} from "./model";
import { byteChunks } from "./validation";

export interface DavOptions {
	url: string;
	username?: string;
	password?: string;
	isolatedMock?: boolean;
	excludedRoots?: readonly string[];
}
export function request(
	url: URL,
	method: string,
	headers: Record<string, string> = {},
	body?: Readable | string,
	deadlineMs = 120_000,
): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const req = (url.protocol === "https:" ? https : http).request(
			url,
			{ method, headers },
			resolve,
		);
		const timer = timers.setTimeout(
			() => req.destroy(new Error("Request deadline exceeded")),
			deadlineMs,
		);
		req.on("error", reject);
		req.on("close", () => timers.clearTimeout(timer));
		if (typeof body === "string") req.end(body);
		else if (body) {
			body.on("error", (e) => req.destroy(e));
			req.on("error", () => body.destroy());
			req.on("response", (res) => {
				if ((res.statusCode ?? 500) >= 400) body.destroy();
			});
			body.pipe(req);
		} else req.end();
	});
}
export async function responseText(
	res: http.IncomingMessage,
	limit = 16 * 1024 * 1024,
) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of byteChunks(res)) {
		size += chunk.length;
		if (size > limit) {
			res.destroy();
			throw new Error("Response exceeds budget");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
export class WebDavStore implements Store {
	readonly root: URL;
	readonly excludedRoots: readonly string[];
	readonly identity: string;
	readonly headers: Record<string, string>;
	writable = false;
	/** Read collection metadata only: no recursion, file GET, or writes. */
	async testConnection(): Promise<void> {
		let res: http.IncomingMessage;
		try {
			res = await request(
				this.root,
				"PROPFIND",
				{
					...this.headers,
					Depth: "0",
					"Content-Type": "application/xml",
					"Cache-Control": "no-cache",
				},
				'<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
				15_000,
			);
		} catch {
			throw new Error("连接失败或超时，请检查网络、地址和服务器证书。");
		}
		const status = res.statusCode ?? 0;
		if (status !== 207) {
			res.destroy();
			const messages: Record<number, string> = {
				401: "身份验证失败，请检查用户名和密码。",
				403: "没有访问权限，请检查账号的目录权限。",
				404: "目录不存在，请检查 WebDAV 文件夹地址。",
				405: "该地址不支持 WebDAV，请填写 WebDAV 入口。",
			};
			throw new Error(
				messages[status] ??
					(status >= 300 && status < 400
						? "服务器要求跳转，请直接填写最终 WebDAV 文件夹地址。"
						: `服务器未返回有效的 WebDAV 响应（HTTP ${status}）。`),
			);
		}
		try {
			const xml = new DOMParser().parseFromString(
				await responseText(res, 64 * 1024),
				"application/xml",
			);
			const entries = Array.from(
				xml.getElementsByTagNameNS("DAV:", "response"),
			);
			const entry = entries[0];
			if (
				xml.getElementsByTagName("parsererror").length ||
				xml.documentElement.localName !== "multistatus" ||
				xml.documentElement.namespaceURI !== "DAV:" ||
				entries.length !== 1 ||
				!entry
			)
				throw new Error("Invalid collection response");
			const href = entry.getElementsByTagNameNS("DAV:", "href")[0]?.textContent;
			const target = href ? new URL(href, this.root) : null;
			const statuses = Array.from(
				entry.getElementsByTagNameNS("DAV:", "status"),
			);
			if (
				!target ||
				target.origin !== this.root.origin ||
				target.search ||
				target.hash ||
				target.pathname.replace(/\/$/, "") !==
					this.root.pathname.replace(/\/$/, "") ||
				!statuses.length ||
				statuses.some(
					(node) =>
						!/^HTTP\/\d(?:\.\d)? 200(?: |$)/.test(node.textContent ?? ""),
				) ||
				!entry.getElementsByTagNameNS("DAV:", "collection").length
			)
				throw new Error("Not the requested readable collection");
		} catch {
			res.destroy();
			throw new Error("未能确认目录可读，请检查地址是否指向 WebDAV 文件夹。");
		}
	}
	constructor(options: DavOptions) {
		this.root = collectionUrl(options.url);
		this.excludedRoots = (options.excludedRoots ?? []).map(safePath);
		const loopback = isLoopback(this.root);
		this.identity = `dav:${this.root.href}:${createHash("sha256")
			.update(options.username ?? "")
			.digest("hex")}`;
		this.headers = options.username
			? {
					Authorization: `Basic ${Buffer.from(`${options.username}:${options.password ?? ""}`).toString("base64")}`,
				}
			: {};
		this.writable = options.isolatedMock === true && loopback;
	}
	url(path: string) {
		safePath(path);
		if (excluded(path, this.excludedRoots)) throw new Error("Excluded target");
		return new URL(
			path.split("/").map(encodeURIComponent).join("/"),
			this.root,
		);
	}
	async call(
		path: string,
		method: string,
		headers: Record<string, string> = {},
		body?: Readable | string,
	) {
		return request(
			path ? this.url(path) : this.root,
			method,
			{ ...this.headers, ...headers, "Cache-Control": "no-cache" },
			body,
		);
	}
	async read(path: string, archive?: string): Promise<Seen> {
		const res = await this.call(path, "GET");
		if (res.statusCode === 404) {
			res.resume();
			return null;
		}
		if (res.statusCode !== 200) {
			res.resume();
			throw new Error(`WebDAV GET HTTP ${res.statusCode}`);
		}
		const value = await digest(res, archive, path);
		const etag = res.headers.etag ?? "";
		return { ...value, version: etag };
	}
	async text(path: string, expected: Seen) {
		if (!expected || expected.size > 1024 * 1024) return null;
		const res = await this.call(path, "GET");
		if (res.statusCode !== 200) {
			res.resume();
			throw new Error("Text read failed");
		}
		return smallText(res, expected);
	}

	async list(): Promise<Listing> {
		const result: Listing = { files: [], excluded: [], folders: [] };
		const queue = [""];
		const seen = new Set<string>();
		while (queue.length) {
			const dir = queue.shift()!;
			if (seen.has(dir)) throw new Error("Repeated collection");
			seen.add(dir);
			const res = await this.call(
				dir,
				"PROPFIND",
				{ Depth: "1", "Content-Type": "application/xml" },
				'<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>',
			);
			if (res.statusCode !== 207) {
				res.resume();
				throw new Error(`WebDAV listing HTTP ${res.statusCode}`);
			}
			const xml = new DOMParser().parseFromString(
				await responseText(res),
				"application/xml",
			);
			if (
				xml.getElementsByTagName("parsererror").length ||
				xml.documentElement.localName !== "multistatus"
			)
				throw new Error("Invalid DAV listing");
			const responses = Array.from(
				xml.getElementsByTagNameNS("DAV:", "response"),
			);
			let self = false;
			const unique = new Set<string>();
			for (const entry of responses) {
				const href = entry.getElementsByTagNameNS("DAV:", "href")[0]
					?.textContent;
				if (!href) throw new Error("Missing DAV href");
				const u = new URL(href, this.root);
				if (
					u.origin !== this.root.origin ||
					u.search ||
					u.hash ||
					!u.pathname.startsWith(this.root.pathname)
				)
					throw new Error("DAV path outside root");
				const encoded = u.pathname
					.slice(this.root.pathname.length)
					.replace(/\/$/, "");
				const segments = encoded.split("/").map(decodeURIComponent);
				if (segments.some((s) => s.includes("/") || s.includes("\\")))
					throw new Error("Encoded path separator");
				const path = segments.join("/");
				const statuses = Array.from(
					entry.getElementsByTagNameNS("DAV:", "status"),
				);
				if (
					!statuses.length ||
					statuses.some(
						(s) => !/^HTTP\/\d(?:\.\d)? 200(?: |$)/.test(s.textContent ?? ""),
					)
				)
					throw new Error("Partial DAV property failure");
				const type = entry.getElementsByTagNameNS("DAV:", "resourcetype")[0];
				if (!type) throw new Error("Missing DAV resource type");
				const folder =
					type.getElementsByTagNameNS("DAV:", "collection").length > 0;
				if (path === dir) {
					if (!folder || self) throw new Error("Invalid collection self");
					self = true;
					continue;
				}
				safePath(path);
				if (
					path.slice(
						0,
						path.lastIndexOf("/") < 0 ? 0 : path.lastIndexOf("/"),
					) !== dir ||
					unique.has(path)
				)
					throw new Error("Invalid Depth 1 response");
				unique.add(path);
				if (excluded(path, this.excludedRoots)) {
					result.excluded.push(path);
					continue;
				}
				if (folder) {
					result.folders.push(path);
					queue.push(path);
				} else result.files.push(path);
			}
			if (!self) throw new Error("Incomplete listing: collection missing");
		}
		return result;
	}
	async change(
		path: string,
		expected: Seen,
		source: string | null,
		_id: string,
	) {
		if (!this.writable)
			throw new Error(
				"Remote writes disabled: atomic server guarantees not established",
			);
		if (excluded(path, this.excludedRoots)) throw new Error("Excluded target");
		if (expected && !/^"[^"\r\n]+"$/.test(expected.version))
			throw new Error("Strong ETag required");
		if (!source && !expected) return;
		if (source) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) {
				const res = await this.call(parts.slice(0, i).join("/"), "MKCOL");
				const status = res.statusCode;
				res.resume();
				if (![201, 405].includes(status ?? 0))
					throw new Error(`WebDAV MKCOL HTTP ${status}`);
			}
		}
		const headers: Record<string, string> = expected
			? { "If-Match": expected.version }
			: { "If-None-Match": "*" };
		if (source)
			headers["Content-Length"] = String((await fs.stat(source)).size);
		const res = await this.call(
			path,
			source ? "PUT" : "DELETE",
			headers,
			source
				? createReadStream(source, { highWaterMark: 64 * 1024 })
				: undefined,
		);
		const status = res.statusCode ?? 0;
		await responseText(res);
		if (![200, 201, 204].includes(status))
			throw new Error(
				status === 412
					? "Remote precondition failed"
					: `WebDAV mutation HTTP ${status}`,
			);
	}
}
