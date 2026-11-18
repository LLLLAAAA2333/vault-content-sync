import { FileSystemAdapter, normalizePath, type Plugin } from "obsidian";
import {
	LocalStore,
	PlainEngine,
	type PlainHost,
	PlainPreview,
	PlainSettings,
	SYNC_VIEW_TYPE,
	WebDavStore,
} from "@/sync";
import { AuthenticationError } from "./sync/auth";
import {
	Credentials,
	credentialScope,
	encryptedSecretStorage,
} from "./sync/credentials";
import { loadSettings } from "./sync/settings";
import { VerificationCache } from "./sync/verification-cache";
import { revokeWriteAccess, type WriteAccess } from "./sync/write-access";
import { verifyWriteAccess } from "./sync/write-probe";
import { COMPARISON_VIEW_TYPE, ComparisonView } from "./ui/comparison-view";
export async function registerPlain(plugin: Plugin) {
	const raw: unknown = await plugin.loadData();
	let comparisonGeneration = 0;
	let connectionGeneration = 0;
	const verificationCache = new VerificationCache();
	let cachedPassword: string | undefined;
	let writeAccess: WriteAccess | undefined;
	let verifyingWrites = false;
	let saving: Promise<unknown> = Promise.resolve();
	let pendingSettings = 0;
	function enqueue<T>(task: () => Promise<T>) {
		pendingSettings++;
		const result = saving
			.catch(() => undefined)
			.then(task)
			.finally(() => {
				pendingSettings--;
			});
		saving = result;
		return result;
	}
	function ready() {
		if (pendingSettings)
			throw new AuthenticationError("设置正在保存，请稍后重试。");
	}
	const settings = loadSettings(raw);
	const credentials = new Credentials(
		() => settings,
		() => encryptedSecretStorage(plugin.app.secretStorage),
	);
	const host: PlainHost = {
		app: plugin.app,
		plugin,
		settings,
		get password() {
			return credentials.read();
		},
		set password(value: string) {
			credentials.setSession(value);
			host.connectionChanged();
		},
		connectionChanged: () => {
			revokeWriteAccess(writeAccess);
			writeAccess = undefined;
			verificationCache.clear();
			cachedPassword = undefined;
			connectionGeneration++;
			host.invalidateComparison();
			for (const leaf of plugin.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE))
				if (leaf.view instanceof PlainPreview) leaf.view.invalidatePreview();
		},
		rememberPassword: (enabled) => {
			const scope = credentialScope(settings);
			host.connectionChanged();
			return enqueue(async () => {
				if (scope !== credentialScope(settings))
					throw new AuthenticationError("连接已改变，请重新填写密码。");
				const save = (next: typeof settings) => plugin.saveData(next);
				if (enabled) await credentials.remember(save);
				else await credentials.useSession(save);
				host.connectionChanged();
			});
		},
		updateSettings: (patch) => {
			host.connectionChanged();
			return enqueue(async () => {
				const next = loadSettings({ ...settings, ...patch });
				const changed = credentialScope(next) !== credentialScope(settings);
				const oldName = settings.secretName;
				const oldScope = credentialScope(settings);
				if (changed) {
					next.secretName = "";
					next.credentialScope = "";
					next.passwordMode = "session";
				}
				await plugin.saveData(next);
				Object.assign(settings, next);
				if (changed) {
					credentials.clear();
					credentials.forget(oldName, oldScope);
				}
				host.connectionChanged();
				return changed;
			});
		},
		clearCredentials: () => {
			credentials.clear();
			host.settings.secretName = "";
			host.settings.credentialScope = "";
			host.connectionChanged();
		},
		preview: async (onProgress, mode = "incremental") => {
			try {
				const generation = connectionGeneration,
					password = host.password;
				if (password !== cachedPassword) verificationCache.clear();
				cachedPassword = password;
				const result = await host.engine().preview(onProgress, mode);
				if (generation !== connectionGeneration || password !== host.password)
					throw new AuthenticationError("连接或密码已改变，请重新核验。");
				return result;
			} catch (error) {
				verificationCache.clear();
				cachedPassword = undefined;
				throw error;
			}
		},
		testConnection: () => {
			ready();
			return new WebDavStore({
				url: host.settings.url,
				username: host.settings.username,
				password: host.password,
			}).testConnection();
		},
		writeReady: () => {
			if (pendingSettings || host.hasInvalidUrl) return false;
			try {
				return new WebDavStore({
					url: settings.url,
					username: settings.username,
					password: host.password,
					writeAccess,
				}).writable;
			} catch {
				return false;
			}
		},
		verifyWrites: async () => {
			ready();
			if (verifyingWrites) throw new Error("写入验证正在进行，请稍候。");
			if (host.hasInvalidUrl) throw new Error("请先保存有效的 WebDAV 地址。");
			host.connectionChanged();
			const generation = connectionGeneration;
			const options = {
				url: settings.url,
				username: settings.username,
				password: host.password,
			};
			const current = () =>
				generation === connectionGeneration &&
				!host.hasInvalidUrl &&
				options.url === settings.url &&
				options.username === settings.username &&
				options.password === host.password;
			verifyingWrites = true;
			try {
				const result = await verifyWriteAccess(options, current);
				if (!current()) {
					revokeWriteAccess(result.access);
					throw new AuthenticationError("连接已改变，请重新验证写入能力。");
				}
				writeAccess = result.access;
				for (const leaf of plugin.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE))
					if (leaf.view instanceof PlainPreview) leaf.view.invalidatePreview();
				return { directory: result.directory, checks: result.checks.length };
			} finally {
				verifyingWrites = false;
			}
		},
		openPreview: async () => {
			const leaf = await plugin.app.workspace.ensureSideLeaf(
				SYNC_VIEW_TYPE,
				"left",
				{ active: true, reveal: true },
			);
			if (!(leaf.view instanceof PlainPreview))
				throw new Error("Sidebar unavailable");
			return leaf.view;
		},
		invalidateComparison: () => {
			comparisonGeneration++;
			for (const leaf of plugin.app.workspace.getLeavesOfType(
				COMPARISON_VIEW_TYPE,
			))
				if (leaf.view instanceof ComparisonView) leaf.view.invalidate();
		},
		openComparison: async (row) => {
			const request = ++comparisonGeneration;
			const { url, username } = host.settings,
				password = host.password;
			const leaf =
				plugin.app.workspace.getLeavesOfType(COMPARISON_VIEW_TYPE)[0] ??
				plugin.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: COMPARISON_VIEW_TYPE, active: true });
			if (request !== comparisonGeneration) return;
			await plugin.app.workspace.revealLeaf(leaf);
			if (request !== comparisonGeneration) return;
			if (leaf.view instanceof ComparisonView)
				await leaf.view.show(
					row,
					host.engine(),
					() =>
						request === comparisonGeneration &&
						url === host.settings.url &&
						username === host.settings.username &&
						password === host.password &&
						!host.hasInvalidUrl,
				);
		},
		save: () => {
			return enqueue(() => plugin.saveData(loadSettings(host.settings)));
		},
		engine: () => {
			ready();
			if (host.hasInvalidUrl)
				throw new AuthenticationError(
					"请先在设置中填写有效的 WebDAV 文件夹地址。",
				);
			const adapter = plugin.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter))
				throw new Error("Desktop filesystem required");
			const root = adapter.getBasePath();
			const excludedRoots = [normalizePath(plugin.app.vault.configDir)];
			return new PlainEngine(
				new LocalStore(root, excludedRoots),
				new WebDavStore({
					url: host.settings.url,
					username: host.settings.username,
					password: host.password,
					writeAccess,
					excludedRoots,
				}),
				root,
				verificationCache,
			);
		},
	};
	plugin.registerView(COMPARISON_VIEW_TYPE, (leaf) => new ComparisonView(leaf));
	plugin.registerView(SYNC_VIEW_TYPE, (leaf) => new PlainPreview(leaf, host));
	plugin.addSettingTab(new PlainSettings(host));
	plugin.addCommand({
		id: "preview",
		name: "查看文件变化",
		callback: () => {
			void host.openPreview();
		},
	});
	plugin.addCommand({
		id: "verify-full",
		name: "完整核验所有文件",
		callback: () => {
			void host.openPreview().then((view) => view.refresh("full"));
		},
	});
	plugin.addRibbonIcon(
		"folder-sync",
		"Vault Content Sync",
		() => void host.openPreview(),
	);
	plugin.register(() => {
		host.connectionChanged();
		credentials.clear();
		verificationCache.clear();
		cachedPassword = undefined;
	});
	return host;
}
