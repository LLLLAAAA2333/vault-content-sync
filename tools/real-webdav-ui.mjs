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
import { startApache } from "./apache-server.mjs";

const server = await startApache({ authenticated: true });
const root = server.root,
	vault = join(root, "vault"),
	profile = join(root, "profile");
const plugin = join(vault, ".obsidian/plugins/vault-content-sync");
const artifacts = resolve("artifacts", `webdav-ui-${Date.now()}`);
let child, browser, page;
const errors = [];
const appearance = {};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function inspectAppearance(sidebar, theme) {
	appearance[theme] = await sidebar.evaluate((el) => {
		const context = document.createElement("canvas").getContext("2d");
		const rgb = (color) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
		};
		const luminance = (values) =>
			values
				.map((value) => {
					const s = value / 255;
					return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				})
				.reduce(
					(sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
					0,
				);
		const background = rgb(getComputedStyle(el).backgroundColor);
		const bg = luminance(background);
		const labels = [
			".ocs-group-heading",
			".ocs-file-button",
			".ocs-kind.is-upload",
			".ocs-kind.is-conflict",
		];
		return {
			background,
			labels: labels.map((selector) => {
				const style = getComputedStyle(el.querySelector(selector));
				const color = rgb(style.color),
					ink = luminance(color);
				return {
					selector,
					color,
					contrast: (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05),
					size: style.fontSize,
					weight: style.fontWeight,
				};
			}),
			buttonRadius: getComputedStyle(
				el.querySelector(".ocs-sync-actions button"),
			).borderRadius,
		};
	});
	assert.ok(
		appearance[theme].labels.every((label) => label.contrast >= 4.5),
		`${theme} text contrast: ${JSON.stringify(appearance[theme])}`,
	);
}
async function confirm(name) {
	for (let attempt = 0; attempt < 100; attempt++) {
		for (const candidate of browser
			.contexts()
			.flatMap((context) => context.pages())) {
			const button = candidate.getByRole("button", { name, exact: true });
			if (await button.isVisible()) {
				await button.click();
				return;
			}
		}
		await pause(100);
	}
	throw new Error(`Confirmation not found: ${name}`);
}
try {
	await mkdir(plugin, { recursive: true });
	await mkdir(profile);
	await mkdir(artifacts, { recursive: true });
	for (const file of ["main.js", "styles.css", "manifest.json"])
		await copyFile(join("dist/vault-content-sync", file), join(plugin, file));
	await writeFile(
		join(plugin, "data.json"),
		JSON.stringify({
			url: server.url,
			username: server.credentials.username,
			mock: false,
		}),
	);
	await writeFile(
		join(vault, ".obsidian/community-plugins.json"),
		JSON.stringify(["vault-content-sync"]),
	);
	await writeFile(
		join(profile, "obsidian.json"),
		JSON.stringify({
			vaults: {
				"1234567890abcdef": { path: vault, ts: Date.now(), open: true },
			},
		}),
	);
	await writeFile(
		join(vault, "旅行计划.md"),
		"# 旅行计划\n\n本地新增的行程。\n",
	);
	await writeFile(join(vault, "共同笔记.md"), "# 共同笔记\n\n本地的安排。\n");
	await writeFile(
		join(server.documentRoot, "共同笔记.md"),
		"# 共同笔记\n\n远端的安排。\n",
	);
	await writeFile(
		join(server.documentRoot, "阅读清单.md"),
		"# 阅读清单\n\n远端新增的笔记。\n",
	);
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((done) => listener.close(done));
	child = spawn(
		"/Applications/Obsidian.app/Contents/MacOS/Obsidian",
		[`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
		{ stdio: "ignore" },
	);
	for (let attempt = 0; attempt < 120; attempt++) {
		if (child.exitCode !== null) throw new Error("Isolated Obsidian exited");
		try {
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
			page = browser
				.contexts()
				.flatMap((context) => context.pages())
				.find((candidate) => candidate.url().startsWith("app://obsidian.md"));
			if (page) break;
			await browser.close();
		} catch {}
		await pause(250);
	}
	if (!page) throw new Error("No isolated Obsidian page");
	page.on("pageerror", (error) => errors.push(error.message));
	for (let attempt = 0; attempt < 120; attempt++) {
		for (const candidate of browser
			.contexts()
			.flatMap((context) => context.pages())) {
			const trust = candidate.getByRole("button", {
				name: /trust author and enable plugins|信任作者.*启用|信任.*启用插件/i,
			});
			if (await trust.isVisible()) await trust.click();
		}
		if (
			await page.evaluate(
				() =>
					typeof app !== "undefined" &&
					Boolean(app.plugins?.plugins?.["vault-content-sync"]?.host),
			)
		)
			break;
		await pause(250);
	}
	assert.equal(
		await page.evaluate(() => app.vault.adapter.getBasePath()),
		vault,
	);
	await page.waitForFunction(() => app.workspace.layoutReady);
	await page.evaluate(async ({ password }) => {
		const host = app.plugins.plugins["vault-content-sync"].host;
		host.password = password;
		await host.openPreview();
	}, server.credentials);
	const sidebar = page.locator(".ocs-sidebar");
	await sidebar.getByText("仅预览", { exact: true }).waitFor();
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);
	await sidebar
		.getByRole("button", { name: "验证并开启同步", exact: true })
		.click();
	await confirm("开始验证");
	await sidebar
		.getByText("可同步", { exact: true })
		.waitFor({ timeout: 30_000 });
	assert.equal((await readdir(vault)).includes(".plain-sync"), false);
	await sidebar.getByRole("button", { name: "核验内容", exact: true }).click();
	await sidebar
		.getByText("待同步 2 · 冲突 1 · 未核实 0", { exact: true })
		.waitFor();
	const bounds = await sidebar.evaluate((el) => {
		const panel = el.getBoundingClientRect();
		const footer = el.querySelector(".ocs-footer").getBoundingClientRect();
		return {
			width: panel.width,
			footerGap: panel.bottom - footer.bottom,
			overflow: el.scrollWidth > el.clientWidth,
		};
	});
	assert.ok(bounds.footerGap < 3 && !bounds.overflow);
	await inspectAppearance(sidebar, "light");
	await page.screenshot({ path: join(artifacts, "webdav-changes.png") });
	await sidebar.screenshot({ path: join(artifacts, "sidebar-changes.png") });
	await page.evaluate(() => {
		document.body.classList.remove("theme-light");
		document.body.classList.add("theme-dark");
	});
	await inspectAppearance(sidebar, "dark");
	await sidebar.screenshot({
		path: join(artifacts, "sidebar-changes-dark.png"),
	});
	await page.evaluate(() => {
		document.body.classList.remove("theme-dark");
		document.body.classList.add("theme-light");
	});
	await sidebar
		.getByRole("button", { name: "比较内容：共同笔记.md", exact: true })
		.click();
	await page.locator(".ocs-diff-table").waitFor();
	await page.screenshot({ path: join(artifacts, "webdav-comparison.png") });
	await sidebar
		.getByRole("button", { name: "同步全部（2）", exact: true })
		.click();
	await confirm("执行同步");
	await sidebar
		.getByText("待同步 0 · 冲突 1 · 未核实 0", { exact: true })
		.waitFor({ timeout: 30_000 });
	assert.equal(
		await readFile(join(vault, "阅读清单.md"), "utf8"),
		"# 阅读清单\n\n远端新增的笔记。\n",
	);
	assert.equal(
		await readFile(join(server.documentRoot, "旅行计划.md"), "utf8"),
		"# 旅行计划\n\n本地新增的行程。\n",
	);
	await sidebar
		.getByRole("button", { name: "文件操作：共同笔记.md", exact: true })
		.click();
	await page
		.locator(".menu-item-title")
		.getByText("采用远端", { exact: true })
		.click();
	await confirm("应用选择");
	await sidebar
		.getByText("两端内容一致", { exact: true })
		.waitFor({ timeout: 30_000 });
	assert.equal(
		await readFile(join(vault, "共同笔记.md"), "utf8"),
		"# 共同笔记\n\n远端的安排。\n",
	);
	await sidebar.screenshot({ path: join(artifacts, "sidebar-equal.png") });
	const lightBackground = await sidebar.evaluate(
		(el) => getComputedStyle(el.querySelector(".ocs-footer")).backgroundColor,
	);
	await page.evaluate(() => {
		document.body.classList.remove("theme-light");
		document.body.classList.add("theme-dark");
	});
	await pause(150);
	assert.notEqual(
		await sidebar.evaluate(
			(el) => getComputedStyle(el.querySelector(".ocs-footer")).backgroundColor,
		),
		lightBackground,
	);
	await sidebar.screenshot({ path: join(artifacts, "sidebar-dark.png") });
	await page.setViewportSize({ width: 560, height: 650 });
	assert.ok(await sidebar.evaluate((el) => el.scrollWidth <= el.clientWidth));
	await page.screenshot({ path: join(artifacts, "webdav-narrow.png") });
	await page.evaluate(() => {
		document.body.classList.remove("theme-dark");
		document.body.classList.add("theme-light");
	});
	await page.evaluate(() => {
		app.plugins.plugins["vault-content-sync"].host.password =
			"wrong-synthetic-password";
	});
	await sidebar.getByText("仅预览", { exact: true }).waitFor();
	assert.equal(
		await page.evaluate(() =>
			app.plugins.plugins["vault-content-sync"].host.writeReady(),
		),
		false,
	);
	assert.equal(
		await sidebar
			.getByRole("button", { name: "同步全部", exact: false })
			.count(),
		0,
	);
	assert.deepEqual(errors, []);
	await writeFile(
		join(artifacts, "result.json"),
		JSON.stringify(
			{
				passed: true,
				service: "Apache mod_dav_fs with Basic authentication",
				checks: [
					"isolated vault/profile",
					"real write verification UI",
					"no local state before explicit sync",
					"pinned footer without overflow",
					"upload and download",
					"main-editor comparison",
					"explicit remote conflict resolution",
					"empty/light/dark screenshots",
					"credential change revokes write permission",
				],
				errors,
				appearance,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ passed: true, artifacts, errors }));
} catch (error) {
	if (page)
		await page
			.screenshot({ path: join(artifacts, "failure.png") })
			.catch(() => {});
	throw error;
} finally {
	if (browser) await browser.close().catch(() => {});
	if (child && child.exitCode === null && child.signalCode === null) {
		const done = once(child, "exit");
		child.kill("SIGTERM");
		await done;
	}
	await server.stop();
}
