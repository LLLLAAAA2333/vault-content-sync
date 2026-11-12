import { ItemView } from "obsidian";
import type { PlainEngine } from "../sync/engine";
import type { Row } from "../sync/model";
import { type ComparedText, describeConflict } from "./conflict-detail";
import { compareLines, type DisplayLine } from "./line-comparison";

export const COMPARISON_VIEW_TYPE = "vault-content-sync-comparison";
export class ComparisonView extends ItemView {
	private request = 0;
	getViewType() {
		return COMPARISON_VIEW_TYPE;
	}
	getDisplayText() {
		return "内容比较";
	}
	getIcon() {
		return "columns-2";
	}
	// File contents and inspected paths never enter workspace persistence.
	getState() {
		return {};
	}
	async onOpen() {
		this.contentEl.addClass("ocs-comparison-view");
		this.contentEl.setText("从内容同步侧栏选择文件以比较。");
	}
	async onClose() {
		this.request++;
		this.contentEl.empty();
	}
	invalidate() {
		this.request++;
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "ocs-compare-notice",
			text: "预览已更新，请从侧栏重新选择文件。",
		});
	}
	async show(row: Row, engine: PlainEngine, stillCurrent: () => boolean) {
		const request = ++this.request;
		this.contentEl.empty();
		const head = this.contentEl.createDiv({ cls: "ocs-compare-header" });
		head.createDiv({ cls: "ocs-compare-path", text: row.path });
		head.createSpan({ cls: "ocs-muted", text: "只读比较" });
		const message = this.contentEl.createDiv({
			cls: "ocs-compare-notice",
			text: "正在读取当前版本…",
		});
		message.setAttribute("role", "status");
		try {
			const texts = await engine.inspect(row);
			if (request !== this.request) return;
			if (!stillCurrent()) throw new Error("Preview changed");
			message.setText(
				row.kind === "conflict"
					? describeConflict(texts).message
					: "本地与远端的共享内容；本机 updated 不参与比较。",
			);
			this.renderTexts(texts);
		} catch {
			if (request !== this.request) return;
			message.setText(
				"无法读取当前版本，文件或连接可能已变化。请重新核验后再选择文件。",
			);
			message.addClass("is-error");
		}
	}
	private renderTexts(texts: ComparedText) {
		const columns = this.contentEl.createDiv({ cls: "ocs-diff-headings" });
		columns.createDiv({ text: "本地" });
		columns.createDiv({ text: "远端" });
		const alignment =
			texts.local !== null && texts.remote !== null
				? compareLines(texts.local, texts.remote)
				: null;
		if (alignment?.status === "ready") {
			const table = this.contentEl.createDiv({ cls: "ocs-diff-table" });
			table.setAttribute("role", "region");
			table.setAttribute("aria-label", "本地与远端差异");
			if (!alignment.rows.length)
				table.createDiv({
					cls: "ocs-compare-notice",
					text: "两端均为空文件。",
				});
			for (const row of alignment.rows) {
				const pair = table.createDiv({
					cls: row.changed ? "ocs-diff-row is-changed" : "ocs-diff-row",
				});
				this.renderLine(pair, row.local, "local", row.changed);
				this.renderLine(pair, row.remote, "remote", row.changed);
			}
		} else {
			if (alignment?.status === "limited")
				this.contentEl.createDiv({
					cls: "ocs-compare-notice",
					text: "内容较多，已停止行高亮；以下仍可查看完整已读取文本。",
				});
			const raw = this.contentEl.createDiv({ cls: "ocs-raw-columns" });
			this.rawText(raw, "本地", texts.local);
			this.rawText(raw, "远端", texts.remote);
		}
		const extras = this.contentEl.createEl("details", {
			cls: "ocs-compare-extras",
		});
		extras.createEl("summary", { text: "原文与共同版本" });
		// Build full text controls only on demand; no truncation or Markdown rendering.
		let built = false;
		extras.ontoggle = () => {
			if (!extras.open || built) return;
			built = true;
			for (const [key, label] of [
				["local", "本地原文"],
				["remote", "远端原文"],
				["base", "共同版本"],
			] as const)
				this.rawText(extras, label, texts[key]);
		};
	}
	private renderLine(
		parent: HTMLElement,
		line: DisplayLine | null,
		side: string,
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
				text: "没有可用文本：文件缺失、无共同版本、为二进制或超过读取限制。",
			});
			return;
		}
		const area = section.createEl("textarea", { cls: "ocs-text" });
		area.readOnly = true;
		area.value = text;
		area.setAttribute("aria-label", label);
	}
}
