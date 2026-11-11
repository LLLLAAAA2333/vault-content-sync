import {
	type App,
	ButtonComponent,
	Modal,
	type Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { collectionUrl } from "../sync/connection";
import type { PlainEngine } from "../sync/engine";
import { EXCLUDED, type Preview, type Row } from "../sync/model";
import { modalHint, openConfirmModal, renderModalHead } from "./modal";

export interface PlainHost {
	app: App;
	plugin: Plugin;
	settings: { url: string; username: string; mock: boolean };
	password: string;
	save(): Promise<void>;
	engine(): PlainEngine;
	openPreview(): PlainPreview;
}
const labels: Record<Row["kind"], string> = {
	equal: "一致",
	upload: "待上传",
	download: "待下载",
	"delete-local": "删除本地",
	"delete-remote": "删除远端",
	conflict: "冲突",
	unknown: "未知",
	excluded: "排除",
};
export class PlainPreview extends Modal {
	private preview?: Preview;
	private busy = false;
	private status?: HTMLElement;
	private filter = "changes";
	constructor(private host: PlainHost) {
		super(host.app);
	}
	onOpen() {
		renderModalHead(this, {
			icon: "folder-sync",
			title: "Vault Content Sync",
			sub: "完整核验内容 · updated 仅保留本机",
		});
		this.modalEl.addClass("ocs-modal");
		this.renderContent();
	}
	private renderContent() {
		this.contentEl.empty();
		const target = this.contentEl.createEl("p", {
			cls: "ocs-target",
			text:
				this.host.settings.url || "尚未设置 WebDAV 目录。请先打开插件设置。",
		});
		target.setAttribute("aria-label", "同步目标");
		modalHint(
			this.contentEl,
			this.host.settings.mock
				? "隔离模拟模式：仅允许本机测试服务写入。"
				: "只读模式：服务端并发保证尚未确认，执行功能未开放。",
		);
		modalHint(
			this.contentEl,
			"Markdown 顶部 YAML 的 updated 仅保留在本机；正文和其他属性照常同步。新文件不继承远端 updated，由本机维护。",
		);
		const controls = this.contentEl.createDiv({ cls: "ocs-controls" });
		new ButtonComponent(controls)
			.setButtonText("完整核验 / 刷新预览")
			.setDisabled(this.busy)
			.onClick(
				() =>
					void this.work(async () => {
						this.preview = await this.host.engine().preview();
					}),
			);
		new ButtonComponent(controls)
			.setButtonText("恢复未完成操作")
			.setDisabled(this.busy || !this.host.settings.mock)
			.onClick(
				() =>
					void this.work(async () => {
						await this.host.engine().recover();
						this.preview = await this.host.engine().preview();
					}),
			);
		const p = this.preview;
		if (p) {
			const counts = p.rows.reduce<Record<string, number>>((a, r) => {
				a[r.kind] = (a[r.kind] ?? 0) + 1;
				return a;
			}, {});
			this.contentEl.createEl("p", {
				cls: "ocs-summary",
				text: `核验读取 ${readVolume(p.readBytes)} · 计划改写 ${p.writes} 个文件 · 冲突 ${counts.conflict ?? 0} · 未知 ${counts.unknown ?? 0}`,
			});
			const canRun = this.host.settings.mock && !counts.unknown && !this.busy;
			new ButtonComponent(controls)
				.setButtonText("执行当前计划")
				.setCta()
				.setDisabled(!canRun)
				.onClick(() => void this.execute(p));
			new Setting(this.contentEl).setName("显示范围").addDropdown((d) =>
				d
					.addOptions({
						changes: "待处理",
						all: "全部",
						equal: "一致",
						excluded: "排除",
					})
					.setValue(this.filter)
					.onChange((v) => {
						this.filter = v;
						this.renderContent();
					}),
			);
			const rows = p.rows.filter((r) =>
				this.filter === "all" || this.filter === "changes"
					? !["equal", "excluded"].includes(r.kind) || this.filter === "all"
					: r.kind === this.filter,
			);
			const list = this.contentEl.createDiv({ cls: "ocs-list" });
			list.setAttribute("role", "list");
			for (const row of rows.slice(0, 200)) {
				const item = list.createDiv({ cls: "ocs-row" });
				item.setAttribute("role", "listitem");
				item.createSpan({
					cls: `ocs-kind is-${row.kind}`,
					text: labels[row.kind],
				});
				const name = item.createDiv({
					cls: "ocs-path",
					text: row.path,
				});
				if (row.reason)
					name.createDiv({
						cls: "ocs-reason",
						text: reason(row.reason),
					});
				if (
					row.kind === "conflict" &&
					(!row.reason ||
						row.reason === "Unfinished operation requires recovery")
				) {
					const actions = item.createDiv({ cls: "ocs-controls" });
					new ButtonComponent(actions)
						.setButtonText("比较内容")
						.setDisabled(this.busy)
						.onClick(
							() =>
								void this.work(async () => {
									const sides = await this.host.engine().inspect(row);
									const comparison = new Modal(this.app);
									renderModalHead(comparison, {
										icon: "columns-3",
										title: "内容比较",
										sub: row.path,
									});
									comparison.modalEl.addClass("ocs-modal");
									for (const [key, label] of [
										["base", "共同基线"],
										["local", "本地"],
										["remote", "远端"],
									] as const) {
										comparison.contentEl.createEl("h3", { text: label });
										if (sides[key] === null)
											comparison.contentEl.createEl("p", {
												text: "此端不存在、无共同基线，或文件为二进制 / 超过 1 MiB。",
											});
										else {
											const area = comparison.contentEl.createEl("textarea", {
												cls: "ocs-text",
											});
											area.readOnly = true;
											area.value = sides[key];
											area.setAttribute("aria-label", label);
										}
									}
									comparison.open();
								}),
						);
					for (const [choice, label] of [
						["local", "采用本地"],
						["remote", "采用远端"],
						["merge", "合并文本"],
					] as const)
						new ButtonComponent(actions)
							.setButtonText(label)
							.setDisabled(this.busy || !this.host.settings.mock)
							.onClick(() => void this.resolve(row, choice));
				}
			}
			if (!rows.length)
				list.createEl("p", { text: "这个范围没有待处理文件。" });
			if (rows.length > 200)
				modalHint(
					this.contentEl,
					`当前展示前 200 项，共 ${rows.length} 项；命令行可输出完整计划。`,
				);
		}
		const exclusions = this.contentEl.createEl("details");
		exclusions.createEl("summary", { text: "默认排除规则" });
		exclusions.createEl("p", {
			text: `各层级排除 ${EXCLUDED.join("、")}；另排除当前配置目录 ${this.app.vault.configDir} 及其内容，以及符号链接。其余扩展名均参与同步。`,
		});
		this.status = this.contentEl.createDiv({
			cls: "ocs-status",
			text: this.busy ? "正在读取和核验，请稍候…" : "",
		});
		this.status.setAttribute("role", "status");
	}
	private async work(task: () => Promise<void>) {
		if (this.busy) return;
		this.busy = true;
		this.renderContent();
		let error = "";
		try {
			await task();
		} catch (e) {
			error = `操作已停止：${e instanceof Error ? e.message : "无法完成"}。请刷新预览；已有恢复版本会保留。`;
		} finally {
			this.busy = false;
			this.renderContent();
			if (error) this.status?.setText(error);
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
	constructor(private host: PlainHost) {
		super(host.app, host.plugin);
	}
	display() {
		this.containerEl.empty();
		this.containerEl.createEl("p", {
			text: "默认不连接、不自动同步。填写明确的 WebDAV 资料库目录，再手动预览。密码仅在本次插件会话内保存。",
		});
		new Setting(this.containerEl)
			.setName("WebDAV 目录 URL")
			.setDesc("使用 HTTPS 地址；凭据在下方单独填写。无效地址不会保存。")
			.addText((t) =>
				t
					.setValue(this.host.settings.url)
					.setPlaceholder("https://dav.example.com/notes/")
					.onChange((v) => {
						try {
							const value = v.trim();
							this.host.settings.url = value ? collectionUrl(value).href : "";
							t.inputEl.setCustomValidity("");
							t.inputEl.removeAttribute("aria-invalid");
							void this.host.save();
						} catch {
							t.inputEl.setCustomValidity(
								"请输入不含凭据、查询参数或片段的 WebDAV 目录 URL",
							);
							t.inputEl.setAttribute("aria-invalid", "true");
						}
					}),
			);
		new Setting(this.containerEl).setName("用户名").addText((t) =>
			t.setValue(this.host.settings.username).onChange((v) => {
				this.host.settings.username = v;
				void this.host.save();
			}),
		);
		new Setting(this.containerEl).setName("密码（仅本次会话）").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(this.host.password).onChange((v) => {
				this.host.password = v;
			});
		});
		new Setting(this.containerEl)
			.setName("隔离模拟服务写入")
			.setDesc("仅用于随附的本机模拟服务；不会开放外部 WebDAV 写入。")
			.addToggle((t) =>
				t.setValue(this.host.settings.mock).onChange((v) => {
					this.host.settings.mock = v;
					void this.host.save();
				}),
			);
		new Setting(this.containerEl)
			.setName("查看同步计划")
			.setDesc("每次完整读取文件内容，不使用时间戳缓存。")
			.addButton((b) =>
				b
					.setButtonText("打开预览")
					.onClick(() => new PlainPreview(this.host).open()),
			);
		this.containerEl.createEl("p", {
			text: `排除：${[...new Set([...EXCLUDED, this.app.vault.configDir])].join("、")}、符号链接。恢复内容位于 .plain-sync，首版不自动清理。`,
		});
	}
}

function readVolume(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
