import { ButtonComponent, ItemView } from "obsidian";
import { mergeText } from "../merge";
import { AuthenticationError } from "../sync/auth";
import { isMarkdown } from "../sync/content";
import type { ConflictChoice, PlainEngine } from "../sync/engine";
import type { Row } from "../sync/model";
import type { ComparedText } from "./conflict-detail";
import {
	compareLines,
	type DisplayLine,
	type DisplayRow,
} from "./line-comparison";

export const COMPARISON_VIEW_TYPE = "vault-content-sync-comparison";

type Side = "local" | "remote";
type Block = { rows: DisplayRow[]; changed: boolean; choice?: Side };
type ReviewActions = {
	committed?: () => Promise<void>;
	refresh?: () => Promise<Row | undefined>;
};

function groupRows(rows: DisplayRow[]): Block[] {
	const blocks: Block[] = [];
	for (const row of rows) {
		const previous = blocks.at(-1);
		if (previous?.changed === row.changed) previous.rows.push(row);
		else blocks.push({ rows: [row], changed: row.changed });
	}
	return blocks;
}

function resultText(blocks: Block[]): string {
	return blocks
		.map((block) =>
			block.rows
				.map((row) => row[block.choice ?? "local"]?.text ?? "")
				.join(""),
		)
		.join("");
}

