import { describe, expect, it } from "vitest";
import { mergeText } from "@/merge";

function accepted(
	base: string | null,
	local: string,
	remote: string,
	text: string,
) {
	const result = mergeText(base, local, remote);
	expect(result.status).toBe("merged");
	if (result.status !== "merged") throw new Error(JSON.stringify(result));
	expect(result.text).toBe(text);
	const swapped = mergeText(base, remote, local);
	expect(swapped.status).toBe("merged");
	if (swapped.status === "merged") expect(swapped.text).toBe(text);
	expect(mergeText(base, local, remote)).toEqual(result);
	return result;
}
function rejected(
	base: string | null,
	local: string,
	remote: string,
	status: string,
) {
	const result = mergeText(base, local, remote);
	expect(result.status).toBe(status);
	expect(result).not.toHaveProperty("text");
	expect(mergeText(base, remote, local).status).toBe(status);
	return result;
}

describe("contract: exact content and base-relative decisions", () => {
	it.each([
		[null, "same\r\n", "same\r\n", "same\r\n"],
		["old", "", "old", ""],
		["", "中文😀\n", "", "中文😀\n"],
		["old\n", "old\n", "new", "new"],
		["a\nb\n", "A\nb\n", "a\nB\n", "A\nB\n"],
		["a\nb\nc\n", "b\nc\n", "a\nb\nC\n", "b\nC\n"],
		["a\nb\nc\n", "x\na\nb\nc\n", "a\nb\nc\ny\n", "x\na\nb\nc\ny\n"],
		["a\nb\nc\nd\n", "A\nb\nc\nD\n", "A\nb\nC\nd\n", "A\nb\nC\nD\n"],
		["a\r\nb\nc", "A\r\nb\nc", "a\r\nb\nC\n", "A\r\nb\nC\n"],
		[
			"\ufeffa\r\nb\nc\rdata",
			"\ufeffA\r\nb\nc\rdata",
			"\ufeffa\r\nb\nC\rdata",
			"\ufeffA\r\nb\nC\rdata",
		],
		["a\nb\n", "a\r\nb\n", "a\nB\n", "a\r\nB\n"],
		["", "", "", ""],
		["a\nb\n", "", "", ""],
	])("keeps exact text: %j / %j / %j", (b, l, r, t) => {
		accepted(b, l, r, t);
	});
	it("reports both for a shared region and distinct sources elsewhere", () => {
		const result = accepted(
			"a\nb\nc\nd\n",
			"A\nb\nc\nD\n",
			"A\nb\nC\nd\n",
			"A\nb\nC\nD\n",
		);
		expect(result.changes.map((c) => c.source)).toEqual([
			"both",
			"remote",
			"local",
		]);
		expect(result.changes[0]?.base).toEqual({ start: 0, end: 1 });
		expect(result.changes[2]?.output).toEqual({ start: 3, end: 4 });
	});
	it("retains untouched Markdown, duplicate paragraphs, blank lines and fences", () => {
		const middle = "\n- same\n- same\n```\nx\n```\n\nrepeat\n\nrepeat\n";
		accepted(
			`head\n${middle}tail`,
			`HEAD\n${middle}tail`,
			`head\n${middle}TAIL`,
			`HEAD\n${middle}TAIL`,
		);
	});
	it("does not interpret YAML fields", () => {
		accepted(
			"---\nupdated: B\narea: X\n---\n",
			"---\nupdated: L\narea: X\n---\n",
			"---\nupdated: B\narea: R\n---\n",
			"---\nupdated: L\narea: R\n---\n",
		);
	});
	it("handles long Unicode lines without normalization", () => {
		const line = "中文😀e\u0301".repeat(2000);
		accepted(
			`a\n${line}\nz`,
			`A\n${line}\nz`,
			`a\n${line}\nZ`,
			`A\n${line}\nZ`,
		);
	});
});

