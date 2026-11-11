import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";

const xml = (s) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export async function startMock({ unsafe = false } = {}) {
	const files = new Map(),
		dirs = new Set([""]);
	const counters = { get: 0, put: 0, delete: 0 };
	let serial = 0;
	/** @type {{beforeCommit: null | ((event: {method: string, path: string}) => Promise<void>), loseResponse: boolean, failList: boolean, forbidden: string | null, truncateGet: boolean}} */
	const hooks = {
		beforeCommit: null,
		loseResponse: false,
		failList: false,
		forbidden: null,
		truncateGet: false,
	};
	const put = (path, body) =>
		files.set(path, {
			body: Buffer.from(body),
			etag: `"v${++serial}-${createHash("sha256").update(body).digest("hex").slice(0, 12)}"`,
		});
	const server = http.createServer(async (req, res) => {
		try {
			const path = decodeURIComponent(new URL(req.url, "http://local").pathname)
				.replace(/^\//, "")
				.replace(/\/$/, "");
			if (hooks.forbidden === path) {
				res.writeHead(403).end();
				return;
			}
			const current = () => files.get(path);
			const condition = () =>
				req.headers["if-none-match"] === "*"
					? !current() && !dirs.has(path)
					: req.headers["if-match"]
						? current()?.etag === req.headers["if-match"]
						: true;
			if (req.method === "GET") {
				counters.get++;
				const f = current();
				if (!f) {
					res.writeHead(404).end();
					return;
				}
				res.writeHead(200, { ETag: f.etag, "Content-Length": f.body.length });
				if (hooks.truncateGet) {
					hooks.truncateGet = false;
					res.write(f.body.subarray(0, 1));
					setTimeout(() => res.destroy(), 5);
					return;
				}
				res.end(f.body);
				return;
			}
			if (req.method === "PROPFIND") {
				if (hooks.failList) {
					res.writeHead(503).end();
					return;
				}
				if (!dirs.has(path)) {
					res.writeHead(404).end();
					return;
				}
				const parent = (p) =>
					p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
				const paths = [
					path,
					...[...dirs, ...files.keys()].filter(
						(p) => p !== path && parent(p) === path,
					),
				];
				const body = paths
					.map(
						(p) =>
							`<d:response><d:href>/${p.split("/").map(encodeURIComponent).join("/")}${p && dirs.has(p) ? "/" : ""}</d:href><d:propstat><d:prop><d:resourcetype>${dirs.has(p) ? "<d:collection/>" : ""}</d:resourcetype><d:getetag>${xml(files.get(p)?.etag ?? "")}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
					)
					.join("");
				res
					.writeHead(207, { "Content-Type": "application/xml" })
					.end(`<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`);
				return;
			}
			if (req.method === "MKCOL") {
				if (dirs.has(path) || files.has(path)) {
					res.writeHead(405).end();
					return;
				}
				const parent = path.includes("/")
					? path.slice(0, path.lastIndexOf("/"))
					: "";
				if (!dirs.has(parent)) {
					res.writeHead(409).end();
					return;
				}
				dirs.add(path);
				res.writeHead(201).end();
				return;
			}
			if (req.method === "PUT" || req.method === "DELETE") {
				const early = condition();
				const chunks = [];
				for await (const c of req) chunks.push(c);
				if (hooks.beforeCommit)
					await hooks.beforeCommit({ method: req.method, path });
				if (!(unsafe ? early : condition())) {
					res.writeHead(412).end();
					return;
				}
				if (req.method === "PUT") {
					if (dirs.has(path)) {
						res.writeHead(405).end();
						return;
					}
					put(path, Buffer.concat(chunks));
					counters.put++;
				} else {
					files.delete(path);
					counters.delete++;
				}
				if (hooks.loseResponse) {
					hooks.loseResponse = false;
					res.destroy();
					return;
				}
				res.writeHead(req.method === "PUT" ? 201 : 204).end();
				return;
			}
			res.writeHead(405).end();
		} catch {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		files,
		dirs,
		hooks,
		counters,
		put,
		stop: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	};
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
	const s = await startMock();
	console.log(
		JSON.stringify({ url: s.url, scope: "isolated synthetic server" }),
	);
}
