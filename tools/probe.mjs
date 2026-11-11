import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { JSDOM } from "jsdom";
import core from "../dist/sync-core.cjs";
import { startMock } from "./mock-server.mjs";

globalThis.DOMParser = new JSDOM().window.DOMParser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function probe(base, auth = {}) {
	const folder = `plain-probe-${randomUUID()}`;
	const root = new URL(folder + "/", base.endsWith("/") ? base : base + "/");
	const events = [];
	const started = performance.now();
	const headers = auth.username
		? {
				Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password ?? ""}`).toString("base64")}`,
			}
		: {};
	const report = {
		format: 1,
		scope:
			"Synthetic files in a newly created dedicated directory; observations, not a general server guarantee",
		targetOrigin: root.origin,
		testDirectory: root.pathname,
		startedAt: new Date().toISOString(),
		node: process.version,
		events,
		checks: {},
		unknown: [
			"Server implementation/atomicity contract",
			"Behavior beyond tested overlap, deadlines and directory size",
			"Authorization failures outside this test account",
			"Lock scope and expiry (locks not used)",
		],
		automaticWritesEnabled: false,
		createdFiles: [],
	};
	const wire = (name, method, extra = {}, body = "", held = false) => {
		const url = new URL(
			name.split("/").map(encodeURIComponent).join("/"),
			root,
		);
		const seq = events.length;
		events.push({
			seq,
			method,
			path: name,
			atMs: performance.now() - started,
			phase: "headers",
		});
		let release;
		let abort;
		const result = new Promise((resolve, reject) => {
			const req = (url.protocol === "https:" ? https : http).request(
				url,
				{
					method,
					headers: {
						...headers,
						...extra,
						...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
					},
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("error", reject);
					res.on("end", () => {
						const value = {
							status: res.statusCode,
							etag: res.headers.etag,
							body: Buffer.concat(chunks),
						};
						events.push({
							seq,
							method,
							path: name,
							atMs: performance.now() - started,
							phase: "response",
							status: value.status,
						});
						resolve(value);
					});
				},
			);
			req.on("error", reject);
			req.setTimeout(15000, () => req.destroy(new Error("probe timeout")));
			if (held) {
				req.flushHeaders();
				req.write(body.slice(0, 1));
				release = () => {
					events.push({
						seq,
						phase: "release-body",
						atMs: performance.now() - started,
					});
					req.end(body.slice(1));
				};
			} else req.end(body);
			abort = () => req.destroy(new Error("injected interrupted upload"));
		});
		return { result, release: () => release?.(), abort: () => abort?.() };
	};
	const call = async (name, method, extra = {}, body = "") =>
		wire(name, method, extra, body).result;
	const collection = await call("", "MKCOL");
	if (collection.status !== 201)
		throw new Error(
			`Probe requires a new directory (HTTP ${collection.status})`,
		);
	const own = async (name, body) => {
		report.createdFiles.push(name);
		return call(name, "PUT", { "If-None-Match": "*" }, body);
	};
	const ok = (r) => [200, 201, 204].includes(r.status);
	await own("中文 空格%?#.zby", "raw\u0000bytes");
	const read = await call("中文 空格%?#.zby", "GET");
	report.checks.pathEncoding = read.body.equals(Buffer.from("raw\u0000bytes"));
	const dav = new core.WebDavStore({ url: root.href, ...auth });
	try {
		report.checks.listGetConsistency =
			(await dav.list()).files.includes("中文 空格%?#.zby") &&
			(await dav.read("中文 空格%?#.zby"))?.hash ===
				createHash("sha256").update(read.body).digest("hex");
	} catch {
		report.checks.listGetConsistency = false;
	}
	report.checks.strongEtag = /^"[^"\r\n]+"$/.test(read.etag ?? "");
	report.checks.createPrecondition =
		(await call("中文 空格%?#.zby", "PUT", { "If-None-Match": "*" }, "bad"))
			.status === 412;
	const changed = await call(
		"中文 空格%?#.zby",
		"PUT",
		{ "If-Match": read.etag ?? '"missing"' },
		"second",
	);
	const newer = await call("中文 空格%?#.zby", "GET");
	report.checks.etagChanges = ok(changed) && newer.etag !== read.etag;
	report.checks.stalePut =
		(
			await call(
				"中文 空格%?#.zby",
				"PUT",
				{ "If-Match": read.etag ?? '"missing"' },
				"bad",
			)
		).status === 412;
	report.checks.staleDelete =
		(
			await call("中文 空格%?#.zby", "DELETE", {
				"If-Match": read.etag ?? '"missing"',
			})
		).status === 412;
	for (const mode of [
		"create",
		"overwrite",
		"put-vs-delete",
		"delete-vs-put",
	]) {
		const name = `overlap-${mode}.txt`;
		report.createdFiles.push(name);
		if (mode !== "create")
			await call(name, "PUT", { "If-None-Match": "*" }, "base");
		const before = await call(name, "GET");
		const cond =
			mode === "create"
				? { "If-None-Match": "*" }
				: { "If-Match": before.etag ?? '"missing"' };
		const slow = wire(
			name,
			mode === "delete-vs-put" ? "DELETE" : "PUT",
			cond,
			"slow-A",
			true,
		);
		// A has delivered its headers and a partial body before B is sent. Both overlap until release.
		await sleep(100);
		const fast = await call(
			name,
			mode === "put-vs-delete" ? "DELETE" : "PUT",
			cond,
			mode === "put-vs-delete" ? "" : "fast-B",
		);
		slow.release();
		const late = await slow.result;
		const final = await call(name, "GET");
		report.checks[`overlap:${mode}`] =
			ok(fast) &&
			late.status === 412 &&
			(mode === "put-vs-delete"
				? final.status === 404
				: final.body.toString() === "fast-B");
	}
	await own("interrupt.txt", "stable");
	const previous = await call("interrupt.txt", "GET");
	const partial = wire(
		"interrupt.txt",
		"PUT",
		{ "If-Match": previous.etag ?? '"missing"' },
		"incomplete-upload",
		true,
	);
	const abort = partial.abort;
	const observed = partial.result.catch(() => null);
	await sleep(80);
	abort();
	await observed;
	await sleep(150);
	const after = await call("interrupt.txt", "GET");
	report.checks.interruptedPutLeavesOldBytes = after.body.equals(previous.body);
	report.checks.missingIs404 =
		(await call("never-created.txt", "GET")).status === 404;
	report.observedPass = Object.values(report.checks).every(Boolean);
	report.finishedAt = new Date().toISOString();
	return report;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
	let server;
	try {
		const mock =
			process.argv.includes("--mock") || process.argv.includes("--unsafe-mock");
		if (mock)
			server = await startMock({
				unsafe: process.argv.includes("--unsafe-mock"),
			});
		const base = server?.url ?? process.env.PLAIN_TEST_PARENT_URL;
		if (!base)
			throw new Error(
				"Set PLAIN_TEST_PARENT_URL to an explicitly authorized test parent, or use --mock. No production mapping is inferred.",
			);
		// Reuse constructor validation for HTTPS, separate credentials and plain URL constraints.
		new core.WebDavStore({ url: base });
		const result = await probe(base, {
			username: mock ? undefined : process.env.PLAIN_DAV_USER,
			password: mock ? undefined : process.env.PLAIN_DAV_PASSWORD,
		});
		result.environment = mock
			? process.argv.includes("--unsafe-mock")
				? "unsafe-local-mock"
				: "atomic-local-mock"
			: "unverified-external-server";
		const output = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
		if (output) await writeFile(output, JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result, null, 2));
	} catch (e) {
		console.error(e.message);
		process.exitCode = 1;
	} finally {
		await server?.stop();
	}
}
