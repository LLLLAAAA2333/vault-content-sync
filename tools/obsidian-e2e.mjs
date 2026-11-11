import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { startMock } from "./mock-server.mjs";

const root = resolve("runtime", `obsidian-${Date.now()}`),
	vault = join(root, "vault"),
	profile = join(root, "profile");
const plugin = join(vault, ".obsidian/plugins/vault-content-sync");
await mkdir(plugin, { recursive: true });
await mkdir(profile, { recursive: true });
const artifactRoot = join("artifacts", `obsidian-${Date.now()}`);
await mkdir(artifactRoot, { recursive: true });
for (const file of ["main.js", "styles.css", "manifest.json"])
	await copyFile(join("dist/vault-content-sync", file), join(plugin, file));
const server = await startMock();
let child, browser, page, mainPage;
await writeFile(
	join(plugin, "data.json"),
	JSON.stringify({ url: server.url, username: "", mock: true }),
);
await writeFile(
	join(vault, ".obsidian/community-plugins.json"),
	JSON.stringify(["vault-content-sync"]),
);
await writeFile(
	join(profile, "obsidian.json"),
	JSON.stringify({
		vaults: { "1234567890abcdef": { path: vault, ts: Date.now(), open: true } },
	}),
);
await writeFile(join(vault, "same.md"), "same bytes".repeat(200));
await writeFile(join(vault, "conflict.md"), "local choice");
await writeFile(join(vault, "upload.md"), "upload");
server.put("same.md", "same bytes".repeat(200));
server.put("conflict.md", "remote choice");
server.put("attachment.custom", Buffer.from([0, 255, 10]));
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
	const s = net.createServer();
	s.listen(0, "127.0.0.1");
	await once(s, "listening");
	const p = s.address().port;
	await new Promise((r) => s.close(r));
	return p;
}
async function start() {
	const p = await port();
	child = spawn(
		"/Applications/Obsidian.app/Contents/MacOS/Obsidian",
		[`--user-data-dir=${profile}`, `--remote-debugging-port=${p}`],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout.on("data", () => {});
	child.stderr.on("data", () => {});
	for (let i = 0; i < 120; i++) {
		if (child.exitCode !== null) throw new Error("Isolated Obsidian exited");
		try {
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`);
			page = browser
				.contexts()
				.flatMap((c) => c.pages())
				.find((p) => p.url().startsWith("app://obsidian.md"));
			if (page) break;
			await browser.close();
		} catch {}
		await sleep(250);
	}
	if (!page) throw new Error("No isolated Obsidian page");
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	for (let i = 0; i < 120; i++) {
		for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
			const trust = candidate.getByRole("button", {
				name: /trust author and enable plugins|信任作者.*启用|信任.*启用插件/i,
			});
			if (await trust.isVisible()) await trust.click();
		}
		if (i === 40)
			await page.evaluate(async (expected) => {
				if (app.vault.adapter.getBasePath() !== expected)
					throw new Error("Wrong test vault");
				await app.plugins.enablePluginAndSave("vault-content-sync");
			}, vault);

		if (
			await page.evaluate(
				() =>
					typeof app !== "undefined" &&
					Boolean(app?.plugins?.plugins?.["vault-content-sync"]?.host),
			)
		)
			break;
		await sleep(250);
	}
	assert.equal(
		await page.evaluate(() => app.vault.adapter.getBasePath()),
		vault,
	);
	if (
		!(await page.evaluate(() =>
			Boolean(app.plugins.plugins["vault-content-sync"]),
		))
	) {
		await page.screenshot({
			path: join(artifactRoot, "obsidian-boot-failure.png"),
		});
		console.log(
			JSON.stringify({ errors, body: await page.locator("body").innerText() }),
		);
		throw new Error("Plugin failed to load");
	}
}
async function stop() {
	if (browser) await browser.close().catch(() => {});
	if (child && child.exitCode === null) {
		const done = once(child, "exit");
		child.kill("SIGTERM");
		await done;
	}
	page = undefined;
	browser = undefined;
}
async function confirmButton(name) {
	for (let i = 0; i < 100; i++) {
		for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
			const button = candidate.getByRole("button", { name, exact: true });
			if (await button.isVisible()) {
				await button.click();
				return;
			}
		}
		await sleep(100);
	}
	throw new Error("Confirmation window not found");
}
async function open() {
	mainPage = page;
	await mainPage.waitForFunction(() => app.workspace.layoutReady === true);
	await mainPage.getByLabel("Vault Content Sync", { exact: true }).click();
	for (let i = 0; i < 100; i++) {
		const candidates = browser.contexts().flatMap((c) => c.pages());
		for (const candidate of candidates)
			if (await candidate.locator(".ocs-modal").count()) {
				page = candidate;
				break;
			}
		if (await page.locator(".ocs-modal").count()) break;
		await sleep(100);
	}

	await page.getByRole("button", { name: "完整核验 / 刷新预览" }).click();
	await page.waitForFunction(
		() =>
			document.querySelector(".ocs-summary") &&
			!document.querySelector(".ocs-status")?.textContent.includes("正在"),
	);
}
try {
	await start();
	await open();
	const configuration = await mainPage.evaluate(() => {
		const engine = app.plugins.plugins["vault-content-sync"].host.engine();
		return {
			dir: app.vault.configDir,
			local: engine.local.excludedRoots,
			remote: engine.remote.excludedRoots,
		};
	});
	assert.deepEqual(configuration.local, [configuration.dir]);
	assert.deepEqual(configuration.remote, [configuration.dir]);
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);
	await page.screenshot({ path: join(artifactRoot, "obsidian-preview.png") });
	await page.setViewportSize({ width: 560, height: 700 });
	await page.screenshot({ path: join(artifactRoot, "obsidian-narrow.png") });
	await page.setViewportSize({ width: 900, height: 700 });
	await page.getByRole("button", { name: "比较内容", exact: true }).click();
	let comparison;
	for (let i = 0; i < 100 && !comparison; i++) {
		for (const candidate of browser.contexts().flatMap((c) => c.pages()))
			if (await candidate.locator('textarea[aria-label="本地"]').count()) {
				comparison = candidate;
				break;
			}
		if (!comparison) await sleep(100);
	}
	if (!comparison) throw new Error("Comparison window missing");
	assert.equal(
		await comparison.locator('textarea[aria-label="本地"]').inputValue(),
		"local choice",
	);
	assert.equal(
		await comparison.locator('textarea[aria-label="远端"]').inputValue(),
		"remote choice",
	);
	await comparison.screenshot({
		path: join(artifactRoot, "obsidian-comparison.png"),
	});
	await comparison.locator('textarea[aria-label="本地"]').click();
	await comparison.keyboard.press("Escape");
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);

	assert.match(
		await page.locator(".ocs-summary").innerText(),
		/计划改写 2 个文件 · 冲突 1/,
	);
	await page.getByRole("button", { name: "执行当前计划", exact: true }).click();
	await confirmButton("返回预览");
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);
	assert.equal(server.counters.put, 0);
	await page.getByRole("button", { name: "执行当前计划", exact: true }).click();
	await confirmButton("执行同步");
	await page.waitForFunction(() =>
		document
			.querySelector(".ocs-summary")
			?.textContent.includes("计划改写 0 个文件"),
	);
	assert.deepEqual(
		await readFile(join(vault, "attachment.custom")),
		Buffer.from([0, 255, 10]),
	);
	await page.getByRole("button", { name: "采用远端", exact: true }).click();
	await confirmButton("应用选择");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-summary")?.textContent.includes("冲突 0"),
	);
	assert.equal(
		await readFile(join(vault, "conflict.md"), "utf8"),
		"remote choice",
	);

	// Establish a synthetic shared baseline through the same native controls.
	const mergeNote = (time, body) => `---\nupdated: ${time}\n---\n${body}`;
	async function refresh() {
		await page.getByRole("button", { name: "完整核验 / 刷新预览" }).click();
		await page.waitForFunction(
			() =>
				!document.querySelector(".ocs-status")?.textContent.includes("正在"),
		);
	}
	await writeFile(join(vault, "merge.md"), mergeNote("local", "a\r\nb\n"));
	await refresh();
	await page.getByRole("button", { name: "执行当前计划", exact: true }).click();
	await confirmButton("执行同步");
	await page.waitForFunction(() =>
		document
			.querySelector(".ocs-summary")
			?.textContent.includes("计划改写 0 个文件"),
	);
	await writeFile(join(vault, "merge.md"), mergeNote("local2", "A\r\nb\n"));
	server.put("merge.md", "a\r\nB\n");
	await refresh();
	await page.getByRole("button", { name: "合并文本", exact: true }).click();
	await confirmButton("应用选择");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-summary")?.textContent.includes("冲突 0"),
	);
	assert.equal(
		await readFile(join(vault, "merge.md"), "utf8"),
		mergeNote("local2", "A\r\nB\n"),
	);
	assert.equal(server.files.get("merge.md").body.toString(), "A\r\nB\n");
	await page.screenshot({ path: join(artifactRoot, "obsidian-merged.png") });

	await writeFile(join(vault, "merge.md"), mergeNote("local3", "L\r\nB\n"));
	server.put("merge.md", "R\r\nB\n");
	await refresh();
	const beforeConflict = server.counters.put;
	await page.getByRole("button", { name: "合并文本", exact: true }).click();
	await confirmButton("应用选择");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-status")?.textContent.includes("Overlapping"),
	);
	assert.equal(server.counters.put, beforeConflict);
	assert.equal(
		await readFile(join(vault, "merge.md"), "utf8"),
		mergeNote("local3", "L\r\nB\n"),
	);
	assert.equal(server.files.get("merge.md").body.toString(), "R\r\nB\n");
	await page.screenshot({
		path: join(artifactRoot, "obsidian-merge-conflict.png"),
	});
	await page.getByRole("button", { name: "采用远端", exact: true }).click();
	await confirmButton("应用选择");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-summary")?.textContent.includes("冲突 0"),
	);

	await writeFile(
		join(vault, "merge.md"),
		mergeNote("local4", "RECOVER\r\nB\n"),
	);
	server.put("merge.md", "R\r\nRECOVERED\n");
	await refresh();
	server.hooks.loseResponse = true;
	await page.getByRole("button", { name: "合并文本", exact: true }).click();
	await confirmButton("应用选择");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-status")?.textContent.includes("操作已停止"),
	);
	const writes = server.counters.put;
	await stop();
	await start();
	await open();
	await page.getByRole("button", { name: "恢复未完成操作" }).click();
	await page.waitForFunction(
		() =>
			document.querySelector(".ocs-summary")?.textContent.includes("冲突 0") &&
			!document.querySelector(".ocs-status")?.textContent.includes("正在"),
	);
	assert.equal(server.counters.put, writes);
	assert.equal(
		await readFile(join(vault, "merge.md"), "utf8"),
		mergeNote("local4", "RECOVER\r\nRECOVERED\n"),
	);
	assert.equal(
		server.files.get("merge.md").body.toString(),
		"RECOVER\r\nRECOVERED\n",
	);
	await page.screenshot({ path: join(artifactRoot, "obsidian-recovered.png") });
	assert.deepEqual(errors, []);
	const result = {
		passed: true,
		root,
		vault,
		pluginId: "vault-content-sync",
		obsidian: "1.14.4 (visible app title)",
		checks: [
			"preview creates no metadata",
			"host configuration directory is excluded on both sides",
			"native preview and execute controls",
			"cancel confirmation produces zero writes",
			"read-only text comparison and narrow desktop layout",
			"attachment bytes",
			"explicit conflict resolution",
			"native text merge: adjacent replacements, exact mixed endings, local updated",
			"overlap merge refusal leaves both sides unchanged",
			"lost merge response visible error",
			"real process restart and idempotent merged-target recovery",
		],
		errors,
		requests: server.counters,
	};
	await writeFile(
		join(artifactRoot, "obsidian-e2e.json"),
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	if (page) {
		await page.screenshot({ path: join(artifactRoot, "obsidian-failure.png") });
		console.log(
			JSON.stringify({ errors, body: await page.locator("body").innerText() }),
		);
	}
	throw error;
} finally {
	await stop();
	await server.stop();
}