describe("contract: conservative failures carry no writable text", () => {
	it.each([
		["a\nb\n", "a\nx\nb\n", "a\ny\nb\n"],
		["a\nb\nc\n", "a\nc\n", "a\nB\nc\n"],
		["a\nb\n", "x\na\nb\n", "A\nb\n"],
		["a\nb\n", "a\nx\nb\n", "A\nb\n"],
		["a\nb\n", "x\na\nb\n", "b\n"],
		["a\nb\n", "a\nx\nb\n", "b\n"],
		["a\nb\nc\n", "a\nx\nb\nc\n", "Z\nc\n"],
		["a\nb\n", "A\nb\n", "X\nb\n"],
		["", "x", "y"],
	])("rejects overlap/boundary: %j / %j / %j", (b, l, r) => {
		rejected(b, l, r, "conflict");
	});
	it("reports disjoint conflicts at their base ranges", () => {
		const result = rejected("a\nb\nc\n", "L\nb\nX\n", "R\nb\nY\n", "conflict");
		if (result.status === "conflict")
			expect(result.regions.map((c) => c.base)).toEqual([
				{ start: 0, end: 1 },
				{ start: 2, end: 3 },
			]);
	});
	it("requires a baseline for unequal sides", () => {
		expect(rejected(null, "L", "R", "stopped")).toMatchObject({
			reason: "missing-base",
		});
	});
	it.each([
		["a\nx\nx\nz\n", "a\nx\nz\n", "A\nx\nx\nz\n"],
		["a\nb\nc\n", "b\na\nc\n", "a\nb\nC\n"],
		["a\n\nb\n\nc\n", "a\nb\n\nc\n", "a\n\nb\n\nC\n"],
	])("stops uncertain duplicate deletion or movement", (b, l, r) => {
		expect(rejected(b, l, r, "stopped")).toMatchObject({
			reason: "ambiguous-alignment",
		});
	});
	it("checks aggregate resource bounds even for shortcuts", () => {
		for (const [limits, reason] of [
			[{ maxUnits: 5 }, "input-limit"],
			[{ maxLines: 2 }, "line-limit"],
			[{ maxWork: 1 }, "work-limit"],
		] as const) {
			const result = mergeText("a\n", "a\n", "a\n", limits);
			expect(result).toMatchObject({ status: "stopped", reason });
			expect(result).not.toHaveProperty("text");
		}
	});
	it("shares the entire work allowance across both diffs and assembly", () => {
		const b = Array.from({ length: 80 }, (_, i) => `base ${i}\n`);
		const l = b.map((x, i) => (i % 4 === 0 ? `left ${i}\n` : x)).join("");
		const r = b.map((x, i) => (i % 4 === 2 ? `right ${i}\n` : x)).join("");
		const result = accepted(
			b.join(""),
			l,
			r,
			b
				.map((x, i) =>
					i % 4 === 0 ? `left ${i}\n` : i % 4 === 2 ? `right ${i}\n` : x,
				)
				.join(""),
		);
		expect(result.work).toBeGreaterThan(0);
		expect(mergeText(b.join(""), l, r, { maxWork: result.work })).toEqual(
			result,
		);
		const stopped = mergeText(b.join(""), l, r, { maxWork: result.work - 1 });
		expect(stopped).toMatchObject({ status: "stopped", reason: "work-limit" });
		expect(stopped).not.toHaveProperty("text");
	});
});

describe("generated edits with an independent construction oracle", () => {
	it("preserves unilateral/identical changes and independent adjacent edits over 240 deterministic documents", () => {
		for (let seed = 1; seed <= 240; seed++) {
			const n = 4 + (seed % 19);
			const tokens = Array.from(
				{ length: n },
				(_, i) =>
					`原文 ${seed}:${i} 😀${i === n - 1 && seed % 2 ? "" : i % 3 === 0 ? "\r\n" : "\n"}`,
			);
			const i = seed % (n - 1),
				j = i + 1;
			const left = tokens.slice(),
				right = tokens.slice(),
				oracle = tokens.slice();
			left[i] = oracle[i] = `左 ${seed}\r\n`;
			right[j] = oracle[j] = `右 ${seed}${j === n - 1 ? "" : "\n"}`;
			const b = tokens.join(""),
				l = left.join(""),
				r = right.join("");
			accepted(b, l, b, l);
			accepted(b, l, l, l);
			accepted(b, l, r, oracle.join(""));
		}
	});
	it("preserves generated separated insertions/deletions, with exact unchanged spans", () => {
		for (let n = 6; n < 66; n++) {
			const b = Array.from({ length: n }, (_, i) => `line ${i}\n`);
			const l = ["inserted\n", ...b],
				r = b.slice(0, -1);
			accepted(
				b.join(""),
				l.join(""),
				r.join(""),
				["inserted\n", ...b.slice(0, -1)].join(""),
			);
		}
	});
});

