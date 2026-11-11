import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

const options = {
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	external: [
		"obsidian",
		"electron",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	alias: { "@": "./src" },
	metafile: true,
};
await mkdir("dist/vault-weave", { recursive: true });
const core = await esbuild.build({
	...options,
	entryPoints: ["src/sync/core.ts"],
	outfile: "dist/sync-core.cjs",
});
const plugin = await esbuild.build({
	...options,
	entryPoints: ["src/main.ts"],
	outfile: "dist/vault-weave/main.js",
	minify: true,
});
await esbuild.build({
	entryPoints: ["src/styles.css"],
	bundle: true,
	outfile: "dist/vault-weave/styles.css",
});
for (const [from, name] of [
	["manifest.json", "manifest.json"],
	["LICENSE", "LICENSE"],
	["THIRD_PARTY_NOTICES.md", "NOTICE.md"],
	["node_modules/@jest/diff-sequences/LICENSE", "LICENSE-Jest"],
	["node_modules/yaml/LICENSE", "LICENSE-yaml"],
])
	await copyFile(from, `dist/vault-weave/${name}`);
await writeFile(
	"dist/build-meta.json",
	JSON.stringify({ core: core.metafile, plugin: plugin.metafile }, null, 2),
);
