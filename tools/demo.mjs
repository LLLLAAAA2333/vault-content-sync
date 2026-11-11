import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import core from "../dist/sync-core.cjs";
import { startMock } from "./mock-server.mjs";

globalThis.DOMParser = new JSDOM().window.DOMParser;
const root = resolve("runtime", `demo-${Date.now()}`);
await mkdir(root, { recursive: true });
const s = await startMock();
try {
	const a = join(root, "A"),
		b = join(root, "B");
	await mkdir(a);
	await mkdir(b);
	const remote = new core.WebDavStore({ url: s.url, isolatedMock: true });
	const A = new core.PlainEngine(new core.LocalStore(a), remote, a),
		B = new core.PlainEngine(new core.LocalStore(b), remote, b);
	await writeFile(join(a, "中文 note.md"), "# Synthetic\n");
	s.put("中文 note.md", "# Synthetic\n");
	s.put("attachment.custom", Buffer.from([0, 255, 13, 10]));
	const before = await A.preview();
	await A.run(before);
	assert.equal(s.counters.put, 0);
	await B.run(await B.preview());
	await writeFile(join(a, "a.md"), "from A");
	await writeFile(join(b, "b.md"), "from B");
	const plans = await Promise.all([A.preview(), B.preview()]);
	await Promise.all([A.run(plans[0]), B.run(plans[1])]);
	await A.run(await A.preview());
	await B.run(await B.preview());
	assert.equal(await readFile(join(a, "b.md"), "utf8"), "from B");
	await writeFile(join(a, "a.md"), "after lost response");
	s.hooks.loseResponse = true;
	await A.run(await A.preview()).catch(() => {});
	const restart = new core.PlainEngine(new core.LocalStore(a), remote, a);
	await restart.recover();
	assert.equal((await restart.preview()).writes, 0);
	const report = {
		passed: true,
		root,
		scenario: [
			"same-byte adoption: zero PUT",
			"binary attachment",
			"two devices, overlapping additions",
			"lost response + restart recovery",
		],
		remoteFiles: [...s.files.keys()],
		requests: s.counters,
	};
	await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally {
	await s.stop();
}
