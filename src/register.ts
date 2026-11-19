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
import { COMPARISON_VIEW_TYPE, ComparisonView } from "./ui/comparison-view";
export async function registerPlain(plugin: Plugin) {
	const raw: unknown = await plugin.loadData();
	let comparisonGeneration = 0;
	let connectionGeneration = 0;
	const verificationCache = new VerificationCache();
	let cachedPassword: string | undefined;
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
					throw new AuthenticationError("连接或密码已改变，请刷新变更。");
				return result;
			} catch (error) {
				verificationCache.clear();
				cachedPassword = undefined;
				throw error;
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
		openComparison: async (row, actions) => {
			const request = comparisonGeneration;
			const { url, username } = host.settings,
				password = host.password;
			const comparisons =
				plugin.app.workspace.getLeavesOfType(COMPARISON_VIEW_TYPE);
			const leaf =
				comparisons.find(
					({ view }) => view instanceof ComparisonView && view.shows(row.path),
				) ??
				comparisons.find(
					({ view }) => view instanceof ComparisonView && !view.hasDraft,
				) ??
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
					actions,
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
			const generation = connectionGeneration;
			const password = host.password;
			const excludedRoots = [normalizePath(plugin.app.vault.configDir)];
			return new PlainEngine(
				new LocalStore(root, excludedRoots),
				new WebDavStore({
					url: host.settings.url,
					username: host.settings.username,
					password,
					commitAllowed: () =>
						generation === connectionGeneration &&
						pendingSettings === 0 &&
						!host.hasInvalidUrl &&
						host.password === password,
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
