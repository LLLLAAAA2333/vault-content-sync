import { describe, expect, it } from "vitest";
import { describeConflict } from "@/ui/conflict-detail";

describe("read-only sidebar conflict projection", () => {
	it("shows only the overlapping region, preserving exact line endings and unchanged surroundings", () => {
		const detail = describeConflict({
			base: "before\r\nbase\nend",
			local: "before\r\n本地😀\nend",
			remote: "before\r\n远端\nend",
		});
		expect(detail.kind).toBe("conflict");
		expect(detail.fragments).toEqual([
			{
				label: "共同版本第 2 行",
				base: { text: "base\n", truncated: false },
				local: { text: "本地😀\n", truncated: false },
				remote: { text: "远端\n", truncated: false },
			},
		]);
	});
	it("does not label no-baseline differences as located conflict lines", () => {
		const detail = describeConflict({
			base: null,
			local: "one",
			remote: "two",
		});
		expect(detail.kind).toBe("no-base");
		expect(detail.fragments[0]?.label).toBe("两端内容预览");
	});
	it("shows insertion at the start and preserves an empty baseline", () => {
		const detail = describeConflict({
			base: "",
			local: "left",
			remote: "right",
		});
		expect(detail.kind).toBe("conflict");
		expect(detail.fragments[0]?.base?.text).toBe("");
		expect(detail.fragments[0]?.local.text).toBe("left");
	});
	it("shows deletion versus modification without inventing text", () => {
		const detail = describeConflict({
			base: "a\nb\nc\n",
			local: "a\nc\n",
			remote: "a\nchanged\nc\n",
		});
		expect(detail.fragments[0]?.local.text).toBe("");
		expect(detail.fragments[0]?.remote.text).toBe("changed\n");
	});
	it("reconstructs each side across a connected overlap", () => {
		const detail = describeConflict({
			base: "a\nb\nc\nd\n",
			local: "L\nc\nd\n",
			remote: "a\nR\nd\n",
		});
		expect(detail.fragments[0]?.base?.text).toBe("a\nb\nc\n");
		expect(detail.fragments[0]?.local.text).toBe("L\nc\n");
		expect(detail.fragments[0]?.remote.text).toBe("a\nR\n");
	});
	it("reports independent changes without exposing a writable merge target", () => {
		const detail = describeConflict({
			base: "a\nb\n",
			local: "A\nb\n",
			remote: "a\nB\n",
		});
		expect(detail.kind).toBe("mergeable");
		expect(detail.fragments).toEqual([]);
		expect(detail).not.toHaveProperty("text");
	});
	it("refuses to guess when the alignment is ambiguous", () => {
		const detail = describeConflict({
			base: "a\nb\nc\n",
			local: "b\na\nc\n",
			remote: "A\nb\nc\n",
		});
		expect(detail.kind).toBe("stopped");
		expect(detail.fragments).toEqual([]);
	});
	it("reports missing or unreadable sides instead of treating them as empty", () => {
		expect(describeConflict({ base: "x", local: null, remote: "y" }).kind).toBe(
			"unavailable",
		);
	});
	it("caps characters and lines and explicitly reports truncation", () => {
		const detail = describeConflict({
			base: null,
			local: "x".repeat(9000),
			remote: "r\n".repeat(50),
		});
		expect(detail.fragments[0]?.local.text.length).toBe(8000);
		expect(detail.fragments[0]?.remote.text).toBe("r\n".repeat(40));
		expect(detail.fragments[0]?.local.truncated).toBe(true);
		expect(detail.fragments[0]?.remote.truncated).toBe(true);
	});
	it("does not cut an emoji surrogate pair at the display limit", () => {
		const detail = describeConflict({
			base: null,
			local: "x".repeat(7999) + "😀",
			remote: "other",
		});
		expect(detail.fragments[0]?.local).toEqual({
			text: "x".repeat(7999),
			truncated: true,
		});
	});
	it("caps visible regions while keeping the total count explicit", () => {
		const base = Array.from({ length: 20 }, (_, i) => `base-${i}\n`).join("");
		const local = base.replace(/base-(\d+)/g, (m, n) =>
			Number(n) % 2 ? m : `local-${n}`,
		);
		const remote = base.replace(/base-(\d+)/g, (m, n) =>
			Number(n) % 2 ? m : `remote-${n}`,
		);
		const detail = describeConflict({ base, local, remote });
		expect(detail.fragments).toHaveLength(8);
		expect(detail.omitted).toBe(2);
	});
});
