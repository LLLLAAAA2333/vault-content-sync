// @ts-expect-error jsdom is a test-only JavaScript dependency.
import { JSDOM } from "jsdom";
import type {
	Setting as HostSetting,
	Plugin,
	SettingGroup,
	WorkspaceLeaf,
} from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerPlain } from "@/register";
import { AuthenticationError } from "@/sync/auth";
import type { PlainEngine } from "@/sync/engine";
import type { Preview, Row } from "@/sync/model";
import { loadSettings } from "@/sync/settings";
import { grantWriteAccess, writeScope } from "@/sync/write-access";
import * as writeProbe from "@/sync/write-probe";
import { ComparisonView } from "@/ui/comparison-view";
import { type PlainHost, PlainPreview, PlainSettings } from "@/ui/view";
import { Setting } from "./obsidian-stub";

vi.mock("obsidian", async () => import("./obsidian-stub"));
let dom: JSDOM;
beforeEach(() => {
	dom = new JSDOM();
	vi.stubGlobal("document", dom.window.document);
	Object.assign(dom.window.HTMLElement.prototype, {
		empty(this: HTMLElement) {
			this.replaceChildren();
		},
		setText(this: HTMLElement, text: string) {
			this.textContent = text;
		},
		addClass(this: HTMLElement, cls: string) {
			this.classList.add(cls);
		},
		createDiv(
			this: HTMLElement,
			options: { text?: string; cls?: string } = {},
		) {
			const el = document.createElement("div");
			el.textContent = options.text ?? "";
			el.className = options.cls ?? "";
			this.append(el);
			return el;
		},
		createSpan(this: HTMLElement, options: { text?: string } = {}) {
			const el = document.createElement("span");
			el.textContent = options.text ?? "";
			this.append(el);
			return el;
		},
	});
});
afterEach(() => {
	dom.window.close();
	vi.unstubAllGlobals();
});
async function setup() {
	let disk = loadSettings({
		url: "https://example.test/notes/",
		username: "test",
	});
	const secrets = new Map<string, string>();
	const app = {
		vault: { configDir: ".obsidian" },
		secretStorage: {
			isEncryptionAvailable: () => true,
			getSecret: (key: string) => secrets.get(key) ?? null,
			setSecret: (key: string, value: string) => {
				secrets.set(key, value);
			},
		},
		workspace: { getLeavesOfType: () => [] },
	};
	const plugin = {
		app,
		loadData: async () => disk,
		saveData: vi.fn(async (next: typeof disk) => {
			disk = loadSettings(next);
		}),
		registerView() {},
		addSettingTab() {},
		addCommand() {},
		addRibbonIcon() {},
		register() {},
	};
	const host = await registerPlain(plugin as unknown as Plugin);
	const tab = new PlainSettings(host);
	function render(name: string) {
		const def = tab
			.getSettingDefinitions()
			.find((d) => "name" in d && d.name === name);
		if (!def || !("render" in def) || !def.render)
			throw Error("Missing setting");
		const setting = new Setting();
		def.render(setting as unknown as HostSetting, {} as SettingGroup);
		return setting;
	}
	return {
		tab,
		host,
		plugin,
		secrets,
		render,
		disk: () => disk,
		restart: () => registerPlain(plugin as unknown as Plugin),
	};
}
function input(setting: Setting, value: string) {
	const el = setting.controlEl.querySelector("input");
	if (!el) throw Error("No input");
	el.value = value;
	el.dispatchEvent(new dom.window.Event("input"));
	return el;
}
it("explicitly clearing a remembered password survives restart; untouched failed reads are not saved on blur", async () => {
	const s = await setup();
	s.host.password = "synthetic-old";
	await s.host.rememberPassword(true);
	const name = s.host.settings.secretName;
	const password = s.render("密码"),
		remember = s.render("记住密码");
	input(password, "").dispatchEvent(new dom.window.Event("blur"));
	await vi.waitFor(() => expect(s.host.settings.passwordMode).toBe("session"));
	expect((await s.restart()).password).toBe("");
	expect(s.secrets.get(name)).toBe("");
	expect(remember.controlEl.querySelector("input")?.checked).toBe(false);
	expect(remember.description).toBe("仅本次使用，重启后需重新填写。");
	s.host.password = "second";
	await s.host.rememberPassword(true);
	s.plugin.app.secretStorage.getSecret = () => {
		throw Error("locked");
	};
	const locked = s.render("密码"),
		before = locked.description,
		calls = s.plugin.saveData.mock.calls.length;
	locked.controlEl
		.querySelector("input")
		?.dispatchEvent(new dom.window.Event("blur"));
	await Promise.resolve();
	expect(locked.description).toBe(before);
	expect(s.plugin.saveData.mock.calls.length).toBe(calls);
});

