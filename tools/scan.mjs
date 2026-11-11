import { createHash } from "node:crypto";
import { lstat, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import core from "../dist/sync-core.cjs";

const root = process.argv[2];
if (!root)
	throw new Error(
		"Usage: node tools/scan.mjs /absolute/read-only/vault [report.json]",
	);
let files = 0,
	bytes = 0,
	markdown = 0;
const metadata = createHash("sha256");
async function inventory(dir) {
	for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
		(a, b) => a.name.localeCompare(b.name),
	)) {
		const p = join(dir, entry.name);
		const s = await lstat(p);
		metadata.update(JSON.stringify([p, s.size, s.mtimeMs, s.ctimeMs]));
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) await inventory(p);
		else if (entry.isFile()) {
			files++;
			bytes += s.size;
			if (entry.name.toLowerCase().endsWith(".md")) markdown++;
		}
	}
}
const start = performance.now();
await inventory(root);
const before = metadata.digest("hex");
const store = new core.LocalStore(root);
let peak = process.memoryUsage().rss;
const timer = setInterval(
	() => (peak = Math.max(peak, process.memoryUsage().rss)),
	10,
);
const t = performance.now();
const result = await core.scan(store);
clearInterval(timer);
const content = createHash("sha256");
for (const [p, v] of Object.entries(result.files).sort(([a], [b]) =>
	a.localeCompare(b),
))
	content.update(JSON.stringify([p, v.hash]));
const report = {
	root,
	readOnly: true,
	metadata: { files, bytes, markdown, fingerprint: before },
	scope: {
		files: Object.keys(result.files).length,
		bytes: result.bytes,
		excludedRoots: result.excluded.length,
		unknown: Object.keys(result.errors).length,
	},
	scanSeconds: (performance.now() - t) / 1000,
	totalSeconds: (performance.now() - start) / 1000,
	peakRssMiB: peak / 1024 / 1024,
	streamBufferKiB: 64,
	concurrency: 2,
	aggregateContentDigest: content.digest("hex"),
	sameFilesystem: (await stat(root)).dev === (await stat(".")).dev,
	exclusions: core.EXCLUDED,
	ordinaryWrites: 0,
	stateWrites: 0,
	networkRequests: 0,
};
if (process.argv[3])
	await writeFile(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
