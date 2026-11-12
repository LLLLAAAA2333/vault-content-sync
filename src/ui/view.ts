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
	type WorkspaceLeaf,
} from "obsidian";
import { collectionUrl, isLoopback } from "../sync/connection";
import type { PlainEngine } from "../sync/engine";
import {
	EXCLUDED,
	type Preview,
	type Row,
	type ScanProgress,
} from "../sync/model";
import {
	type ConflictDetail,
	describeConflict,
	type Fragment,
} from "./conflict-detail";
import { modalHint, openConfirmModal } from "./modal";

export interface PlainHost {
	app: App;
	plugin: Plugin;
	settings: { url: string; username: string; mock: boolean };
	password: string;
	hasInvalidUrl?: boolean;
	save(): Promise<void>;
	engine(): PlainEngine;
	testConnection(): Promise<void>;
	openPreview(): Promise<PlainPreview>;
	openComparison(row: Row): Promise<void>;
	invalidateComparison(): void;
}
const labels: Record<Row["kind"], string> = {
	equal: "一致",
	upload: "待上传",
	download: "待下载",
	"delete-local": "待删除本地",
	"delete-remote": "待删除远端",
	conflict: "冲突",
	unknown: "未核实",
	excluded: "已排除",
};
async function checkConnection(host: PlainHost): Promise<string> {
	if (host.hasInvalidUrl || !host.settings.url)
		throw new Error("请先在设置中填写有效的 WebDAV 文件夹地址。");
	const { url, username } = host.settings;
	const password = host.password;
	await host.testConnection();
	if (
		host.hasInvalidUrl ||
		url !== host.settings.url ||
		username !== host.settings.username ||
		password !== host.password
	)
		throw new Error("连接设置已改变，请重新测试。");
	return "连接正常 · 目录可读，未读取笔记";
}
function allowsWrite(host: PlainHost): boolean {
	try {
		return host.settings.mock && isLoopback(collectionUrl(host.settings.url));
	} catch {
		return false;
	}
}
function icon(parent: HTMLElement, name: string, cls = "ocs-file-icon") {
	const el = parent.createSpan({ cls });
	el.setAttribute("aria-hidden", "true");
	setIcon(el, name);
	return el;
}

export const SYNC_VIEW_TYPE = "vault-content-sync-changes";