it.each(["same-scope", "failed-save"])(
	"connection completion preserves a dirty password input (%s)",
	async (scenario) => {
		const s = await setup();
		s.host.password = "old";
		await s.host.rememberPassword(true);
		const password = s.render("密码"),
			url = s.render("WebDAV 目录 URL");
		let release!: () => void;
		s.plugin.saveData.mockImplementationOnce(async (next) => {
			await new Promise<void>((r) => {
				release = r;
			});
			if (scenario === "failed-save") throw Error("disk failure");
			Object.assign(s.disk(), next);
		});
		input(
			url,
			scenario === "same-scope"
				? "https://example.test/notes"
				: "https://other.test/",
		);
		await vi.waitFor(() => expect(release).toBeDefined());
		const field = input(password, "new");
		release();
		await vi.waitFor(() =>
			expect(url.description).toContain(
				scenario === "same-scope" ? "已保存" : "保存失败",
			),
		);
		expect(password.controlEl.querySelector("input")).toBe(field);
		field.dispatchEvent(new dom.window.Event("blur"));
		await vi.waitFor(() => expect(password.description).toBe("密码已保存。"));
		expect((await s.restart()).password).toBe("new");
	},
);

it("closing settings saves a dirty password even without blur and clears an abandoned invalid URL", async () => {
	const s = await setup();
	s.host.password = "old";
	await s.host.rememberPassword(true);
	const password = s.render("密码"),
		url = s.render("WebDAV 目录 URL");
	input(password, "new");
	input(url, "invalid");
	expect(s.host.hasInvalidUrl).toBe(true);
	s.tab.hide();
	expect(s.host.hasInvalidUrl).toBe(false);
	await vi.waitFor(() => expect(password.description).toBe("密码已保存。"));
	expect((await s.restart()).password).toBe("new");
	input(url, "invalid-again");
	s.render("WebDAV 目录 URL");
	expect(s.host.hasInvalidUrl).toBe(false);
});

