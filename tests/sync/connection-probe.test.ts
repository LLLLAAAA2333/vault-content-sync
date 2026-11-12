import { once } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type ScanProgress, scan } from "@/sync/model";
import { request, responseText, WebDavStore } from "@/sync/webdav";
import { setup } from "./helpers";

const servers: http.Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
async function serve(handler: http.RequestListener) {
	const server = http.createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	return new URL(`http://127.0.0.1:${address.port}/notes/`);
}
const entry =
	"<d:response><d:href>/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>";
const xml = (body = entry) =>
	`<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;

it("probes exactly the configured collection with Depth 0 and no file or state access", async () => {
	const s = await setup();
	s.server.put("nested/private.md", "synthetic content");
	await s.remote.testConnection();
	expect(s.server.counters).toEqual({ get: 0, put: 0, delete: 0, propfind: 1 });
	expect(await readdir(s.a)).toEqual([]);
	const calls: { method?: string; path?: string; depth?: string | string[] }[] =
		[];
	const url = await serve((req, res) => {
		calls.push({ method: req.method, path: req.url, depth: req.headers.depth });
		res.writeHead(207).end(xml());
	});
	await new WebDavStore({ url: url.href }).testConnection();
	expect(calls).toEqual([{ method: "PROPFIND", path: "/notes/", depth: "0" }]);
});
it.each([
	[401, "身份验证失败"],
	[403, "没有访问权限"],
	[404, "目录不存在"],
	[405, "不支持 WebDAV"],
	[302, "服务器要求跳转"],
	[503, "HTTP 503"],
] as const)(
	"reports HTTP %s without exposing response content or following redirects",
	async (status, message) => {
		let requests = 0;
		const url = await serve((_req, res) => {
			requests++;
			res
				.writeHead(status, { Location: "/should-not-follow/" })
				.end("synthetic-secret");
		});
		await expect(
			new WebDavStore({
				url: url.href,
				username: "user",
				password: "synthetic-secret",
			}).testConnection(),
		).rejects.toThrow(message);
		expect(requests).toBe(1);
	},
);
it.each([
	"<html>login</html>",
	xml().slice(0, -3),
	xml(""),
	xml(entry + entry),
	xml().replace("/notes/", "/wrong/"),
	xml().replace("/notes/", "https://other.invalid/notes/"),
	xml().replace("/notes/", "/notes/?token=x"),
	xml().replace("200 OK", "403 Forbidden"),
	xml().replace("<d:collection/>", ""),
	"x".repeat(65 * 1024),
])("rejects unconfirmed collection metadata %#", async (body) => {
	const url = await serve((_req, res) => res.writeHead(207).end(body));
	await expect(
		new WebDavStore({ url: url.href }).testConnection(),
	).rejects.toThrow("未能确认目录可读");
});
it("bounds the whole response lifetime, including a stalled body", async () => {
	const url = await serve((_req, res) => {
		res.writeHead(207);
		res.write("<d:multistatus");
	});
	const response = await request(url, "PROPFIND", {}, undefined, 40);
	await expect(responseText(response)).rejects.toThrow();
});
it("bounds the wait for response headers", async () => {
	const url = await serve(() => {
		/* deliberately silent synthetic server */
	});
	await expect(request(url, "PROPFIND", {}, undefined, 40)).rejects.toThrow(
		"deadline",
	);
});
it("reports completed reads monotonically and preserves incomplete-scan errors", async () => {
	const s = await setup();
	await writeFile(join(s.a, "a.md"), "123");
	await writeFile(join(s.a, "b.md"), "45");
	const events: ScanProgress[] = [];
	const result = await scan(s.A.local, (event) => events.push(event));
	expect(events.map((e) => [e.phase, e.completed])).toEqual([
		["listing", 0],
		["reading", 0],
		["reading", 1],
		["reading", 2],
	]);
	expect(events.at(-1)).toEqual({
		phase: "reading",
		completed: 2,
		total: 2,
		bytes: 5,
	});
	expect(result.bytes).toBe(5);
	s.server.put("a.md", "123");
	s.server.hooks.forbidden = "a.md";
	const failed: ScanProgress[] = [];
	const incomplete = await scan(s.remote, (e) => failed.push(e));
	expect(Object.keys(incomplete.errors)).toEqual(["a.md"]);
	expect(failed.at(-1)).toEqual({
		phase: "reading",
		completed: 1,
		total: 1,
		bytes: 0,
	});
});