describe("generated boundary matrix", () => {
	it("checks every pair of known single edits over unique bases of one to six lines", () => {
		for (let size = 1; size <= 6; size++) {
			const base = Array.from({ length: size }, (_, i) => `original ${i}\n`);
			const ranges: { start: number; end: number; remove: boolean }[] = [];
			for (let start = 0; start <= size; start++)
				for (let end = start; end <= size; end++) {
					ranges.push({ start, end, remove: false });
					if (start < end) ranges.push({ start, end, remove: true });
				}
			for (const a of ranges)
				for (const b of ranges) {
					const left = a.remove ? [] : ["left\n"],
						right = b.remove ? [] : ["right\n"];
					const local = [
						...base.slice(0, a.start),
						...left,
						...base.slice(a.end),
					].join("");
					const remote = [
						...base.slice(0, b.start),
						...right,
						...base.slice(b.end),
					].join("");
					if (local === remote) {
						accepted(base.join(""), local, remote, local);
						continue;
					}
					// Oracle uses occupied original line indices and explicit insertion boundaries,
					// not a diff of the resulting strings or any production helper.
					const occupiedA = new Set(
						Array.from({ length: a.end - a.start }, (_, i) => a.start + i),
					);
					const occupiedB = new Set(
						Array.from({ length: b.end - b.start }, (_, i) => b.start + i),
					);
					const overlap = [...occupiedA].some((i) => occupiedB.has(i));
					const boundaryA =
						a.start === a.end && a.start >= b.start && a.start <= b.end;
					const boundaryB =
						b.start === b.end && b.start >= a.start && b.start <= a.end;
					if (overlap || boundaryA || boundaryB)
						rejected(base.join(""), local, remote, "conflict");
					else {
						const output: string[] = [];
						for (let i = 0; i <= size; i++) {
							if (i === a.start) output.push(...left);
							if (i === b.start) output.push(...right);
							if (i < size && !occupiedA.has(i) && !occupiedB.has(i))
								output.push(base[i] as string);
						}
						accepted(base.join(""), local, remote, output.join(""));
					}
				}
		}
	});
	it("keeps insertion-induced output offsets and provenance explicit", () => {
		const result = accepted(
			"a\nb\nc\n",
			"new\na\nb\nc\n",
			"a\nb\nC\n",
			"new\na\nb\nC\n",
		);
		expect(result.changes).toEqual([
			{
				base: { start: 0, end: 0 },
				output: { start: 0, end: 1 },
				source: "local",
			},
			{
				base: { start: 2, end: 3 },
				output: { start: 3, end: 4 },
				source: "remote",
			},
		]);
	});
	it("joins transitive overlap into one conflict without swallowing a later independent edit", () => {
		const result = rejected(
			"a\nb\nc\nd\ne\n",
			"X\nd\ne\n",
			"A\nb\nC\nd\nE\n",
			"conflict",
		);
		if (result.status === "conflict") {
			expect(result.regions).toHaveLength(1);
			expect(result.regions[0]?.base).toEqual({ start: 0, end: 3 });
			expect(result.regions[0]?.edits).toHaveLength(3);
		}
	});
	it("does not allow callers to disable hard bounds", () => {
		for (const maxWork of [Number.NaN, Infinity, -1, 8_000_001])
			expect(mergeText("", "", "", { maxWork })).toMatchObject({
				status: "stopped",
				reason: "invalid-limit",
			});
	});
	it("is symmetric even when the shared budget is just insufficient", () => {
		const b = "a\nb\nc\nd\n",
			l = "A\nb\nc\nd\n",
			r = "a\nb\nc\nD\n";
		const result = accepted(b, l, r, "A\nb\nc\nD\n");
		for (const maxWork of [result.work, result.work - 1, 80]) {
			const lr = mergeText(b, l, r, { maxWork }),
				rl = mergeText(b, r, l, { maxWork });
			expect(lr.status).toBe(rl.status);
			expect(lr.work).toBe(rl.work);
		}
	});
});
