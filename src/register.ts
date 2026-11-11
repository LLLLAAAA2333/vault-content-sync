import { FileSystemAdapter, type Plugin } from "obsidian";
import {
	LocalStore,
	PlainEngine,
	type PlainHost,
	PlainPreview,
	PlainSettings,
	WebDavStore,
} from "@/sync";
export async function registerPlain(plugin: Plugin) {
	const raw = await plugin.loadData();
	const host: PlainHost = {
		app: plugin.app,
		plugin,
		settings: {
			url: typeof raw?.url === "string" ? raw.url : "",
			username: typeof raw?.username === "string" ? raw.username : "",
			mock: raw?.mock === true,
		},
		password: "",
		openPreview: () => {
			const view = new PlainPreview(host);
			view.open();
			return view;
		},
		save: () => plugin.saveData(host.settings),
		engine: () => {
			const adapter = plugin.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter))
				throw new Error("Desktop filesystem required");
			const root = adapter.getBasePath();
			return new PlainEngine(
				new LocalStore(root),
				new WebDavStore({
					url: host.settings.url,
					username: host.settings.username,
					password: host.password,
					isolatedMock: host.settings.mock,
				}),
				root,
			);
		},
	};
	plugin.addSettingTab(new PlainSettings(host));
	plugin.addCommand({
		id: "preview",
		name: "完整核验并预览Vault Weave",
		callback: () => {
			host.openPreview();
		},
	});
	plugin.addRibbonIcon("folder-sync", "Vault Weave", () => host.openPreview());
	plugin.register(() => {
		host.password = "";
	});
	return host;
}