export class PlainPreview extends ItemView {
	private selected?: {
		path: string;
		loading: boolean;
		detail?: ConflictDetail;
		error?: string;
	};
	private selectionRequest = 0;
	private collapsedGroups = new Set<string>();
	private preview?: Preview;
	private busy = false;
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
		this.selectionRequest++;
		this.selected = undefined;
		this.contentEl.empty();
	}
	refreshPresentation() {
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
	private renderContent() {
		this.contentEl.empty();
		this.contentEl.addClass("ocs-content");
		const header = this.contentEl.createDiv({ cls: "ocs-sidebar-heading" });
		header.createEl("h2", { text: "内容同步" });
		const actions = header.createDiv({ cls: "ocs-header-actions" });
		let address: URL | undefined;
		try {
			address = collectionUrl(this.host.settings.url);
		} catch {
			/* Setup required. */
		}
		if (this.host.hasInvalidUrl) address = undefined;
		this.iconButton(
			actions,
			"refresh-cw",
			"核验内容",
			() =>
				void this.work(async () => {
					this.preview = await this.host
						.engine()
						.preview((progress) => this.updateProgress(progress));
				}),
		).setDisabled(this.busy || !address);
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
		const endpoint = this.contentEl.createDiv({ cls: "ocs-endpoint" });
		icon(endpoint, "folder", "ocs-endpoint-icon");
		const target = endpoint.createSpan({
			cls: "ocs-target-name",
			text:
				address?.pathname.split("/").filter(Boolean).pop() ||
				address?.host ||
				"尚未配置连接",
		});
		target.title = address?.href || "请在插件设置中填写连接信息";
		endpoint.createSpan({
			cls: "ocs-mode",
			text: allowsWrite(this.host) ? "本机测试" : "只读",
		});
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
		this.status = this.contentEl.createDiv({
			cls: "ocs-status",
			text: this.busy ? "正在核验…" : "",
		});
		this.status.setAttribute("role", "status");
		this.progress = undefined;
		if (this.busy) {
			this.progress = this.contentEl.createEl("progress", {
				cls: "ocs-progress",
			});
			this.progress.setAttribute("aria-label", "内容核验进度");
		} else if (this.preview) {
			this.list = this.contentEl.createDiv({ cls: "ocs-list" });
			this.renderRows();
			const conflicts = this.preview.rows.filter(
				(r) => r.kind === "conflict",
			).length;
			const unknown = this.preview.rows.filter(
				(r) => r.kind === "unknown",
			).length;
			const summary = this.contentEl.createDiv({
				cls: "ocs-summary",
				text: `待同步 ${this.preview.writes} · 冲突 ${conflicts} · 未核实 ${unknown}`,
			});
			summary.title = `核验读取 ${readVolume(this.preview.readBytes)}；Markdown 顶层 updated 仅保留本机。`;
		} else
			this.contentEl.createDiv({
				cls: "ocs-empty-note",
				text: address
					? "点击刷新，查看两端文件变化。"
					: "请先在插件设置中填写地址并测试连接。",
			});
	}
	private showMenu(anchor: HTMLElement, row?: Row) {
		const menu = new Menu();
		menu.setUseNativeMenu(false);
		if (row) {
			menu.addItem((item) =>
				item
					.setTitle("比较内容")
					.setIcon("columns-2")
					.onClick(() => void this.host.openComparison(row)),
			);
			if (row.kind === "conflict")
				menu.addItem((item) =>
					item
						.setTitle("快速预览")
						.setIcon("eye")
						.setChecked(this.selected?.path === row.path)
						.onClick(() => void this.showConflict(row)),
				);
			if (row.kind === "conflict" && allowsWrite(this.host)) {
				menu.addSeparator();
				for (const [choice, label] of [
					["local", "采用本地"],
					["remote", "采用远端"],
					["merge", "合并文本"],
				] as const)
					menu.addItem((item) =>
						item.setTitle(label).onClick(() => void this.resolve(row, choice)),
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
			if (allowsWrite(this.host)) {
				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("恢复未完成操作")
						.setIcon("history")
						.onClick(
							() =>
								void this.work(async () => {
									await this.host.engine().recover();
									this.preview = await this.host.engine().preview();
								}),
						),
				);
				const current = this.preview;
				menu.addItem((item) =>
					item
						.setTitle("执行当前计划")
						.setIcon("check")
						.setDisabled(
							!current || current.rows.some((r) => r.kind === "unknown"),
						)
						.onClick(() => {
							if (current) void this.execute(current);
						}),
				);
			}
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
				: `正在核验${side} · ${progress.completed} / ${progress.total} 个文件 · 已读取 ${readVolume(progress.bytes)}`,
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
			["未核实", ["unknown"]],
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
					trigger.setAttribute("aria-label", `比较内容：${row.path}`);
					trigger.onclick = () => void this.host.openComparison(row);
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
					if (row.kind === "conflict") {
						const quick = this.iconButton(
							actions,
							"eye",
							`快速预览：${row.path}`,
							() => void this.showConflict(row),
						);
						quick.buttonEl.setAttribute(
							"aria-expanded",
							String(this.selected?.path === row.path),
						);
					}
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
				if (this.selected?.path === row.path) {
					item.addClass("is-selected");
					this.renderConflict(item);
				}
			}
		}
		if (!rows.length)
			list.createDiv({
				cls: "ocs-empty-note",
				text: this.query
					? "没有匹配的文件，试试其他名称或路径。"
					: "这个范围没有待处理文件。",
			});
		if (shown < rows.length)
			modalHint(
				list,
				`显示 ${shown} / ${rows.length} 项，可输入文件名或路径缩小范围。`,
			);
	}
	private refreshConflictRows() {
		// Keep file controls mounted: a delayed response must not remove whichever
		// list item the user has reached with the keyboard while it was loading.
		for (const item of this.list?.querySelectorAll<HTMLElement>(".ocs-row") ??
			[]) {
			const quick = Array.from(
				item.querySelectorAll<HTMLButtonElement>(".ocs-row-actions button"),
			).find((button) =>
				button.getAttribute("aria-label")?.startsWith("快速预览："),
			);
			if (!quick) continue;
			const selected =
				quick.getAttribute("aria-label") === `快速预览：${this.selected?.path}`;
			quick.setAttribute("aria-expanded", String(selected));
			item.toggleClass("is-selected", selected);
			item.querySelector(".ocs-conflict-detail")?.remove();
			if (selected) this.renderConflict(item);
		}
	}
	private async showConflict(row: Row) {
		if (this.busy) return;
		const request = ++this.selectionRequest;
		const { url, username } = this.host.settings;
		const password = this.host.password;
		if (this.selected?.path === row.path) {
			this.selected = undefined;
			this.refreshConflictRows();
			return;
		}
		this.selected = { path: row.path, loading: true };
		this.refreshConflictRows();
		try {
			const texts = await this.host.engine().inspect(row);
			if (
				url !== this.host.settings.url ||
				username !== this.host.settings.username ||
				password !== this.host.password ||
				this.host.hasInvalidUrl
			)
				throw new Error("Connection changed");
			if (request !== this.selectionRequest) return;
			this.selected = {
				path: row.path,
				loading: false,
				detail: describeConflict(texts),
			};
		} catch {
			if (request !== this.selectionRequest) return;
			this.selected = {
				path: row.path,
				loading: false,
				error: "无法读取当前版本，文件可能已变化。请重新核验后再查看。",
			};
		}
		this.refreshConflictRows();
	}
	private renderConflict(parent: HTMLElement) {
		const selected = this.selected;
		if (!selected) return;
		const detail = parent.createDiv({ cls: "ocs-conflict-detail" });
		detail.setAttribute("role", "region");
		detail.setAttribute("aria-label", `冲突详情：${selected.path}`);
		const message = detail.createDiv({
			cls: "ocs-conflict-message",
			text: selected.loading
				? "正在读取并定位冲突…"
				: (selected.error ?? selected.detail?.message ?? ""),
		});
		message.setAttribute("role", "status");
		if (selected.error) message.addClass("is-error");
		for (const [index, region] of (
			selected.detail?.fragments ?? []
		).entries()) {
			const block = detail.createEl("details", { cls: "ocs-conflict-region" });
			block.open = index === 0;
			block.createEl("summary", { text: region.label });
			this.renderFragment(block, "本地", region.local, "local");
			this.renderFragment(block, "远端", region.remote, "remote");
			if (region.base) {
				const base = block.createEl("details", { cls: "ocs-conflict-base" });
				base.createEl("summary", { text: "查看共同版本" });
				this.renderFragment(base, "共同版本", region.base, "base");
			}
		}
		if (selected.detail?.omitted)
			detail.createDiv({
				cls: "ocs-conflict-message",
				text: `另有 ${selected.detail.omitted} 处未展开，请打开完整比较。`,
			});
	}
	private renderFragment(
		parent: HTMLElement,
		label: string,
		value: Fragment,
		side: string,
	) {
		const block = parent.createDiv({ cls: `ocs-fragment is-${side}` });
		block.createDiv({ cls: "ocs-fragment-label", text: label });
		block
			.createEl("pre", { text: value.text || "（此片段为空）" })
			.setAttribute("aria-label", `${label}冲突片段`);
		if (value.truncated)
			block.createDiv({
				cls: "ocs-fragment-truncated",
				text: "片段已截断；完整内容见“比较内容”。",
			});
	}
	private async work(task: () => Promise<void>) {
		if (this.busy) return;
		this.selectionRequest++;
		this.selected = undefined;
		this.host.invalidateComparison();
		this.busy = true;
		this.renderContent();
		let error = "";
		try {
			await task();
		} catch (e) {
			error = `操作已停止：${e instanceof Error ? e.message : "无法完成"}。请重新核验；已有恢复版本会保留。`;
		} finally {
			this.busy = false;
			this.renderContent();
			if (error) {
				this.status?.setText(error);
				this.status?.addClass("is-error");
			}
		}
	}
	private async execute(p: Preview) {
		if (
			!(await openConfirmModal({
				app: this.app,
				title: "执行同步计划",
				body: [
					`将改写 ${p.writes} 个普通文件。覆盖和删除前保存恢复版本；冲突与排除项保持原状。`,
				],
				confirmLabel: "执行同步",
				cancelLabel: "返回预览",
			}))
		)
			return;
		await this.work(async () => {
			await this.host.engine().run(p);
			this.preview = await this.host.engine().preview();
		});
	}
	private async resolve(row: Row, choice: "local" | "remote" | "merge") {
		if (
			!(await openConfirmModal({
				app: this.app,
				title: "处理冲突",
				body: [
					row.path,
					choice === "merge"
						? "尝试合并不重叠的文本修改；有重叠则停止。"
						: "所选共享内容将同步到两端；本机 updated 保留，原始版本保存在本地恢复目录。",
				],
				confirmLabel: "应用选择",
				cancelLabel: "取消",
			}))
		)
			return;
		await this.work(async () => {
			await this.host.engine().resolve(row, choice);
			this.preview = await this.host.engine().preview();
		});
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
	private connectionSetting?: Setting;
	private invalidateConnection() {
		this.connectionSetting?.setDesc(
			"当前配置尚未测试。只检查目录，不读取笔记、不写入文件。",
		);
	}
	constructor(private host: PlainHost) {
		super(host.app, host.plugin);
	}
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "连接与预览",
				desc: "默认不连接、不自动同步。填写明确的 WebDAV 资料库目录，再手动预览。密码仅在本次插件会话内保存。",
			},
			{
				name: "WebDAV 目录 URL",
				desc: "使用 HTTPS 地址；凭据在下方单独填写。无效地址不会保存。",
				aliases: ["WebDAV", "URL", "server", "服务器"],
				render: (setting) => {
					setting.addText((t) =>
						t
							.setValue(this.host.settings.url)
							.setPlaceholder("https://dav.example.com/notes/")
							.onChange((v) => {
								this.invalidateConnection();
								try {
									const value = v.trim();
									this.host.hasInvalidUrl = false;
									this.host.settings.url = value
										? collectionUrl(value).href
										: "";
									t.inputEl.setCustomValidity("");
									t.inputEl.removeAttribute("aria-invalid");
									void this.host.save();
								} catch {
									this.host.hasInvalidUrl = true;
									t.inputEl.setCustomValidity(
										"请输入不含凭据、查询参数或片段的 WebDAV 目录 URL",
									);
									t.inputEl.setAttribute("aria-invalid", "true");
								}
							}),
					);
				},
			},
			{
				name: "用户名",
				aliases: ["username", "account"],
				render: (setting) => {
					setting.addText((t) =>
						t.setValue(this.host.settings.username).onChange((v) => {
							this.invalidateConnection();
							this.host.settings.username = v;
							void this.host.save();
						}),
					);
				},
			},
			{
				name: "密码（仅本次会话）",
				aliases: ["password"],
				render: (setting) => {
					setting.addText((t) => {
						t.inputEl.type = "password";
						t.setValue(this.host.password).onChange((v) => {
							this.invalidateConnection();
							this.host.password = v;
						});
					});
				},
			},
			{
				name: "测试连接",
				desc: "只检查地址、身份验证和目录，不读取笔记、不写入文件。",
				aliases: ["test connection", "WebDAV"],
				render: (setting) => {
					this.connectionSetting = setting;
					setting.addButton((button) =>
						button.setButtonText("测试连接").onClick(async () => {
							setting.setDesc("正在测试当前配置…");
							button.setDisabled(true).setButtonText("正在测试…");
							try {
								setting.setDesc(await checkConnection(this.host));
							} catch (error) {
								setting.setDesc(
									error instanceof Error
										? error.message
										: "连接失败，请检查设置。",
								);
							} finally {
								button.setDisabled(false).setButtonText("测试连接");
							}
						}),
					);
				},
			},
			{
				name: "隔离模拟服务写入",
				desc: "仅用于随附的本机模拟服务；不会开放外部 WebDAV 写入。",
				aliases: ["mock", "write"],
				render: (setting) => {
					setting.addToggle((t) =>
						t.setValue(this.host.settings.mock).onChange((v) => {
							this.host.settings.mock = v;
							void this.host.save();
						}),
					);
				},
			},
			{
				name: "查看同步计划",
				desc: "每次完整读取文件内容，不使用时间戳缓存。",
				aliases: ["preview", "compare"],
				render: (setting) => {
					setting.addButton((b) =>
						b
							.setButtonText("打开预览")
							.onClick(() => void this.host.openPreview()),
					);
				},
			},
			{
				name: "内容规则",
				desc: "Markdown 顶层 updated 仅保留本机，正文、其他属性和附件参与核验；没有共同版本时不自动合并不同内容。",
			},
			{
				name: "排除规则",
				desc: `排除：${[...new Set([...EXCLUDED, this.app.vault.configDir])].join("、")}、符号链接。恢复内容位于 .plain-sync，首版不自动清理。`,
			},
		];
	}
}

function readVolume(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
