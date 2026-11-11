import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import core from "../dist/sync-core.cjs";

globalThis.DOMParser = new JSDOM().window.DOMParser;
const [command, ...args] = process.argv.slice(2);
const option = (name) =>
	args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
	const vault = option("vault");
	const url = option("url") ?? process.env.PLAIN_DAV_URL;
	if (!vault || !url)
		throw new Error(
			"Usage: cli.mjs preview|sync|recover|resolve --vault=/absolute/path --url=https://explicit-collection/ [--isolated-mock] [--path=note.md --choose=local|remote|merge]",
		);
	const root = resolve(vault);
	const mock = args.includes("--isolated-mock");
	const remote = new core.WebDavStore({
		url,
		username: process.env.PLAIN_DAV_USER,
		password: process.env.PLAIN_DAV_PASSWORD,
		isolatedMock: mock,
	});
	const engine = new core.PlainEngine(new core.LocalStore(root), remote, root);
	if (command !== "preview" && (!mock || !remote.writable))
		throw new Error(
			"This build permits mutations only with --isolated-mock on a loopback test service",
		);
	if (command === "preview")
		console.log(JSON.stringify(await engine.preview(), null, 2));
	else if (command === "sync")
		console.log(
			JSON.stringify(await engine.run(await engine.preview()), null, 2),
		);
	else if (command === "recover") {
		const state = await engine.recover();
		console.log(
			JSON.stringify({ pending: Object.keys(state.pending) }, null, 2),
		);
	} else if (command === "resolve") {
		const path = option("path"),
			choice = option("choose");
		const row = (await engine.preview()).rows.find((r) => r.path === path);
		if (!row || !["local", "remote", "merge"].includes(choice))
			throw new Error("Choose an existing conflict and local, remote or merge");
		await engine.resolve(row, choice);
		console.log(JSON.stringify({ resolved: path }));
	} else throw new Error("Unknown command");
} catch (e) {
	console.error(e.message);
	process.exitCode = 1;
}