it("an invalid URL draft supersedes the completion message of an earlier valid save", async () => {
	const s = await setup(),
		url = s.render("WebDAV 目录 URL");
	let release!: () => void;
	s.plugin.saveData.mockImplementationOnce(async (next) => {
		await new Promise<void>((r) => {
			release = r;
		});
		Object.assign(s.disk(), next);
	});
	input(url, "https://other.test/");
	await vi.waitFor(() => expect(release).toBeDefined());
	input(url, "invalid");
	release();
	await s.host.save();
	expect(url.description).toContain("地址无效");
	expect(s.host.hasInvalidUrl).toBe(true);
});
it.each([true, false])(
	"remember toggle restores the persisted position after save failure (requested %s)",
	async (enabled) => {
		const s = await setup();
		s.host.password = "synthetic";
		if (!enabled) await s.host.rememberPassword(true);
		const setting = s.render("记住密码"),
			toggle = setting.controlEl.querySelector("input");
		if (!toggle) throw Error("No toggle");
		s.plugin.saveData.mockRejectedValueOnce(Error("disk failure"));
		toggle.checked = enabled;
		toggle.dispatchEvent(new dom.window.Event("change"));
		await vi.waitFor(() => expect(setting.description).toContain("保存失败"));
		expect(toggle.checked).toBe(!enabled);
		expect((await s.restart()).settings.passwordMode).toBe(
			enabled ? "session" : "secret",
		);
		toggle.checked = enabled;
		toggle.dispatchEvent(new dom.window.Event("change"));
		await vi.waitFor(() =>
			expect(s.disk().passwordMode).toBe(enabled ? "secret" : "session"),
		);
	},
);
it.each(["WebDAV 目录 URL", "用户名"])(
	"%s save failure is visible and leaves the original setting usable",
	async (name) => {
		const s = await setup(),
			setting = s.render(name),
			before = loadSettings(s.host.settings);
		s.plugin.saveData.mockRejectedValueOnce(Error("disk failure"));
		input(setting, name === "用户名" ? "new-user" : "https://other.test/");
		await vi.waitFor(() => expect(setting.description).toContain("保存失败"));
		expect(s.host.settings).toEqual(before);
		expect(s.disk()).toEqual(before);
	},
);
it("serializes credential and connection changes without binding an old password to a new server", async () => {
	const s = await setup();
	s.host.password = "old-scope";
	let release!: () => void;
	s.plugin.saveData.mockImplementationOnce(async (next) => {
		await new Promise<void>((r) => {
			release = r;
		});
		Object.assign(s.disk(), next);
	});
	const remembering = s.host.rememberPassword(true);
	await vi.waitFor(() => expect(release).toBeDefined());
	const changing = s.host.updateSettings({ url: "https://other.test/" });
	expect(() => s.host.testConnection()).toThrow("正在保存");
	release();
	await remembering;
	await changing;
	expect(s.host.password).toBe("");
	expect((await s.restart()).password).toBe("");
	expect(s.host.settings.url).toBe("https://other.test/");
});

type SidebarAccess = {
	preview?: Preview;
	failure: string;
	authenticationFailure: boolean;
	renderContent(): void;
	work(task: () => Promise<void>): Promise<void>;
	openComparison(row: Row): Promise<void>;
};
it("comparison 401 clears the caller sidebar plan and shows authentication failure", async () => {
	const cmp = new ComparisonView({} as WorkspaceLeaf);
	const host = {
		openComparison: (row: Row) =>
			cmp.show(
				row,
				{
					inspect: async () => {
						throw new AuthenticationError();
					},
				} as unknown as PlainEngine,
				() => true,
			),
	};
	const sidebar = new PlainPreview(
		{} as WorkspaceLeaf,
		host as PlainHost,
	) as unknown as SidebarAccess;
	sidebar.renderContent = () => {};
	sidebar.preview = {} as Preview;
	await sidebar.openComparison({
		path: "n.md",
		kind: "conflict",
		local: null,
		remote: null,
	});
	expect(sidebar.preview).toBeUndefined();
	expect(sidebar.authenticationFailure).toBe(true);
	expect(sidebar.failure).toContain("认证失败");
});
it("failed work drops the old plan before executing and does not restore it on failure", async () => {
	const host = { invalidateComparison() {} };
	const sidebar = new PlainPreview(
		{} as WorkspaceLeaf,
		host as PlainHost,
	) as unknown as SidebarAccess;
	sidebar.renderContent = () => {};
	sidebar.preview = {} as Preview;
	await sidebar.work(async () => {
		expect(sidebar.preview).toBeUndefined();
		throw Error("precondition failed");
	});
	expect(sidebar.preview).toBeUndefined();
	expect(sidebar.failure).toContain("precondition failed");
});

it.each(["url-back", "username-back", "url-invalid"])(
	"every committed connection switch refreshes credential controls during rapid edits (%s)",
	async (scenario) => {
		const s = await setup();
		s.host.password = "old";
		await s.host.rememberPassword(true);
		const password = s.render("密码"),
			remember = s.render("记住密码"),
			field = s.render(
				scenario === "username-back" ? "用户名" : "WebDAV 目录 URL",
			);
		let release!: () => void;
		s.plugin.saveData.mockImplementationOnce(async (next) => {
			await new Promise<void>((r) => {
				release = r;
			});
			Object.assign(s.disk(), next);
		});
		input(
			field,
			scenario === "username-back" ? "new-user" : "https://other.test/",
		);
		await vi.waitFor(() => expect(release).toBeDefined());
		input(
			field,
			scenario === "username-back"
				? "test"
				: scenario === "url-invalid"
					? "invalid"
					: "https://example.test/notes/",
		);
		release();
		await s.host.save();
		await vi.waitFor(() =>
			expect(password.controlEl.querySelector("input")?.value).toBe(""),
		);
		expect(remember.controlEl.querySelector("input")?.checked).toBe(false);
		expect(s.host.password).toBe("");
		expect(s.disk().passwordMode).toBe("session");
	},
);

