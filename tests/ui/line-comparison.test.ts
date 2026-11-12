import { describe, expect, it } from "vitest";
import { compareLines } from "@/ui/line-comparison";

describe("bounded read-only line alignment", () => {
	it.each([
		["", ""],
		["", "新建😀\n"],
		["全部删除\n", ""],
		["before\nold\nafter\n", "before\nnew\nafter\n"],
		["a\nb\n", "a\ninsert\nb\n"],
		["a\n", "a"],
		["一\r\n\n重复\n重复", "一\n\n重复\n重复"],
	])("preserves every exact line in either side (%j → %j)", (local, remote) => {
		const result = compareLines(local, remote);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error("Expected ready");
		for (const side of ["local", "remote"] as const) {
			const lines = result.rows.flatMap((row) =>
				row[side] ? [row[side]] : [],
			);
			expect(lines.map((line) => line.text).join("")).toBe(
				side === "local" ? local : remote,
			);
			expect(lines.map((line) => line.number)).toEqual(
				lines.map((_, i) => i + 1),
			);
		}
		for (const row of result.rows)
			if (!row.changed) expect(row.local?.text).toBe(row.remote?.text);
		expect(compareLines(local, remote)).toEqual(result);
	});
	it("marks inserted lines without marking neighboring unchanged lines", () => {
		const result = compareLines("a\nb\n", "a\nx\nb\n");
		expect(result).toEqual({
			status: "ready",
			rows: [
				{
					local: { number: 1, text: "a\n" },
					remote: { number: 1, text: "a\n" },
					changed: false,
				},
				{ local: null, remote: { number: 2, text: "x\n" }, changed: true },
				{
					local: { number: 2, text: "b\n" },
					remote: { number: 3, text: "b\n" },
					changed: false,
				},
			],
		});
	});
	it("reconstructs deterministic generated Unicode texts with repeats and mixed endings", () => {
		for (let seed = 0; seed < 100; seed++) {
			const local = Array.from(
				{ length: seed % 21 },
				(_, i) => `行${(i * 7 + seed) % 5}😀${i % 2 ? "\n" : "\r\n"}`,
			).join("");
			const remote = `新增${seed}\n${local.slice(seed % 3)}尾`;
			const result = compareLines(local, remote);
			expect(result.status).toBe("ready");
			if (result.status !== "ready") throw new Error("Expected ready");
			expect(result.rows.map((r) => r.local?.text ?? "").join("")).toBe(local);
			expect(result.rows.map((r) => r.remote?.text ?? "").join("")).toBe(
				remote,
			);
		}
	});
	it("stops combined character and line budgets without a partial result", () => {
		expect(compareLines("a".repeat(250001), "b".repeat(250000))).toEqual({
			status: "limited",
		});
		expect(compareLines("a\n".repeat(1001), "a\n".repeat(1000))).toEqual({
			status: "limited",
		});
	});
	it("stops worst-case matching work before rendering a partial diff", () => {
		expect(compareLines("a\n".repeat(900), "b\n".repeat(900))).toEqual({
			status: "limited",
		});
	});
});
