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
import { loadSettings } from "./sync/settings";
import { COMPARISON_VIEW_TYPE, ComparisonView } from "./ui/comparison-view";
export async function registerPlain(plugin: Plugin) {
	const raw: unknown = await plugin.loadData();
	let comparisonGeneration = 0;
	const host: PlainHost = {
		app: plugin.app,
		plugin,
		settings: loadSettings(raw),
		password: "",
		testConnection: () =>
			new WebDavStore({
				url: host.settings.url,
				username: host.settings.username,
				password: host.password,
			}).testConnection(),
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
		save: () => plugin.saveData(host.settings),
		engine: () => {
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
					isolatedMock: host.settings.mock,
					excludedRoots,
				}),
				root,
			);
		},
	};
	plugin.registerView(COMPARISON_VIEW_TYPE, (leaf) => new ComparisonView(leaf));
	plugin.registerView(SYNC_VIEW_TYPE, (leaf) => new PlainPreview(leaf, host));
	plugin.addSettingTab(new PlainSettings(host));
	plugin.addCommand({
		id: "preview",
		name: "完整核验并预览",
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
		host.password = "";
	});
	return host;
}
