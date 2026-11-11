import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
// @ts-expect-error jsdom is a test-only installed JavaScript dependency.
import { JSDOM } from "jsdom";
import { afterEach } from "vitest";
import { PlainEngine } from "@/sync/engine";
import { LocalStore } from "@/sync/files";
import { WebDavStore } from "@/sync/webdav";
// Synthetic HTTP harness shared with CLI demo.
import { startMock } from "../../tools/mock-server.mjs";

globalThis.DOMParser = new JSDOM().window.DOMParser;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const f of cleanups.splice(0).reverse()) await f();
});
export async function setup() {
	await mkdir("runtime/tests", { recursive: true });
	const dir = await mkdtemp(join("runtime/tests", "plain-test-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const server = await startMock();
	cleanups.push(() => server.stop());
	const a = join(dir, "a"),
		b = join(dir, "b");
	await mkdir(a);
	await mkdir(b);
	const remote = new WebDavStore({ url: server.url, isolatedMock: true });
	return {
		dir,
		a,
		b,
		server,
		remote,
		A: new PlainEngine(new LocalStore(a), remote, a),
		B: new PlainEngine(new LocalStore(b), remote, b),
	};
}
export async function sync(e: PlainEngine) {
	return e.run(await e.preview());
}
export async function seed(s: Awaited<ReturnType<typeof setup>>) {
	await writeFile(join(s.a, "n.md"), "base");
	await sync(s.A);
	await sync(s.B);
}