it("closing after enabling remember neither rewrites the saved password nor reads a newly locked keyring", async () => {
	const s = await setup(),
		password = s.render("密码"),
		remember = s.render("记住密码");
	input(password, "first");
	const toggle = remember.controlEl.querySelector("input");
	if (!toggle) throw Error("Missing toggle");
	toggle.checked = true;
	toggle.dispatchEvent(new dom.window.Event("change"));
	await vi.waitFor(() => expect(remember.description).toContain("已记住密码"));
	const calls = s.plugin.saveData.mock.calls.length;
	s.plugin.app.secretStorage.getSecret = () => {
		throw new Error("locked");
	};
	s.host.hasInvalidUrl = true;
	expect(() => s.tab.hide()).not.toThrow();
	await Promise.resolve();
	expect(s.host.hasInvalidUrl).toBe(false);
	expect(s.plugin.saveData.mock.calls.length).toBe(calls);
});

it("an unavailable dirty credential is reported without interrupting settings hide cleanup", async () => {
	const s = await setup();
	s.host.password = "old";
	await s.host.rememberPassword(true);
	const password = s.render("密码");
	input(password, "draft");
	s.host.clearCredentials();
	s.host.hasInvalidUrl = true;
	expect(() => s.tab.hide()).not.toThrow();
	expect(s.host.hasInvalidUrl).toBe(false);
	expect(password.description).toContain("已保存密码不可用");
});

it.each([false, true])(
	"a changed or unreadable credential ends the comparison loading message (%s)",
	async (locked) => {
		const cmp = new ComparisonView({} as WorkspaceLeaf);
		let release!: () => void;
		const task = cmp.show(
			{ path: "n.md", kind: "conflict", local: null, remote: null },
			{
				inspect: async () => {
					await new Promise<void>((r) => {
						release = r;
					});
					return { base: null, local: "a", remote: "b" };
				},
			} as unknown as PlainEngine,
			() => {
				if (locked) throw new AuthenticationError();
				return false;
			},
		);
		const result = task.catch((error) => error);
		release();
		const error = await result;
		if (locked) expect(error).toBeInstanceOf(AuthenticationError);
		const content = (cmp as unknown as { contentEl: HTMLElement }).contentEl;
		expect(content.textContent).not.toContain("正在读取");
		expect(content.textContent).toContain(locked ? "认证失败" : "已改变");
	},
);

it("verified writes are session-only and a late verification cannot reopen a changed connection", async () => {
	const s = await setup();
	s.host.password = "synthetic";
	const makeResult = () => ({
		access: grantWriteAccess(
			writeScope({ ...s.host.settings, password: s.host.password }),
		),
		directory: ".vault-content-sync-check-synthetic",
		checks: ["synthetic"],
		verifiedAt: Date.now(),
	});
	const spy = vi.spyOn(writeProbe, "verifyWriteAccess");
	try {
		spy.mockResolvedValueOnce(makeResult());
		await s.host.verifyWrites();
		expect(s.host.writeReady()).toBe(true);
		expect((await s.restart()).writeReady()).toBe(false);
		s.host.password = "changed";
		expect(s.host.writeReady()).toBe(false);
		const result = makeResult();
		let release!: () => void;
		spy.mockImplementationOnce(async () => {
			await new Promise<void>((done) => {
				release = done;
			});
			return result;
		});
		const checking = s.host.verifyWrites();
		const rejected = expect(checking).rejects.toThrow("连接已改变");
		s.host.password = "newer";
		release();
		await rejected;
		expect(s.host.writeReady()).toBe(false);
	} finally {
		spy.mockRestore();
	}
});