export class ComparisonView extends ItemView {
	private request = 0;
	private row?: Row;
	private staged = false;
	get hasDraft() {
		return this.staged;
	}
	shows(path: string) {
		return this.row?.path === path;
	}
	getViewType() {
		return COMPARISON_VIEW_TYPE;
	}
	getDisplayText() {
		return "审查变更";
	}
	getIcon() {
		return "columns-2";
	}
	getState() {
		return {};
	}
	async onOpen() {
		this.contentEl.addClass("ocs-comparison-view");
		this.contentEl.setText("从侧栏选择文件，查看差异或处理冲突。");
	}
	async onClose() {
		this.request++;
		this.contentEl.empty();
	}
	invalidate() {
		this.request++;
		this.row = undefined;
		this.staged = false;
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "ocs-compare-notice",
			text: "连接已改变，请从侧栏重新选择文件。",
		});
	}

	async show(
		row: Row,
		engine: PlainEngine,
		stillCurrent: () => boolean,
		actions: ReviewActions = {},
		oldDraft?: string,
	) {
		if (
			oldDraft === undefined &&
			this.staged &&
			this.row?.path === row.path &&
			this.row.local?.hash === row.local?.hash &&
			this.row.remote?.hash === row.remote?.hash
		)
			return;
		this.row = row;
		this.staged = !!oldDraft;
		const request = ++this.request;
		this.contentEl.empty();
		const head = this.contentEl.createDiv({ cls: "ocs-compare-header" });
		head.createDiv({ cls: "ocs-compare-path", text: row.path });
		const message = this.contentEl.createDiv({
			cls: "ocs-compare-notice",
			text: "正在读取两端版本…",
		});
		message.setAttribute("role", "status");
		const refresh = async (draft?: string) => {
			if (!stillCurrent()) throw new Error("连接已改变，请重新打开此文件。");
			const fresh = await actions.refresh?.();
			if (request !== this.request) return;
			if (!fresh) throw new Error("此文件已从变更列表移除。");
			await this.show(
				fresh,
				engine,
				stillCurrent,
				actions,
				draft ?? oldDraft ?? "",
			);
		};
		try {
			if (
				row.kind === "conflict" &&
				(await engine.recordCompletedCommit(row.path))
			) {
				if (request === this.request) {
					this.staged = false;
					message.setText("上次提交已完成。两端正文一致。");
				}
				await actions.committed?.();
				return;
			}
			const texts = await engine.inspect(row);
			if (request !== this.request) return;
			if (!stillCurrent()) throw new Error("连接已改变，请重新打开此文件。");
			message.remove();
			if (oldDraft) {
				const carried = this.contentEl.createEl("details", {
					cls: "ocs-carried-draft",
				});
				carried.createEl("summary", { text: "刷新前的草稿" });
				this.rawText(carried, "旧草稿", oldDraft);
			}
			const panes = this.contentEl.createDiv({ cls: "ocs-review-body" });
			const diff = panes.createDiv({ cls: "ocs-review-diff" });
			const alignment =
				texts.local !== null && texts.remote !== null
					? compareLines(texts.local, texts.remote)
					: null;
			const blocks =
				alignment?.status === "ready" ? groupRows(alignment.rows) : [];
			const editable =
				isMarkdown(row.path) &&
				!/\.excalidraw\.md$/i.test(row.path) &&
				texts.local !== null &&
				texts.remote !== null;
			const collision =
				row.reason === "Case, normalization or file/folder collision";
			if (collision) message.setText("两端路径冲突。请重命名后刷新变更。");
			if (collision) diff.append(message);
			const commit =
				row.kind === "conflict" && !collision
					? this.renderResult(
							panes,
							row,
							texts,
							editable,
							blocks,
							async (choice) => {
								if (request !== this.request || !stillCurrent())
									throw new Error("连接已改变，请重新打开此文件。");
								if (await engine.recordCompletedCommit(row.path))
									return "already-complete";
								await engine.resolve(row, choice);
								return "applied";
							},
							refresh,
							actions.committed,
						)
					: undefined;
			this.renderDiff(
				diff,
				texts,
				blocks,
				commit && editable ? commit.choose : undefined,
			);
			if (commit) commit.sync();
		} catch (error) {
			if (request !== this.request) return;
			let failure = error;
			try {
				if (!stillCurrent())
					failure = new Error("连接已改变，请重新打开此文件。");
			} catch (currentError) {
				failure = currentError;
			}
			message.setText(
				failure instanceof AuthenticationError
					? failure.message
					: this.commitError(failure),
			);
			message.addClass("is-error");
			if (!message.isConnected) this.contentEl.append(message);
			if (failure instanceof AuthenticationError) throw failure;
			if (actions.refresh)
				new ButtonComponent(this.contentEl)
					.setButtonText("刷新此文件")
					.onClick(async () => {
						try {
							await refresh();
						} catch (refreshError) {
							message.setText(this.commitError(refreshError));
						}
					});
		}
	}

	private renderResult(
		panes: HTMLElement,
		row: Row,
		texts: ComparedText,
		editable: boolean,
		blocks: Block[],
		commitChoice: (
			choice: ConflictChoice,
		) => Promise<"applied" | "already-complete">,
		refresh: (draft?: string) => Promise<void>,
		onCommit?: () => Promise<void>,
	) {
		const panel = panes.createDiv({ cls: "ocs-resolution" });
		const header = panel.createDiv({ cls: "ocs-result-header" });
		header.createEl("h3", { text: "合并结果" });
		const actions = header.createDiv({ cls: "ocs-resolution-picker" });
		const draft = panel.createEl("textarea", {
			cls: "ocs-text ocs-resolution-draft",
		});
		draft.setAttribute("aria-label", "合并结果");
		draft.spellcheck = false;
		draft.readOnly = true;
		draft.hidden = !editable;
		const footer = panel.createDiv({ cls: "ocs-resolution-footer" });
		const status = footer.createDiv({ cls: "ocs-resolution-status" });
		status.setAttribute("role", "status");
		const submit = new ButtonComponent(footer)
			.setButtonText("提交结果")
			.setCta()
			.setDisabled(true);
		const retry = new ButtonComponent(footer).setButtonText("刷新此文件");
		retry.buttonEl.hidden = true;
		const changed = blocks.filter((block) => block.changed);
		let side: Side | undefined;
		let manual = false;
		let initial = "";
		let edited: string | undefined;
		let busy = false;
		let committed = false;
		let stale = false;
		const fileButtons = new Map<Side, ButtonComponent>();
		let edit: ButtonComponent | undefined;
		const currentResult = () =>
			side
				? (texts[side] ?? "")
				: blocks.length
					? resultText(blocks)
					: (texts.local ?? "");
		const sync = () => {
			if (busy || committed) return;
			const remaining = changed.filter((block) => !block.choice).length;
			draft.readOnly = !manual;
			status.toggleClass("is-error", stale);
			if (!stale) {
				status.setText(
					manual
						? "手动编辑中"
						: side
							? `将${side === "local" ? "本地" : "远端"}结果同步到两端`
							: editable && changed.length
								? `已选择 ${changed.length - remaining} / ${changed.length} 处`
								: "选择要保留的版本",
				);
			}
			if (editable && !manual) draft.value = currentResult();
			edit?.setButtonText(manual ? "返回逐段选择" : "手动编辑");
			for (const [value, button] of fileButtons)
				button.buttonEl.setAttribute(
					"aria-pressed",
					String(!manual && side === value),
				);
			for (const button of panes.querySelectorAll<HTMLButtonElement>(
				"button.ocs-hunk-choice",
			))
				button.disabled = manual || stale;
			submit.setDisabled(
				stale || (!manual && !side && (!changed.length || remaining > 0)),
			);
		};
		for (const [value, title, missing] of [
			["local", "全部用本地", "删除远端文件"],
			["remote", "全部用远端", "删除本地文件"],
		] as const) {
			if (!row.local && !row.remote) continue;
			const button = new ButtonComponent(actions).setButtonText(
				row[value] ? title : missing,
			);
			button.onClick(() => {
				if (busy || committed || stale) return;
				if (manual) edited = draft.value;
				manual = false;
				side = value;
				this.staged = true;
				for (const block of changed) block.choice = value;
				panes
					.querySelectorAll<HTMLButtonElement>(".ocs-hunk-choice")
					.forEach((control) => {
						control.setAttribute(
							"aria-pressed",
							String(control.dataset.side === value),
						);
					});
				sync();
			});
			fileButtons.set(value, button);
		}
		if (editable) {
			edit = new ButtonComponent(actions).setButtonText("手动编辑");
			edit.onClick(() => {
				if (busy || committed || stale) return;
				if (manual) {
					edited = draft.value;
					manual = false;
					sync();
					return;
				}
				if (edited === undefined) {
					const merged =
						!side &&
						changed.every((block) => !block.choice) &&
						texts.base !== null &&
						texts.local !== null &&
						texts.remote !== null
							? mergeText(texts.base, texts.local, texts.remote)
							: undefined;
					initial = merged?.status === "merged" ? merged.text : currentResult();
				}
				manual = true;
				this.staged = true;
				draft.value = edited ?? initial;
				sync();
				draft.focus();
			});
		}
		retry.onClick(async () => {
			retry.setDisabled(true);
			try {
				await refresh(
					editable
						? manual
							? draft.value
							: (edited ?? currentResult())
						: undefined,
				);
			} catch (error) {
				status.setText(this.commitError(error));
				retry.setDisabled(false);
			}
		});
		submit.onClick(async () => {
			if (busy || committed || stale) return;
			if (
				!manual &&
				!side &&
				(!changed.length || changed.some((block) => !block.choice))
			)
				return;
			const choice = manual
				? { text: this.draftText(initial, draft.value) }
				: (side ?? { text: currentResult() });
			busy = true;
			submit.setDisabled(true).setButtonText("正在提交…");
			draft.readOnly = true;
			status.removeClass("is-error");
			let outcome: "applied" | "already-complete";
			try {
				outcome = await commitChoice(choice);
			} catch (error) {
				busy = false;
				const message = error instanceof Error ? error.message : "";
				stale =
					/precondition failed|Content changed|newer edit|Local changed|File changed during read|Final agreement unconfirmed/.test(
						message,
					);
				sync();
				submit.setButtonText("提交结果");
				retry.buttonEl.hidden = !stale;
				status.addClass("is-error");
				status.setText(this.commitError(error));
				return;
			}
			committed = true;
			this.staged = false;
			actions.remove();
			submit.buttonEl.remove();
			for (const controls of panes.querySelectorAll(".ocs-hunk-controls"))
				controls.remove();
			status.setText(
				outcome === "already-complete"
					? "上次提交已完成。两端正文一致。"
					: "已提交，两端正文一致。",
			);
			await onCommit?.();
		});
		return {
			sync,
			choose: (block: Block, value: Side) => {
				if (busy || committed || stale || manual) return false;
				side = undefined;
				block.choice = value;
				this.staged = true;
				sync();
				return true;
			},
		};
	}

	private draftText(initial: string, edited: string): string {
		if (initial.replace(/\r\n?/g, "\n") === edited) return initial;
		if (initial.includes("\r\n") && !/(^|[^\r])\n/.test(initial))
			return edited.replace(/\n/g, "\r\n");
		return edited;
	}
	private commitError(error: unknown): string {
		if (!(error instanceof Error)) return "提交未完成，请重试。";
		if (
			/precondition failed|Content changed|newer edit|Local changed|File changed during read/.test(
				error.message,
			)
		)
			return "内容已变化。刷新此文件可查看新差异，草稿会保留。";
		if (
			/Markdown frontmatter|Frontmatter aliases|Unsupported frontmatter/.test(
				error.message,
			)
		)
			return "合并结果开头的 YAML 属性有冲突，请编辑结果后再提交。";
		if (error.message === "Final agreement unconfirmed")
			return "写入已完成，结果尚未确认。请刷新此文件。";
		if (error.message === "Strong ETag required")
			return "WebDAV 未返回可用于条件覆盖的版本号，提交已停止。";
		if (error.message.includes("holds the journal"))
			return "另一项提交正在进行，请稍后重试。";
		return error.message;
	}

	private renderDiff(
		parent: HTMLElement,
		texts: ComparedText,
		blocks: Block[],
		choose?: (block: Block, side: Side) => boolean,
	) {
		const changed = blocks.filter((block) => block.changed);
		const targets: HTMLElement[] = [];
		const toolbar = parent.createDiv({ cls: "ocs-diff-toolbar" });
		if (changed.length) {
			const counter = toolbar.createSpan({ text: `${changed.length} 处差异` });
			let index = -1;
			const jump = (delta: number) => {
				index =
					index < 0
						? delta < 0
							? targets.length - 1
							: 0
						: (index + delta + targets.length) % targets.length;
				const target = targets[index];
				target?.scrollIntoView({ block: "start" });
				target?.focus({ preventScroll: true });
				counter.setText(`差异 ${index + 1} / ${targets.length}`);
			};
			const previous = new ButtonComponent(toolbar)
				.setIcon("chevron-up")
				.setTooltip("上一处差异");
			previous.buttonEl.setAttribute("aria-label", "上一处差异");
			previous.onClick(() => jump(-1));
			const next = new ButtonComponent(toolbar)
				.setIcon("chevron-down")
				.setTooltip("下一处差异");
			next.buttonEl.setAttribute("aria-label", "下一处差异");
			next.onClick(() => jump(1));
		}
		const columns = parent.createDiv({ cls: "ocs-diff-headings" });
		columns.createDiv({ text: "本地" });
		columns.createDiv({ text: "远端" });
		if (blocks.length) {
			const table = parent.createDiv({ cls: "ocs-diff-table" });
			table.setAttribute("role", "region");
			table.setAttribute("aria-label", "本地与远端差异");
			for (const block of blocks) {
				if (!block.changed && block.rows.length > 6) {
					this.renderLines(table, block.rows.slice(0, 3));
					const collapsed = table.createEl("details", {
						cls: "ocs-diff-context",
					});
					collapsed.createEl("summary", {
						text: `展开 ${block.rows.length - 6} 行未变更内容`,
					});
					this.renderLines(collapsed, block.rows.slice(3, -3));
					this.renderLines(table, block.rows.slice(-3));
					continue;
				}
				if (!block.changed) {
					this.renderLines(table, block.rows);
					continue;
				}
				const section = table.createDiv({ cls: "ocs-diff-block" });
				section.tabIndex = -1;
				targets.push(section);
				if (choose) {
					const bar = section.createDiv({ cls: "ocs-hunk-controls" });
					for (const [side, title] of [
						["local", "采用本地这段"],
						["remote", "采用远端这段"],
					] as const) {
						const button = new ButtonComponent(bar).setButtonText(title);
						button.buttonEl.addClass("ocs-hunk-choice");
						button.buttonEl.dataset.side = side;
						button.buttonEl.setAttribute("aria-pressed", "false");
						button.onClick(() => {
							if (!choose(block, side)) return;
							for (const control of bar.querySelectorAll("button"))
								control.setAttribute(
									"aria-pressed",
									String(control === button.buttonEl),
								);
						});
					}
				}
				this.renderLines(section, block.rows);
			}
		} else {
			const raw = parent.createDiv({ cls: "ocs-raw-columns" });
			this.rawText(raw, "本地内容", texts.local);
			this.rawText(raw, "远端内容", texts.remote);
		}
		if (texts.base !== null) {
			const extras = parent.createEl("details", { cls: "ocs-compare-extras" });
			extras.createEl("summary", { text: "共同版本" });
			extras.ontoggle = () => {
				if (extras.open && !extras.querySelector("textarea"))
					this.rawText(extras, "共同版本", texts.base);
			};
		}
	}

	private renderLines(parent: HTMLElement, rows: DisplayRow[]) {
		for (const row of rows) {
			const pair = parent.createDiv({
				cls: row.changed ? "ocs-diff-row is-changed" : "ocs-diff-row",
			});
			this.renderLine(pair, row.local, "local", row.changed);
			this.renderLine(pair, row.remote, "remote", row.changed);
		}
	}
	private renderLine(
		parent: HTMLElement,
		line: DisplayLine | null,
		side: Side,
		changed: boolean,
	) {
		const cell = parent.createDiv({
			cls: `ocs-diff-cell is-${side}${line ? "" : " is-gap"}`,
		});
		cell
			.createSpan({
				cls: "ocs-line-number",
				text: line ? String(line.number) : "",
			})
			.setAttribute("aria-hidden", "true");
		cell
			.createSpan({
				cls: "ocs-line-sign",
				text: changed && line ? (side === "local" ? "−" : "+") : "",
			})
			.setAttribute("aria-hidden", "true");
		cell.createEl("code", { text: line?.text.replace(/\r?\n$/, "") ?? "" });
		if (line && !line.text.endsWith("\n"))
			cell.createSpan({ cls: "ocs-eol-note", text: "无末尾换行" });
	}
	private rawText(parent: HTMLElement, label: string, text: string | null) {
		const section = parent.createEl("section", { cls: "ocs-raw-section" });
		section.createEl("h3", { text: label });
		if (text === null) {
			section.createDiv({
				cls: "ocs-compare-notice",
				text: "无法预览文本。可在下方选择已存在的版本。",
			});
			return;
		}
		const area = section.createEl("textarea", { cls: "ocs-text" });
		area.readOnly = true;
		area.value = text;
		area.setAttribute("aria-label", label);
	}
}
