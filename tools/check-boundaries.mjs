import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { core, plugin } = JSON.parse(
	await readFile("dist/build-meta.json", "utf8"),
);
for (const build of [core, plugin]) {
	for (const path of Object.keys(build.inputs)) {
		assert.ok(
			path.startsWith("src/") || path.startsWith("node_modules/"),
			`Unexpected module: ${path}`,
		);
		assert.ok(
			!/mdsync|packages\/|core\/crypto|core\/protocol/.test(path),
			`Upstream system dependency: ${path}`,
		);
	}
}
assert.ok(
	Object.keys(core.inputs).every((p) => !p.startsWith("src/ui/")),
	"Engine imports UI",
);
for (const build of [core, plugin]) {
	const mergeInputs = Object.entries(build.inputs).filter(([path]) =>
		path.startsWith("src/merge/"),
	);
	assert.deepEqual(mergeInputs.map(([path]) => path).sort(), [
		"src/merge/index.ts",
		"src/merge/limits.ts",
		"src/merge/text-merge.ts",
	]);
	for (const [path, input] of mergeInputs) {
		for (const dependency of input.imports)
			assert.ok(
				!dependency.external &&
					(dependency.path.startsWith("src/merge/") ||
						(dependency.path.startsWith("node_modules/") &&
							dependency.path.includes("diff-sequences"))),
				`Pure merge module imports an effectful dependency: ${path} -> ${dependency.path}`,
			);
	}
}
const deps = JSON.parse(await readFile("package.json", "utf8")).dependencies;
assert.deepEqual(Object.keys(deps).sort(), ["@jest/diff-sequences", "yaml"]);
console.log(
	"Standalone boundaries verified: pure merge module; no MDSync package or system imports.",
);
