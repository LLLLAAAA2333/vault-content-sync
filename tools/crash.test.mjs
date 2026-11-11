import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import core from "../dist/sync-core.cjs";
import { startMock } from "./mock-server.mjs";

globalThis.DOMParser = new JSDOM().window.DOMParser;
test("SIGKILL after durable intent, followed by delayed server commit and dead-lock recovery", async () => {
	await mkdir("runtime/tests", { recursive: true });
	const root = await mkdtemp(resolve("runtime/tests/process-crash-"));
	await writeFile(join(root, "n.md"), "synthetic new bytes");
	const s = await startMock();
	let enter, release;
	const hit = new Promise((r) => (enter = r)),
		gate = new Promise((r) => (release = r));
	s.hooks.beforeCommit = async () => {
		enter();
		await gate;
	};
	const script = `import {JSDOM} from 'jsdom';import core from './dist/sync-core.cjs';globalThis.DOMParser=new JSDOM().window.DOMParser;const root=process.env.PLAIN_CRASH_VAULT;const e=new core.PlainEngine(new core.LocalStore(root),new core.WebDavStore({url:process.env.PLAIN_CRASH_URL,isolatedMock:true}),root);await e.run(await e.preview());`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: process.cwd(),
		env: { ...process.env, PLAIN_CRASH_VAULT: root, PLAIN_CRASH_URL: s.url },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stderr.on("data", (c) => (output += c));
	try {
		await Promise.race([
			hit,
			once(child, "exit").then(() => {
				throw new Error(`child exited early: ${output}`);
			}),
		]);
		const done = once(child, "exit");
		child.kill("SIGKILL");
		await done;
		release();
		for (let i = 0; i < 100 && !s.files.has("n.md"); i++)
			await new Promise((r) => setTimeout(r, 10));
		const e = new core.PlainEngine(
			new core.LocalStore(root),
			new core.WebDavStore({ url: s.url, isolatedMock: true }),
			root,
		);
		await e.recover();
		assert.equal(Object.keys((await e.journal.load()).pending).length, 0);
		assert.equal(s.counters.put, 1);
		assert.equal(
			await readFile(join(root, "n.md"), "utf8"),
			"synthetic new bytes",
		);
	} finally {
		release();
		if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
		await s.stop();
		await rm(root, { recursive: true, force: true });
	}
});
