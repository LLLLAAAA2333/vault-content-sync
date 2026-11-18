import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import core from "../dist/sync-core.cjs";
import { startApache } from "./apache-server.mjs";

globalThis.DOMParser = new JSDOM().window.DOMParser;
const server = await startApache({ authenticated: true });
const checks = [];
try {
	const a = join(server.root, "client-a"),
		b = join(server.root, "client-b");
	await mkdir(a);
	await mkdir(b);
	const options = { url: server.url, ...server.credentials };
	await assert.rejects(
		new core.WebDavStore({ url: server.url }).testConnection(),
		/认证失败/,
	);
	checks.push("real Basic authentication rejects unauthenticated access");
	const result = await core.verifyWriteAccess(options);
	assert.deepEqual(await readdir(a), []);
	checks.push(
		"verification uses synthetic remote directory without creating local state",
	);
	const remote = () =>
		new core.WebDavStore({ ...options, writeAccess: result.access });
	const engine = (root) =>
		new core.PlainEngine(new core.LocalStore(root), remote(), root);
	const A = engine(a),
		B = engine(b);
	const sync = async (e) => e.run(await e.preview());
	const row = async (e, path) =>
		(await e.preview()).rows.find((r) => r.path === path);
	const contents = (root, path) => readFile(join(root, path), "utf8");
	await mkdir(join(a, "中文 空格"));
	await writeFile(join(a, "中文 空格/a%?#.bin"), Buffer.from([0, 255, 10, 13]));
	await writeFile(
		join(a, "n.md"),
		"---\nupdated: local-a\n---\none\ntwo\nthree\n",
	);
	await sync(A);
	await sync(B);
	assert.equal(await contents(b, "n.md"), "one\ntwo\nthree\n");
	assert.deepEqual(
		await readFile(join(b, "中文 空格/a%?#.bin")),
		Buffer.from([0, 255, 10, 13]),
	);
	assert.ok(
		(await A.preview()).rows
			.filter((r) => r.kind !== "excluded")
			.every((r) => r.kind === "equal"),
	);
	assert.ok(
		!(await readdir(b)).some((n) => n.startsWith(".vault-content-sync-check-")),
	);
	checks.push(
		"real upload/download, nested encoded paths, binary fidelity, updated policy, excluded probes",
	);
	await writeFile(
		join(a, "n.md"),
		"---\nupdated: local-a\n---\nONE\ntwo\nthree\n",
	);
	await writeFile(join(b, "n.md"), "one\ntwo\nTHREE\n");
	await sync(B);
	assert.equal((await row(A, "n.md")).kind, "conflict");
	await A.resolve(await row(A, "n.md"), "merge");
	assert.equal(
		await contents(a, "n.md"),
		"---\nupdated: local-a\n---\nONE\ntwo\nTHREE\n",
	);
	await sync(B);
	assert.equal(await contents(b, "n.md"), "ONE\ntwo\nTHREE\n");
	checks.push("three-way merge and local updated preservation");
	await writeFile(join(a, "n.md"), "left\ntwo\nTHREE\n");
	await writeFile(join(b, "n.md"), "right\ntwo\nTHREE\n");
	await sync(B);
	await assert.rejects(A.resolve(await row(A, "n.md"), "merge"), /Overlapping/);
	assert.equal(await contents(a, "n.md"), "left\ntwo\nTHREE\n");
	await A.resolve(await row(A, "n.md"), "remote");
	assert.equal(await contents(a, "n.md"), "right\ntwo\nTHREE\n");
	await writeFile(join(a, "n.md"), "choose-local");
	await writeFile(join(b, "n.md"), "other-remote");
	await sync(B);
	await A.resolve(await row(A, "n.md"), "local");
	await sync(B);
	assert.equal(await contents(b, "n.md"), "choose-local");
	checks.push(
		"overlapping merge stops; explicit remote and local conflict choices",
	);
	await writeFile(join(a, "n.md"), "planned");
	const stale = await A.preview();
	await writeFile(join(a, "n.md"), "later-edit");
	await assert.rejects(A.run(stale), /changed/);
	assert.equal(await contents(b, "n.md"), "choose-local");
	checks.push("stale preview cannot overwrite later edits");
	await sync(A);
	await sync(B);
	await writeFile(join(b, "n.md"), "competing");
	const preview = await B.preview();
	await A.remote.exclusive(async () => {
		await assert.rejects(B.run(preview), /其他设备/);
		assert.equal(await contents(b, "n.md"), "competing");
	});
	await sync(B);
	checks.push(
		"concurrent client excluded by real directory lock, retry succeeds after unlock",
	);
	await sync(A);
	await writeFile(join(a, "n.md"), "recover-me");
	const save = A.journal.save.bind(A.journal);
	let saves = 0;
	A.journal.save = async (state) => {
		if (++saves === 2) throw new Error("synthetic checkpoint failure");
		return save(state);
	};
	await assert.rejects(sync(A), /checkpoint failure/);
	const restarted = engine(a);
	await restarted.recover();
	assert.deepEqual(Object.keys((await restarted.journal.load()).pending), []);
	assert.equal((await row(restarted, "n.md")).kind, "equal");
	checks.push(
		"restart recovery after real server mutation and checkpoint failure",
	);
	await sync(B);
	await rm(join(b, "n.md"));
	await sync(B);
	await sync(restarted);
	assert.equal((await row(restarted, "n.md")).kind, "equal");
	assert.equal((await row(restarted, "n.md")).local, null);
	checks.push(
		"guarded deletion propagates in both directions with retained versions",
	);
	assert.ok((await readdir(restarted.journal.blobs)).length > 0);
	assert.equal(
		new core.WebDavStore({
			url: new URL("different/", server.url).href,
			writeAccess: result.access,
		}).writable,
		false,
	);
	assert.equal(
		new core.WebDavStore({
			...options,
			username: "different",
			password: "synthetic",
			writeAccess: result.access,
		}).writable,
		false,
	);
	assert.equal(
		new core.WebDavStore({
			...options,
			writeAccess: JSON.parse(JSON.stringify(result.access)),
		}).writable,
		false,
	);
	core.revokeWriteAccess(result.access);
	assert.equal(restarted.remote.writable, false);
	await assert.rejects(sync(restarted), /capability/);
	checks.push(
		"write grant bound to endpoint and credentials, not serializable, revocable",
	);
	const report = {
		service: "Apache mod_dav_fs",
		probeChecks: result.checks,
		integrationChecks: checks,
		passed: true,
	};
	await mkdir("artifacts", { recursive: true });
	await writeFile(
		"artifacts/real-webdav.json",
		JSON.stringify(report, null, 2),
	);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await server.stop();
}
