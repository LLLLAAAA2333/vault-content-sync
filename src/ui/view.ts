import {
	type App,
	ButtonComponent,
	DropdownComponent,
	ItemView,
	Menu,
	type Plugin,
	PluginSettingTab,
	type Setting,
	type SettingDefinitionItem,
	setIcon,
	TextComponent,
	type ToggleComponent,
	type WorkspaceLeaf,
} from "obsidian";
import { AuthenticationError } from "../sync/auth";
import { collectionUrl } from "../sync/connection";
import { credentialScope } from "../sync/credentials";

import type { PlainEngine } from "../sync/engine";
import type { Preview, Row, ScanProgress } from "../sync/model";
import { parseExcludedFolders, type SyncSettings } from "../sync/settings";
import type { VerificationMode } from "../sync/verification-cache";
import { modalHint, openConfirmModal } from "./modal";

export interface PlainHost {
	app: App;
	plugin: Plugin;
	settings: SyncSettings;
	password: string;
	clearCredentials(): void;
	rememberPassword(enabled: boolean): Promise<void>;
	updateSettings(
		patch: Partial<Pick<SyncSettings, "url" | "username" | "excludedFolders">>,
	): Promise<boolean>;
	connectionChanged(): void;
	preview(
		onProgress?: (
			progress: ScanProgress & { side: "local" | "remote" },
		) => void,
		mode?: VerificationMode,
	): Promise<Preview>;
	hasInvalidUrl?: boolean;
	save(): Promise<void>;
	engine(): PlainEngine;
	openPreview(): Promise<PlainPreview>;
	openComparison(
		row: Row,
		actions?: {
			committed?: () => Promise<void>;
			refresh?: () => Promise<Row | undefined>;
		},
	): Promise<void>;
	invalidateComparison(): void;
}
const labels: Record<Row["kind"], string> = {
	equal: "一致",
	upload: "待上传",
	download: "待下载",
	"delete-local": "待删除本地",
	"delete-remote": "待删除远端",
	conflict: "冲突",
	unknown: "读取失败",
	excluded: "已排除",
};
function icon(parent: HTMLElement, name: string, cls = "ocs-file-icon") {
	const el = parent.createSpan({ cls });
	el.setAttribute("aria-hidden", "true");
	setIcon(el, name);
	return el;
}

const isWrite = (row: Row) =>
	["upload", "download", "delete-local", "delete-remote"].includes(row.kind);

export const SYNC_VIEW_TYPE = "vault-content-sync-changes";

export class PlainPreview extends ItemView {
	private collapsedGroups = new Set<string>();
	private preview?: Preview;
	private busy = false;
	private failure = "";
	private notice = "";
	private comparisonPath = "";
	private authenticationFailure = false;
	private filtersOpen = false;
	private status?: HTMLElement;
	private progress?: HTMLProgressElement;
	private list?: HTMLElement;
	private filter = "changes";
	private query = "";

