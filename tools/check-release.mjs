import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
for (const field of [
	"id",
	"name",
	"version",
	"minAppVersion",
	"description",
	"author",
])
	assert.ok(
		typeof manifest[field] === "string" && manifest[field].trim(),
		`Missing manifest ${field}`,
	);
assert.match(manifest.id, /^[a-z]+(?:-[a-z]+)*$/);
assert.ok(!manifest.id.includes("obsidian") && !manifest.id.endsWith("plugin"));
assert.match(manifest.name, /^[A-Za-z0-9 ()+-]+$/);
assert.ok(!/obsidian|plugin/i.test(manifest.name));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.isDesktopOnly, true, "This bundle requires Node.js APIs");
assert.ok(
	manifest.description.length <= 250 && manifest.description.endsWith("."),
);
const folder = `dist/${manifest.id}`;
assert.equal(
	await readFile(`${folder}/manifest.json`, "utf8"),
	await readFile("manifest.json", "utf8"),
);
const script = await readFile(`${folder}/main.js`, "utf8");
for (const [source, asset] of [
	["LICENSE", "LICENSE"],
	["THIRD_PARTY_NOTICES.md", "NOTICE.md"],
	["node_modules/@jest/diff-sequences/LICENSE", "LICENSE-Jest"],
	["node_modules/yaml/LICENSE", "LICENSE-yaml"],
]) {
	const text = await readFile(source, "utf8");
	assert.equal(await readFile(`${folder}/${asset}`, "utf8"), text);
	assert.ok(
		script.includes(text.trim().replaceAll("*/", "* /")),
		`Missing embedded notice: ${asset}`,
	);
}
const assets = [
	"main.js",
	"manifest.json",
	"styles.css",
	"LICENSE",
	"NOTICE.md",
	"LICENSE-Jest",
	"LICENSE-yaml",
];
const sums = [];
for (const file of assets) {
	const data = await readFile(`${folder}/${file}`);
	assert.ok(data.length, `Empty ${file}`);
	sums.push(`${createHash("sha256").update(data).digest("hex")}  ${file}`);
}
await writeFile(`${folder}/SHA256SUMS.txt`, `${sums.join("\n")}\n`);
console.log(
	`Release assets verified: ${manifest.name} ${manifest.version}; desktop Obsidian >= ${manifest.minAppVersion}.`,
);
