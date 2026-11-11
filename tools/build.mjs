import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

// Obsidian installs main.js/manifest.json/styles.css only. Keep the complete
// third-party notices inside main.js, not solely as optional release assets.
const noticeFiles = [
	"LICENSE",
	"THIRD_PARTY_NOTICES.md",
	"node_modules/@jest/diff-sequences/LICENSE",
	"node_modules/yaml/LICENSE",
];
const licenseBanner =
	"/*!\n" +
	(
		await Promise.all(
			noticeFiles.map(
				async (path) =>
					`--- ${path.split("/").at(-1)} ---\n${await readFile(path, "utf8")}`,
			),
		)
	)
		.join("\n\n")
		.replaceAll("*/", "* /") +
	"\n*/";

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
await mkdir("dist/vault-content-sync", { recursive: true });
const core = await esbuild.build({
	...options,
	entryPoints: ["src/sync/core.ts"],
	outfile: "dist/sync-core.cjs",
});
const plugin = await esbuild.build({
	...options,
	entryPoints: ["src/main.ts"],
	outfile: "dist/vault-content-sync/main.js",
	minify: true,
	banner: { js: licenseBanner },
});
await esbuild.build({
	entryPoints: ["src/styles.css"],
	bundle: true,
	outfile: "dist/vault-content-sync/styles.css",
});
for (const [from, name] of [
	["manifest.json", "manifest.json"],
	["LICENSE", "LICENSE"],
	["THIRD_PARTY_NOTICES.md", "NOTICE.md"],
	["node_modules/@jest/diff-sequences/LICENSE", "LICENSE-Jest"],
	["node_modules/yaml/LICENSE", "LICENSE-yaml"],
])
	await copyFile(from, `dist/vault-content-sync/${name}`);
await writeFile(
	"dist/build-meta.json",
	JSON.stringify({ core: core.metafile, plugin: plugin.metafile }, null, 2),
);
