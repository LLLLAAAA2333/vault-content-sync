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
await writeFile(
	join(vault, "same.md"),
	"# 合成测试笔记\n\n这里是正常编辑的笔记区域。\n\n## 今日安排\n\n- 核验两端内容\n- 在侧栏查看冲突\n- 保留本机 updated\n",
);
await writeFile(join(vault, "conflict.md"), "local choice");
await writeFile(join(vault, "upload.md"), "upload");
server.put(
	"same.md",
	"# 合成测试笔记\n\n这里是正常编辑的笔记区域。\n\n## 今日安排\n\n- 核验两端内容\n- 在侧栏查看冲突\n- 保留本机 updated\n",
);
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
async function menuAction(name, path) {
	await page
		.getByRole("button", {
			name: path ? `文件操作：${path}` : "更多操作",
			exact: true,
		})
		.click();
	await page
		.locator(".menu-item-title")
		.getByText(name, { exact: true })
		.click();
}
async function open(inspectConnection = false) {
	mainPage = page;
	await mainPage.waitForFunction(() => app.workspace.layoutReady === true);
	await mainPage
		.locator('.side-dock-ribbon-action[aria-label="Vault Content Sync"]')
		.click();
	for (let i = 0; i < 100; i++) {
		const candidates = browser.contexts().flatMap((c) => c.pages());
		for (const candidate of candidates)
			if (await candidate.locator(".ocs-sidebar").count()) {
				page = candidate;
				break;
			}
		if (await page.locator(".ocs-sidebar").count()) break;
		await sleep(100);
	}

	assert.equal(
		await page.getByRole("button", { name: "测试连接", exact: true }).count(),
		0,
	);
	assert.equal(await page.locator(".ocs-conflict-detail").count(), 0);
	if (inspectConnection) server.hooks.readDelay = 150;
	await page.getByRole("button", { name: "核验内容" }).click();
	if (inspectConnection) {
		await page.waitForFunction(() =>
			document
				.querySelector(".ocs-status")
				?.textContent.includes("正在核验远端"),
		);
		assert.equal(await page.getByRole("progressbar").count(), 1);
		await page.screenshot({
			path: join(artifactRoot, "obsidian-progress.png"),
		});
		server.hooks.readDelay = 0;
	}
	await page.waitForFunction(
		() =>
			document.querySelector(".ocs-summary") &&
			!document.querySelector(".ocs-status")?.textContent.includes("正在"),
	);
}
try {
	await start();
	await page.waitForFunction(() => app.workspace.layoutReady === true);
	await page.evaluate(() => {
		app.setting.open();
		app.setting.openTabById("vault-content-sync");
	});
	let settingsPage;
	for (let i = 0; i < 100 && !settingsPage; i++) {
		for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
			if (
				await candidate
					.getByPlaceholder("https://dav.example.com/notes/")
					.isVisible()
			)
				settingsPage = candidate;
		}
		if (!settingsPage) await sleep(100);
	}
	assert.ok(settingsPage, "Declarative settings must render in the host");
	const endpoint = settingsPage.getByPlaceholder(
		"https://dav.example.com/notes/",
	);
	assert.equal(await endpoint.inputValue(), server.url);
	await endpoint.fill("https://user:synthetic-secret@dav.example.test/notes/");
	assert.equal(await endpoint.getAttribute("aria-invalid"), "true");
	assert.equal(
		await page.evaluate(
			() => app.plugins.plugins["vault-content-sync"].host.settings.url,
		),
		server.url,
	);
	assert.equal(server.counters.propfind, 0);
	await settingsPage
		.getByRole("button", { name: "测试连接", exact: true })
		.click();
	await settingsPage
		.getByText("请先在设置中填写有效的 WebDAV 文件夹地址。", { exact: true })
		.waitFor();
	assert.equal(server.counters.propfind, 0);
	await endpoint.fill(server.url);
	await settingsPage
		.getByRole("button", { name: "测试连接", exact: true })
		.click();
	await settingsPage
		.getByText("连接正常 · 目录可读，未读取笔记", { exact: true })
		.waitFor();
	assert.equal(server.counters.propfind, 1);
	server.hooks.forbidden = "";
	await settingsPage
		.getByRole("button", { name: "测试连接", exact: true })
		.click();
	await settingsPage.getByText(/没有访问权限/).waitFor();
	assert.equal(server.counters.get, 0);
	assert.equal(server.counters.put, 0);
	assert.equal(server.counters.delete, 0);
	server.hooks.forbidden = null;
	const password = settingsPage.locator('input[type="password"]');
	await password.fill("synthetic-session-password");
	await settingsPage
		.getByText("当前配置尚未测试。只检查目录，不读取笔记、不写入文件。", {
			exact: true,
		})
		.waitFor();
	assert.equal(
		await page.evaluate(
			() => app.plugins.plugins["vault-content-sync"].host.password,
		),
		"synthetic-session-password",
	);
	await page.evaluate(() =>
		app.plugins.plugins["vault-content-sync"].host.save(),
	);
	const savedSettings = JSON.parse(
		await readFile(join(plugin, "data.json"), "utf8"),
	);
	assert.deepEqual(savedSettings, {
		url: server.url,
		username: "",
		mock: true,
	});
	const settingNames = await page.evaluate(() => {
		const tab = app.setting.pluginTabs.find(
			(tab) => tab.id === "vault-content-sync",
		);
		return tab.settingItems.map((item) => ({
			name: item.name,
			aliases: item.aliases,
		}));
	});
	assert.ok(settingNames.some((item) => item.aliases?.includes("WebDAV")));
	assert.ok(settingNames.some((item) => item.aliases?.includes("password")));
	await settingsPage.screenshot({
		path: join(artifactRoot, "obsidian-settings.png"),
	});
	await password.fill("");
	await page.evaluate(() => app.setting.close());
	assert.equal(server.counters.get, 0);
	assert.equal(server.counters.put, 0);
	await page.evaluate(async () => {
		const file = app.vault.getFileByPath("same.md");
		if (!file) throw new Error("Synthetic editor fixture missing");
		await app.workspace.getLeaf(false).openFile(file);
	});
	await open(true);
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
	await mainPage.evaluate(() => {
		app.plugins.plugins["vault-content-sync"].host.settings.mock = false;
	});
	await page.evaluate(() =>
		app.workspace
			.getLeavesOfType("vault-content-sync-changes")[0]
			.view.refreshPresentation(),
	);
	for (const name of [
		"执行当前计划",
		"恢复未完成操作",
		"采用本地",
		"采用远端",
		"合并文本",
	])
		assert.equal(
			await page.getByRole("button", { name, exact: true }).count(),
			0,
		);
	await page.getByRole("button", { name: "更多操作", exact: true }).click();
	assert.equal(
		await page
			.locator(".menu-item-title")
			.filter({ hasText: /^执行当前计划$/ })
			.count(),
		0,
	);
	await sleep(100);
	await page.keyboard.press("Escape");
	await sleep(100);
	await page
		.getByRole("button", { name: "文件操作：conflict.md", exact: true })
		.press("Enter");
	assert.equal(
		await page
			.locator(".menu-item-title")
			.filter({ hasText: /^采用远端$/ })
			.count(),
		0,
	);
	assert.equal(
		await page
			.locator(".menu-item-title")
			.filter({ hasText: /^比较内容$/ })
			.count(),
		1,
	);
	await sleep(100);
	await page.keyboard.press("Escape");
	await sleep(100);
	await page.screenshot({ path: join(artifactRoot, "obsidian-readonly.png") });
	await mainPage.evaluate(() => {
		app.plugins.plugins["vault-content-sync"].host.settings.mock = true;
	});
	await page.evaluate(() =>
		app.workspace
			.getLeavesOfType("vault-content-sync-changes")[0]
			.view.refreshPresentation(),
	);
	await page.screenshot({ path: join(artifactRoot, "obsidian-preview.png") });
	await page.getByRole("button", { name: "筛选文件", exact: true }).click();
	const search = page.getByRole("textbox", {
		name: "筛选文件或路径",
		exact: true,
	});
	await search.fill("conflict");
	assert.equal(await page.locator(".ocs-row").count(), 1);
	await search.fill("missing-synthetic-path");
	assert.equal(await page.locator(".ocs-row").count(), 0);
	await search.fill("");
	await page.getByRole("combobox", { name: "显示范围" }).selectOption("equal");
	assert.equal(await page.locator(".ocs-filename").innerText(), "same.md");
	await page
		.getByRole("combobox", { name: "显示范围" })
		.selectOption("changes");
	await page.evaluate(() => {
		document.body.classList.remove("theme-dark");
		document.body.classList.add("theme-light");
	});
	await page.screenshot({ path: join(artifactRoot, "obsidian-light.png") });
	await page.evaluate(() => {
		document.body.classList.remove("theme-light");
		document.body.classList.add("theme-dark");
	});
	await page.screenshot({ path: join(artifactRoot, "obsidian-dark.png") });
	await page.setViewportSize({ width: 560, height: 700 });
	assert.equal(
		await page
			.locator(".ocs-content")
			.evaluate((el) => el.scrollWidth <= el.clientWidth),
		true,
	);
	await page.screenshot({ path: join(artifactRoot, "obsidian-narrow.png") });
	await page.setViewportSize({ width: 900, height: 700 });
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page
		.getByText(
			"没有共同版本，无法确定冲突行。以下仅为两端内容预览，不会自动合并。",
			{ exact: true },
		)
		.waitFor();
	assert.equal(
		await page.getByLabel("本地冲突片段", { exact: true }).innerText(),
		"local choice",
	);
	assert.equal(
		await page.getByLabel("远端冲突片段", { exact: true }).innerText(),
		"remote choice",
	);
	assert.equal(
		await mainPage.evaluate(
			() => app.workspace.getLeavesOfType("vault-content-sync-changes").length,
		),
		1,
	);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-sidebar-no-base.png"),
	});
	assert.equal(
		await page
			.getByRole("button", { name: "快速预览：conflict.md", exact: true })
			.evaluate((el) => el === document.activeElement),
		true,
	);
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.press("Enter");
	assert.equal(await page.locator(".ocs-conflict-detail").count(), 0);
	server.hooks.readDelay = 150;
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page.getByText("正在读取并定位冲突…", { exact: true }).waitFor();
	// Keep the next file-operation control mounted across the delayed response.
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.press("Tab");
	const fileMenu = page.getByRole("button", {
		name: "文件操作：conflict.md",
		exact: true,
	});
	assert.equal(
		await fileMenu.evaluate((el) => el === document.activeElement),
		true,
	);
	await page
		.getByText(
			"没有共同版本，无法确定冲突行。以下仅为两端内容预览，不会自动合并。",
			{ exact: true },
		)
		.waitFor();
	assert.equal(
		await fileMenu.evaluate((el) => el === document.activeElement),
		true,
	);
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page.getByText("正在读取并定位冲突…", { exact: true }).waitFor();
	const otherFile = page.getByRole("button", {
		name: "比较内容：upload.md",
		exact: true,
	});
	await otherFile.focus();
	await page
		.getByText(
			"没有共同版本，无法确定冲突行。以下仅为两端内容预览，不会自动合并。",
			{ exact: true },
		)
		.waitFor();
	assert.equal(
		await otherFile.evaluate((el) => el === document.activeElement),
		true,
	);
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page.getByText("正在读取并定位冲突…", { exact: true }).waitFor();
	await search.focus();
	await page
		.getByText(
			"没有共同版本，无法确定冲突行。以下仅为两端内容预览，不会自动合并。",
			{ exact: true },
		)
		.waitFor();
	assert.equal(
		await search.evaluate((el) => el === document.activeElement),
		true,
	);
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page
		.getByRole("button", { name: "快速预览：conflict.md", exact: true })
		.click();
	await page.getByText("正在读取并定位冲突…", { exact: true }).waitFor();

	await page.getByRole("button", { name: "核验内容", exact: true }).click();
	await page.waitForFunction(
		() =>
			document.querySelector(".ocs-summary") &&
			!document.querySelector(".ocs-status")?.textContent.includes("正在"),
	);
	server.hooks.readDelay = 0;
	assert.equal(await page.locator(".ocs-conflict-detail").count(), 0);
	await page
		.getByRole("button", { name: "比较内容：conflict.md", exact: true })
		.click();
	await page
		.getByRole("region", { name: "本地与远端差异", exact: true })
		.waitFor();
	assert.equal(await page.locator(".ocs-comparison-modal").count(), 0);
	assert.equal(
		await page.evaluate(
			() =>
				app.workspace.getLeavesOfType("vault-content-sync-comparison").length,
		),
		1,
	);
	assert.equal(
		await page.evaluate(
			() =>
				app.workspace
					.getLeavesOfType("vault-content-sync-comparison")[0]
					.getRoot() === app.workspace.rootSplit,
		),
		true,
	);
	assert.deepEqual(
		await page.evaluate(() =>
			app.workspace
				.getLeavesOfType("vault-content-sync-comparison")[0]
				.view.getState(),
		),
		{},
	);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-comparison.png"),
	});
	await page.evaluate(() => {
		document.body.classList.remove("theme-dark");
		document.body.classList.add("theme-light");
	});
	await page.screenshot({
		path: join(artifactRoot, "obsidian-comparison-light.png"),
	});
	await page.setViewportSize({ width: 560, height: 700 });
	assert.equal(
		await page
			.locator(".ocs-comparison-view")
			.evaluate((el) => el.scrollWidth <= el.clientWidth),
		true,
	);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-comparison-narrow.png"),
	});
	await page.setViewportSize({ width: 900, height: 700 });
	await page.evaluate(() => {
		document.body.classList.remove("theme-light");
		document.body.classList.add("theme-dark");
	});
	await page.locator(".ocs-compare-extras > summary").click();
	assert.equal(
		await page.getByLabel("本地原文", { exact: true }).inputValue(),
		"local choice",
	);
	assert.equal(
		await page.getByLabel("远端原文", { exact: true }).inputValue(),
		"remote choice",
	);
	assert.equal(
		await page.getByLabel("本地原文", { exact: true }).getAttribute("readonly"),
		"",
	);
	await page.locator(".ocs-compare-extras > summary").click();
	await page
		.getByRole("button", { name: "比较内容：upload.md", exact: true })
		.click();
	await page.locator('textarea[aria-label="本地"]').waitFor();
	assert.equal(
		await page.getByLabel("本地", { exact: true }).inputValue(),
		"upload",
	);
	assert.equal(
		await page.evaluate(
			() =>
				app.workspace.getLeavesOfType("vault-content-sync-comparison").length,
		),
		1,
	);
	// A slow earlier request cannot overwrite a later selection or steal focus.
	server.hooks.readDelay = 150;
	await page
		.getByRole("button", { name: "比较内容：conflict.md", exact: true })
		.click();
	await page
		.getByRole("button", { name: "比较内容：upload.md", exact: true })
		.click();
	await page.getByLabel("本地", { exact: true }).waitFor();
	await search.focus();
	await sleep(350);
	assert.equal(
		await page.locator(".ocs-compare-path").innerText(),
		"upload.md",
	);
	assert.equal(
		await search.evaluate((el) => el === document.activeElement),
		true,
	);
	server.hooks.readDelay = 0;
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);

	assert.match(
		await page.locator(".ocs-summary").innerText(),
		/待同步 2 · 冲突 1/,
	);
	await menuAction("执行当前计划");
	await confirmButton("返回预览");
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);
	assert.equal(server.counters.put, 0);
	await menuAction("执行当前计划");
	await confirmButton("执行同步");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-summary")?.textContent.includes("待同步 0"),
	);
	assert.deepEqual(
		await readFile(join(vault, "attachment.custom")),
		Buffer.from([0, 255, 10]),
	);
	await menuAction("采用远端", "conflict.md");
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
		await page.getByRole("button", { name: "核验内容" }).click();
		await page.waitForFunction(
			() =>
				!document.querySelector(".ocs-status")?.textContent.includes("正在"),
		);
	}
	await writeFile(join(vault, "merge.md"), mergeNote("local", "a\r\nb\n"));
	await refresh();
	await menuAction("执行当前计划");
	await confirmButton("执行同步");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-summary")?.textContent.includes("待同步 0"),
	);
	await writeFile(join(vault, "merge.md"), mergeNote("local2", "A\r\nb\n"));
	server.put("merge.md", "a\r\nB\n");
	await refresh();
	await menuAction("合并文本", "merge.md");
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
	await page
		.getByRole("button", { name: "快速预览：merge.md", exact: true })
		.click();
	await page.getByText("共同版本第 1 行", { exact: true }).waitFor();
	assert.equal(
		await page.getByLabel("本地冲突片段", { exact: true }).textContent(),
		"L\r\n",
	);
	assert.equal(
		await page.getByLabel("远端冲突片段", { exact: true }).textContent(),
		"R\r\n",
	);
	assert.equal(server.counters.put, beforeConflict);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-sidebar-conflict.png"),
	});

	await mainPage.evaluate(() => {
		app.plugins.plugins["vault-content-sync"].host.settings.mock = false;
	});
	await page.evaluate(() =>
		app.workspace
			.getLeavesOfType("vault-content-sync-changes")[0]
			.view.refreshPresentation(),
	);
	assert.equal(
		await page.getByRole("button", { name: "合并文本", exact: true }).count(),
		0,
	);
	assert.equal(
		await page.getByLabel("本地冲突片段", { exact: true }).textContent(),
		"L\r\n",
	);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-sidebar-readonly-conflict.png"),
	});
	await mainPage.evaluate(() => {
		app.plugins.plugins["vault-content-sync"].host.settings.mock = true;
	});
	await page.evaluate(() =>
		app.workspace
			.getLeavesOfType("vault-content-sync-changes")[0]
			.view.refreshPresentation(),
	);
	await menuAction("合并文本", "merge.md");
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
	await menuAction("采用远端", "merge.md");
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
	await menuAction("合并文本", "merge.md");
	await confirmButton("应用选择");
	await page.waitForFunction(() =>
		document.querySelector(".ocs-status")?.textContent.includes("操作已停止"),
	);
	const writes = server.counters.put;
	await stop();
	await start();
	await open();
	await menuAction("恢复未完成操作");
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
	// Presentation fallback and stale reads use synthetic files only.
	await writeFile(join(vault, "large.md"), "local\n".repeat(1100));
	server.put("large.md", "remote\n".repeat(1100));
	await refresh();
	const beforeDisplay = { ...server.counters };
	await page
		.getByRole("button", { name: "比较内容：large.md", exact: true })
		.click();
	await page
		.getByText("内容较多，已停止行高亮；以下仍可查看完整已读取文本。", {
			exact: true,
		})
		.waitFor();
	assert.equal(
		await page.getByLabel("本地", { exact: true }).inputValue(),
		"local\n".repeat(1100),
	);
	assert.equal(
		await page.getByLabel("远端", { exact: true }).inputValue(),
		"remote\n".repeat(1100),
	);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-comparison-limited.png"),
	});
	await writeFile(join(vault, "large.md"), "changed since preview");
	await page
		.getByRole("button", { name: "比较内容：large.md", exact: true })
		.click();
	await page
		.getByText(
			"无法读取当前版本，文件或连接可能已变化。请重新核验后再选择文件。",
			{ exact: true },
		)
		.waitFor();
	assert.equal(
		await page.locator(".ocs-diff-table, .ocs-raw-columns").count(),
		0,
	);
	assert.equal(server.counters.put, beforeDisplay.put);
	assert.equal(server.counters.delete, beforeDisplay.delete);
	await page.screenshot({
		path: join(artifactRoot, "obsidian-comparison-stale.png"),
	});
	assert.deepEqual(errors, []);
	const result = {
		passed: true,
		root,
		vault,
		pluginId: "vault-content-sync",
		obsidian: "1.14.4 (visible app title)",
		checks: [
			"declarative settings render and are indexed with English search aliases",
			"invalid endpoint is not saved and password remains session-only",
			"opening settings creates no WebDAV requests; explicit connection test sends one Depth 0 request",
			"connection success, invalid URL and permission error feedback; zero file GET or writes",
			"live read progress, filename search and status filters",
			"persistent native sidebar; no-baseline distinction and precise overlapping conflict snippets",
			"read-only mode hides all mutation actions",
			"light and dark themes, narrow layout without horizontal overflow",
			"preview creates no metadata",
			"host configuration directory is excluded on both sides",
			"native preview and execute controls",
			"cancel confirmation produces zero writes",
			"main editor comparison tab, aligned diff, lazy raw text, empty persisted view state",
			"default-closed quick preview; keyboard file menus; settings-only connection test",
			"quick preview completion preserves focus on same-row actions, another filename and external search",
			"stale comparison responses cannot overwrite selection or steal keyboard focus",
			"comparison light/dark/narrow; bounded highlight fallback retains complete text; changed files refuse stale display without writes",
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