	constructor(
		leaf: WorkspaceLeaf,
		private host: PlainHost,
	) {
		super(leaf);
	}
	getViewType() {
		return SYNC_VIEW_TYPE;
	}
	getDisplayText() {
		return "Vault Content Sync";
	}
	getIcon() {
		return "git-compare-arrows";
	}
	async onOpen() {
		this.contentEl.addClass("ocs-sidebar");
		this.renderContent();
	}
	async onClose() {
		this.contentEl.empty();
	}
	invalidatePreview() {
		this.preview = undefined;
		this.notice = "";
		this.comparisonPath = "";
		this.failure = "";
		this.renderContent();
	}
	private iconButton(
		parent: HTMLElement,
		name: string,
		label: string,
		action: () => void,
	) {
		const button = new ButtonComponent(parent)
			.setIcon(name)
			.setTooltip(label)
			.setDisabled(this.busy)
			.onClick(action);
		button.buttonEl.setAttribute("aria-label", label);
		button.buttonEl.addClass("ocs-icon-button");
		return button;
	}
	async refresh(mode: VerificationMode = "incremental") {
		await this.work(async () => {
			this.preview = await this.host.preview(
				(progress) => this.updateProgress(progress),
				mode,
			);
		});
	}
	private renderContent() {
		this.contentEl.empty();
		this.contentEl.addClass("ocs-content");
		this.list = undefined;
		let address: URL | undefined;
		try {
			address = collectionUrl(this.host.settings.url);
		} catch {
			/* Setup required. */
		}
		if (this.host.hasInvalidUrl) address = undefined;
		const header = this.contentEl.createDiv({ cls: "ocs-sidebar-heading" });
		header.createEl("h2", { text: "变更" });
		const toolbar = this.contentEl.createDiv({ cls: "ocs-toolbar" });
		const comparable =
			this.preview?.rows.find((r) => r.path === this.comparisonPath) ??
			this.preview?.rows.find((r) =>
				[
					"upload",
					"download",
					"delete-local",
					"delete-remote",
					"conflict",
				].includes(r.kind),
			);
		const compare = new ButtonComponent(toolbar)
			.setIcon("columns-2")
			.setButtonText("查看差异")
			.setDisabled(this.busy || !comparable)
			.onClick(() => {
				if (comparable) void this.openComparison(comparable);
			});
		compare.buttonEl.addClass("ocs-diff-button");
		const actions = toolbar.createDiv({ cls: "ocs-header-actions" });
		const filter = this.iconButton(actions, "list-filter", "筛选文件", () => {
			this.filtersOpen = !this.filtersOpen;
			this.renderContent();
			if (this.filtersOpen)
				this.contentEl
					.querySelector<HTMLInputElement>(".ocs-filters input")
					?.focus();
		});
		filter.buttonEl.setAttribute("aria-expanded", String(this.filtersOpen));
		const more = this.iconButton(actions, "ellipsis", "更多操作", () =>
			this.showMenu(more.buttonEl),
		);
		if (this.filtersOpen) {
			const filters = this.contentEl.createDiv({ cls: "ocs-filters" });
			new TextComponent(filters)
				.setPlaceholder("筛选文件或路径…")
				.setValue(this.query)
				.onChange((value) => {
					this.query = value;
					this.renderRows();
				})
				.inputEl.setAttribute("aria-label", "筛选文件或路径");
			new DropdownComponent(filters)
				.addOptions({
					changes: "待处理",
					conflict: "冲突",
					all: "全部",
					equal: "一致",
					excluded: "已排除",
				})
				.setValue(this.filter)
				.onChange((value) => {
					this.filter = value;
					this.renderRows();
				})
				.selectEl.setAttribute("aria-label", "显示范围");
		}
		const body = this.contentEl.createDiv({ cls: "ocs-body" });
		this.status = body.createDiv({
			cls: "ocs-status",
			text: this.busy ? "正在处理…" : this.failure || this.notice,
		});
		this.status.setAttribute("role", "status");
		if (!this.busy && this.failure) this.status.addClass("is-error");
		this.progress = undefined;
		if (this.busy) {
			this.progress = body.createEl("progress", { cls: "ocs-progress" });
			this.progress.setAttribute("aria-label", "读取变更进度");
		} else if (this.preview) {
			this.list = body.createDiv({ cls: "ocs-list" });
			this.renderRows();
		} else if (!this.failure) {
			body.createDiv({
				cls: "ocs-empty-note",
				text: address
					? "刷新变更以查看待同步文件。"
					: "在插件设置中连接 WebDAV。",
			});
		}
		const footer = this.contentEl.createDiv({ cls: "ocs-footer" });
		const endpoint = footer.createDiv({ cls: "ocs-endpoint" });
		icon(endpoint, "folder", "ocs-endpoint-icon");
		let name =
			address?.pathname.split("/").filter(Boolean).pop() || address?.host;
		try {
			if (name) name = decodeURIComponent(name);
		} catch {
			/* Keep encoded display. */
		}
		const target = endpoint.createSpan({
			cls: "ocs-target-name",
			text: name ? `远端：${name}` : "尚未连接",
		});
		target.title = address?.href || "请在插件设置中填写连接信息";
		new ButtonComponent(endpoint)
			.setIcon("refresh-cw")
			.setButtonText("刷新变更")
			.setDisabled(this.busy || !address)
			.onClick(() => void this.refresh());
		if (this.preview) {
			const conflicts = this.preview.rows.filter(
				(r) => r.kind === "conflict",
			).length;
			const unknown = this.preview.rows.filter(
				(r) => r.kind === "unknown",
			).length;
			const summary = footer.createDiv({
				cls: "ocs-summary",
				text: `待同步 ${this.preview.writes} · 冲突 ${conflicts}${unknown ? ` · 读取失败 ${unknown}` : ""}`,
			});
			if (unknown) summary.addClass("is-error");
		}
		const operations = footer.createDiv({ cls: "ocs-sync-actions" });
		const current = this.preview;
		new ButtonComponent(operations)
			.setButtonText(
				current?.writes ? `提交变更（${current.writes}）` : "提交变更",
			)
			.setDisabled(
				this.busy ||
					!current?.writes ||
					current.rows.some((r) => r.kind === "unknown"),
			)
			.onClick(() => {
				if (current) void this.execute(current);
			});
	}
	private showMenu(anchor: HTMLElement, row?: Row) {
		const menu = new Menu();
		menu.setUseNativeMenu(false);
		if (row) {
			menu.addItem((item) =>
				item
					.setTitle(row.kind === "conflict" ? "处理冲突" : "查看差异")
					.setIcon("columns-2")
					.onClick(() => void this.openComparison(row)),
			);
			if (isWrite(row)) {
				const current = this.preview;
				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("同步此文件")
						.setIcon("refresh-cw")
						.setDisabled(
							this.busy ||
								!current ||
								current.rows.some((r) => r.kind === "unknown"),
						)
						.onClick(() => {
							if (current) void this.execute(current, row);
						}),
				);
			}
		} else {
			menu.addItem((item) =>
				item
					.setTitle("显示筛选")
					.setIcon("list-filter")
					.setChecked(this.filtersOpen)
					.onClick(() => {
						this.filtersOpen = !this.filtersOpen;
						this.renderContent();
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("恢复未完成的提交")
					.setIcon("history")
					.setDisabled(
						this.busy || !this.host.settings.url || !!this.host.hasInvalidUrl,
					)
					.onClick(() => void this.recover()),
			);
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition(
			{ x: rect.left, y: rect.bottom },
			this.contentEl.ownerDocument,
		);
	}
	private updateProgress(
		progress: ScanProgress & { side: "local" | "remote" },
	) {
		const side = progress.side === "local" ? "本地" : "远端";
		this.status?.setText(
			progress.phase === "listing"
				? `正在列出${side}文件…`
				: `正在读取${side} · ${progress.completed} / ${progress.total} 个文件 · 已读取 ${readVolume(progress.bytes)}`,
		);
		if (this.progress) {
			if (progress.phase === "listing") this.progress.removeAttribute("value");
			else {
				this.progress.max = Math.max(1, progress.total);
				this.progress.value = progress.completed;
			}
		}
	}
	private renderRows() {
		if (!this.list || !this.preview) return;
		const list = this.list;
		list.empty();
		const rows = this.preview.rows.filter(
			(r) =>
				(this.filter === "all" ||
					(this.filter === "changes"
						? !["equal", "excluded"].includes(r.kind)
						: r.kind === this.filter)) &&
				r.path.toLocaleLowerCase().includes(this.query.toLocaleLowerCase()),
		);
		const groups: [string, Row["kind"][]][] = [
			["冲突", ["conflict"]],
			["读取失败", ["unknown"]],
			["本地变更", ["upload", "delete-remote"]],
			["远端变更", ["download", "delete-local"]],
			["内容一致", ["equal"]],
			["已排除", ["excluded"]],
		];
		let shown = 0;
		for (const [title, kinds] of groups) {
			const matches = rows.filter((r) => kinds.includes(r.kind));
			if (!matches.length || shown >= 200) continue;
			const section = list.createEl("details", { cls: "ocs-group" });
			section.open = !this.collapsedGroups.has(title);
			section.ontoggle = () => {
				if (section.open) this.collapsedGroups.delete(title);
				else this.collapsedGroups.add(title);
			};
			const heading = section.createEl("summary", { cls: "ocs-group-heading" });
			heading.createSpan({ text: title });
			heading.createSpan({ text: String(matches.length) });
			const items = section.createDiv();
			items.setAttribute("role", "list");
			for (const row of matches.slice(0, 200 - shown)) {
				shown++;
				const item = items.createDiv({ cls: "ocs-row" });
				item.setAttribute("role", "listitem");
				icon(
					item,
					row.kind === "conflict"
						? "git-compare"
						: row.kind === "unknown"
							? "circle-help"
							: "file-text",
				);
				const name = item.createDiv({ cls: "ocs-path" });
				const parts = row.path.split("/");
				const filename = parts.pop() ?? row.path;
				const inspectable = !["unknown", "excluded"].includes(row.kind);
				if (inspectable) {
					const trigger = name.createEl("button", {
						cls: "ocs-file-button ocs-filename",
						text: filename,
					});
					trigger.setAttribute(
						"aria-label",
						`${row.kind === "conflict" ? "处理冲突" : "查看差异"}：${row.path}`,
					);
					trigger.onclick = () => void this.openComparison(row);
				} else name.createSpan({ cls: "ocs-filename", text: filename });
				if (parts.length)
					name.createSpan({ cls: "ocs-folder", text: parts.join("/") });
				item.title = row.reason
					? `${row.path} — ${reason(row.reason)}`
					: row.path;
				item.createSpan({
					cls: `ocs-kind is-${row.kind}`,
					text: labels[row.kind],
				});
				if (inspectable) {
					const actions = item.createDiv({ cls: "ocs-row-actions" });
					const more = this.iconButton(
						actions,
						"ellipsis",
						`文件操作：${row.path}`,
						() => this.showMenu(more.buttonEl, row),
					);
					item.oncontextmenu = (event) => {
						event.preventDefault();
						this.showMenu(more.buttonEl, row);
					};
					item.onkeydown = (event) => {
						if (
							event.key === "ContextMenu" ||
							(event.shiftKey && event.key === "F10")
						) {
							event.preventDefault();
							this.showMenu(more.buttonEl, row);
						}
					};
				}
				if (row.kind === "unknown" && row.reason) {
					const issue = item.createEl("details", { cls: "ocs-row-reason" });
					issue.createEl("summary", { text: "查看原因" });
					issue.createDiv({ text: reason(row.reason) });
				}
			}
		}
		if (!rows.length)
			list.createDiv({
				cls: "ocs-empty-note",
				text: this.query
					? "没有匹配的文件，试试其他名称或路径。"
					: this.filter === "changes"
						? "两端内容一致"
						: "这个范围没有文件。",
			});
		if (shown < rows.length)
			modalHint(
				list,
				`显示 ${shown} / ${rows.length} 项，可输入文件名或路径缩小范围。`,
			);
	}
	private async openComparison(row: Row) {
		if (this.busy) return;
		this.comparisonPath = row.path;
		try {
			const refresh = async () => {
				const before = this.preview;
				if (!before) return undefined;
				const updated = await this.host
					.engine()
					.refreshPaths(before, [row.path]);
				if (this.preview !== before) return undefined;
				this.preview = updated;
				this.renderContent();
				return updated.rows.find((candidate) => candidate.path === row.path);
			};
			await this.host.openComparison(row, {
				refresh,
				committed: async () => {
					try {
						await refresh();
					} catch {
						this.failure = "文件已提交。列表未能更新，请点击「刷新变更」。";
						this.renderContent();
					}
				},
			});
		} catch (error) {
			this.failure =
				error instanceof AuthenticationError
					? error.message
					: "无法打开比较，请刷新变更。";
			this.authenticationFailure = error instanceof AuthenticationError;
			if (this.authenticationFailure) this.preview = undefined;
			this.renderContent();
		}
	}
	private async work(task: () => Promise<void>) {
		if (this.busy) return;
		this.busy = true;
		this.preview = undefined;
		this.notice = "";
		this.failure = "";
		this.authenticationFailure = false;
		this.renderContent();
		try {
			await task();
		} catch (error) {
			this.authenticationFailure = error instanceof AuthenticationError;
			if (this.authenticationFailure) this.preview = undefined;
			this.failure =
				error instanceof Error
					? error.message
					: "操作未完成，请刷新变更后重试。";
		} finally {
			this.busy = false;
			this.renderContent();
		}
	}
	private async recover() {
		if (this.busy) return;
		try {
			const engine = this.host.engine();
			const state = await engine.journal.load();
			const confirmed = new Map(
				Object.values(state.pending)
					.filter(
						(intent) => !intent.blocked && !engine.isExcluded(intent.path),
					)
					.map((intent) => [intent.path, intent.id] as const),
			);
			const paths = [...confirmed.keys()];
			if (!paths.length) {
				this.notice = "没有可自动恢复的操作。已阻止的项目请逐个处理冲突。";
				this.renderContent();
				return;
			}
			if (
				!(await openConfirmModal({
					app: this.app,
					title: "恢复未完成操作",
					body: [
						`将尝试完成 ${paths.length} 个未完成操作；发现新修改时停止。`,
						...paths.slice(0, 10),
						...(paths.length > 10 ? ["其余项目可在冲突列表查看。"] : []),
					],
					confirmLabel: "开始恢复",
					cancelLabel: "取消",
				}))
			)
				return;
			await this.work(async () => {
				await engine.recover(confirmed);
				this.preview = await this.host.preview();
			});
		} catch (error) {
			this.failure =
				error instanceof Error ? error.message : "无法恢复，请刷新变更。";
			this.renderContent();
		}
	}
	private async execute(preview: Preview, only?: Row) {
		const rows = (only ? [only] : preview.rows).filter(isWrite);
		if (!rows.length || preview.rows.some((row) => row.kind === "unknown"))
			return;
		const uploads = rows.filter((row) => row.kind === "upload").length;
		const downloads = rows.filter((row) => row.kind === "download").length;
		const deletes = rows.length - uploads - downloads;
		if (
			!(await openConfirmModal({
				app: this.app,
				title: "提交变更",
				body: [
					...(only ? [only.path] : []),
					`上传 ${uploads} · 下载 ${downloads} · 删除 ${deletes}`,
				],
				confirmLabel: "提交",
				cancelLabel: "取消",
			}))
		)
			return;
		if (this.preview !== preview) return this.staleConfirmation();
		await this.work(async () => {
			await this.host.engine().run({ ...preview, rows, writes: rows.length });
			try {
				this.preview = await this.host.engine().refreshPaths(
					preview,
					rows.map((row) => row.path),
				);
			} catch {
				this.notice = "变更已提交。列表未能更新，请点击「刷新变更」。";
			}
		});
	}
	private staleConfirmation() {
		this.failure = "连接或预览已改变，请刷新变更后再确认。";
		this.renderContent();
	}
}
function reason(value: string) {
	return (
		(
			{
				"Incomplete scan; no actions allowed": "读取不完整，本轮停止执行",
				"Shared content matches; local updated excluded":
					"共享内容一致；updated 仅保留本机",
				"Case, normalization or file/folder collision":
					"路径大小写、Unicode 或文件/目录冲突",
				"Unfinished operation requires recovery": "存在未完成操作，请先恢复",
			} as Record<string, string>
		)[value] ?? value
	);
}
export class PlainSettings extends PluginSettingTab {
	private passwordSetting?: Setting;
	private rememberToggle?: ToggleComponent;
	private rememberSetting?: Setting;
	private syncingToggles = new Set<ToggleComponent>();
	private passwordRevision = 0;
	private passwordSaved = 0;
	private passwordScope = "";
	private syncToggle(toggle: ToggleComponent, value: boolean) {
		this.syncingToggles.add(toggle);
		try {
			return toggle.setValue(value);
		} finally {
			this.syncingToggles.delete(toggle);
		}
	}
	private resetInvalidUrl() {
		if (this.host.hasInvalidUrl) {
			this.host.hasInvalidUrl = false;
			this.host.connectionChanged();
		}
	}
	hide() {
		if (this.passwordSetting) this.commitPassword(this.passwordSetting);
		this.resetInvalidUrl();
		super.hide();
	}
	private saves = new WeakMap<Setting, number>();
	private async persist(
		setting: Setting,
		task: () => Promise<boolean>,
		settled: () => void,
	) {
		const request = (this.saves.get(setting) ?? 0) + 1;
		this.saves.set(setting, request);
		setting.setDesc("正在保存…");
		try {
			const credentialsChanged = await task();
			if (credentialsChanged) this.refreshCredentials();
			if (this.saves.get(setting) === request) setting.setDesc("已保存。");
		} catch {
			if (this.saves.get(setting) === request)
				setting.setDesc("保存失败，仍使用原设置，请重新修改后重试。");
		} finally {
			if (this.saves.get(setting) === request) settled();
		}
	}
	private refreshCredentials() {
		this.passwordRevision = 0;
		this.passwordSaved = 0;
		if (this.passwordSetting) this.renderPassword(this.passwordSetting);
		if (this.rememberToggle)
			this.syncToggle(
				this.rememberToggle,
				this.host.settings.passwordMode === "secret",
			);
		this.rememberSetting?.setDesc("仅本次使用，重启后需重新填写。");
	}
	private renderPassword(setting: Setting) {
		const scope = credentialScope(this.host.settings);
		if (scope !== this.passwordScope) {
			this.passwordScope = scope;
			this.passwordRevision = 0;
			this.passwordSaved = 0;
		}
		setting.controlEl.empty();
		setting.setName("密码").setDesc("输入后默认隐藏内容，不能复制或剪切。");
		let value = "";
		try {
			value = this.host.password;
		} catch (error) {
			setting.setDesc(
				error instanceof AuthenticationError
					? error.message
					: "请重新填写密码。",
			);
		}
		setting.addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.autocomplete = "new-password";
			t.inputEl.addEventListener("copy", (event) => event.preventDefault());
			t.inputEl.addEventListener("cut", (event) => event.preventDefault());
			t.setValue(value).onChange((v) => {
				this.passwordRevision++;
				this.host.password = v;
			});
			t.inputEl.addEventListener("blur", () => this.commitPassword(setting));
		});
	}
	private commitPassword(setting: Setting) {
		if (
			this.passwordRevision === this.passwordSaved ||
			this.host.settings.passwordMode !== "secret"
		)
			return;
		const request = this.passwordRevision,
			scope = credentialScope(this.host.settings);
		let keep: boolean;
		try {
			keep = this.host.password !== "";
		} catch (error) {
			setting.setDesc(
				error instanceof AuthenticationError
					? error.message
					: "无法读取密码，请重新填写。",
			);
			return;
		}
		void this.host
			.rememberPassword(keep)
			.then(() => {
				if (scope !== credentialScope(this.host.settings)) return;
				this.passwordSaved = request;
				if (!keep)
					this.rememberSetting?.setDesc("仅本次使用，重启后需重新填写。");
				if (this.passwordRevision === request)
					setting.setDesc(
						keep ? "密码已保存。" : "已清除保存的密码，仅本次使用。",
					);
			})
			.catch((error: unknown) => {
				if (
					this.passwordRevision === request &&
					scope === credentialScope(this.host.settings)
				)
					setting.setDesc(
						error instanceof AuthenticationError
							? error.message
							: "密码修改未保存，重启后仍使用原保存值；请重新聚焦并离开密码框重试。",
					);
			})
			.finally(() => {
				if (this.rememberToggle)
					this.syncToggle(
						this.rememberToggle,
						this.host.settings.passwordMode === "secret",
					);
			});
	}
	constructor(private host: PlainHost) {
		super(host.app, host.plugin);
	}
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "WebDAV 目录 URL",
				desc: "使用 HTTPS 地址；凭据在下方单独填写。无效地址不会保存。",
				aliases: ["WebDAV", "URL", "server", "服务器"],
				render: (setting) => {
					this.resetInvalidUrl();
					setting.addText((t) =>
						t
							.setValue(this.host.settings.url)
							.setPlaceholder("https://dav.example.com/notes/")
							.onChange(async (v) => {
								let url: string;
								try {
									url = v.trim() ? collectionUrl(v.trim()).href : "";
								} catch {
									this.saves.set(setting, (this.saves.get(setting) ?? 0) + 1);
									setting.setDesc(
										"地址无效，未保存；关闭设置后继续使用原地址。",
									);
									this.host.hasInvalidUrl = true;
									this.host.connectionChanged();
									t.inputEl.setCustomValidity(
										"请输入不含凭据、查询参数或片段的 WebDAV 目录 URL",
									);
									t.inputEl.setAttribute("aria-invalid", "true");
									return;
								}
								this.host.hasInvalidUrl = false;
								t.inputEl.setCustomValidity("");
								t.inputEl.removeAttribute("aria-invalid");
								await this.persist(
									setting,
									() => this.host.updateSettings({ url }),
									() => {
										if (!this.host.hasInvalidUrl)
											t.setValue(this.host.settings.url);
									},
								);
							}),
					);
				},
			},
			{
				name: "用户名",
				aliases: ["username", "account"],
				render: (setting) => {
					setting.addText((t) =>
						t
							.setValue(this.host.settings.username)
							.onChange(async (username) => {
								await this.persist(
									setting,
									() => this.host.updateSettings({ username }),
									() => {
										t.setValue(this.host.settings.username);
									},
								);
							}),
					);
				},
			},
			{
				name: "密码",
				aliases: ["password"],
				render: (setting) => {
					this.passwordSetting = setting;
					this.renderPassword(setting);
				},
			},
			{
				name: "记住密码",
				desc: "开启后在本机保存，重启不用重填；关闭则仅本次使用。",
				aliases: ["remember password", "secret storage"],
				render: (setting) => {
					this.rememberSetting = setting;
					setting.addToggle((toggle) => {
						this.rememberToggle = toggle;
						toggle
							.setValue(this.host.settings.passwordMode === "secret")
							.onChange(async (enabled) => {
								if (this.syncingToggles.has(toggle)) return;
								const revision = this.passwordRevision,
									scope = credentialScope(this.host.settings);
								toggle.setDisabled(true);
								try {
									await this.host.rememberPassword(enabled);
									if (enabled && scope === credentialScope(this.host.settings))
										this.passwordSaved = Math.max(this.passwordSaved, revision);
									setting.setDesc(
										enabled
											? "已记住密码，重启后可继续使用。"
											: "仅本次使用，重启后需重新填写。",
									);
								} catch (error) {
									setting.setDesc(
										error instanceof AuthenticationError
											? error.message
											: "保存失败，请重试。",
									);
								} finally {
									this.syncToggle(
										toggle,
										this.host.settings.passwordMode === "secret",
									).setDisabled(false);
								}
							});
					});
				},
			},
			{
				name: "排除同步文件夹",
				desc: "每行填写一个库内相对路径。两端都会跳过该文件夹及其内容。",
				aliases: ["exclude", "ignore", "屏蔽", "忽略"],
				render: (setting) => {
					setting.addTextArea((field) => {
						field
							.setValue(this.host.settings.excludedFolders.join("\n"))
							.setPlaceholder(".alma\n项目/缓存");
						field.inputEl.rows = 3;
						field.inputEl.setAttribute("aria-label", "排除同步文件夹");
						setting.addButton((save) => {
							save.setButtonText("保存").onClick(async () => {
								let excludedFolders: string[];
								try {
									excludedFolders = parseExcludedFolders(field.getValue());
								} catch {
									setting.setDesc(
										"路径无效。每行填写一个库内相对路径，如 .alma 或 项目/缓存。",
									);
									return;
								}
								save.setDisabled(true);
								field.setDisabled(true);
								await this.persist(
									setting,
									() => this.host.updateSettings({ excludedFolders }),
									() => {
										save.setDisabled(false);
										field.setDisabled(false);
									},
								);
							});
						});
					});
				},
			},
		];
	}
}

function readVolume(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
