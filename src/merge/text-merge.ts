import diffSequence from "@jest/diff-sequences";
import {
	type MergeLimits,
	MergeStop,
	type StopReason,
	TaskBudget,
} from "./limits";

export interface LineRange {
	start: number;
	end: number;
}
export type ChangeSource = "local" | "remote" | "both";
export interface MergeChange {
	base: LineRange;
	output: LineRange;
	source: ChangeSource;
}
export interface ConflictEdit {
	base: LineRange;
	source: ChangeSource;
	replacement: string;
}
export interface ConflictRegion {
	base: LineRange;
	edits: ConflictEdit[];
}
export type MergeResult =
	| { status: "merged"; text: string; changes: MergeChange[]; work: number }
	| { status: "conflict"; regions: ConflictRegion[]; work: number }
	| { status: "stopped"; reason: StopReason; work: number };
interface Edit {
	base: LineRange;
	ids: number[];
	source: ChangeSource;
}

/** Intern exact, terminated lines once; LCS then compares constant-size IDs. */
class Lines {
	private readonly ids = new Map<string, number>();
	readonly text: string[] = [];
	constructor(private readonly budget: TaskBudget) {}
	read(input: string): number[] {
		this.budget.spend(input.length);
		const result: number[] = [];
		const add = (end: number) => {
			this.budget.line();
			const line = input.slice(start, end);
			let id = this.ids.get(line);
			if (id === undefined) {
				id = this.text.length;
				this.ids.set(line, id);
				this.text.push(line);
			}
			result.push(id);
			start = end;
		};
		let start = 0;
		for (let i = 0; i < input.length; i++)
			if (input.charCodeAt(i) === 10) add(i + 1);
		if (start < input.length) add(input.length);
		return result;
	}
	render(ids: number[]): string {
		this.budget.spend(ids.length);
		return ids.map((id) => this.text[id]!).join("");
	}
}

/** Gaps between LCS matches are edits in base coordinates, never normalized text. */
function locate(
	base: number[],
	side: number[],
	source: ChangeSource,
	budget: TaskBudget,
): Edit[] {
	const edits: Edit[] = [];
	let b = 0,
		s = 0;
	const gap = (endB: number, endS: number) => {
		budget.spend();
		if (b !== endB || s !== endS) {
			budget.spend(endS - s);
			edits.push({
				base: { start: b, end: endB },
				ids: side.slice(s, endS),
				source,
			});
		}
	};
	diffSequence(
		base.length,
		side.length,
		(i, j) => {
			budget.spend();
			return base[i] === side[j];
		},
		(count, i, j) => {
			budget.spend(count);
			gap(i, j);
			b = i + count;
			s = j + count;
		},
	);
	gap(base.length, side.length);
	// If any shared token was skipped, the chosen LCS is not sufficient evidence
	// for locating edits. Refuse moves and uncertain repeated-line alignments.
	budget.spend(base.length + side.length);
	const inBase = new Set(base),
		inSide = new Set(side);
	for (const edit of edits) {
		for (let i = edit.base.start; i < edit.base.end; i++) {
			budget.spend();
			if (inSide.has(base[i]!)) throw new MergeStop("ambiguous-alignment");
		}
		for (const id of edit.ids) {
			budget.spend();
			if (inBase.has(id)) throw new MergeStop("ambiguous-alignment");
		}
	}
	return edits;
}

function sameEdit(a: Edit, b: Edit, budget: TaskBudget): boolean {
	budget.spend();
	if (
		a.base.start !== b.base.start ||
		a.base.end !== b.base.end ||
		a.ids.length !== b.ids.length
	)
		return false;
	for (let i = 0; i < a.ids.length; i++) {
		budget.spend();
		if (a.ids[i] !== b.ids[i]) return false;
	}
	return true;
}

function compute(
	base: string | null,
	local: string,
	remote: string,
	budget: TaskBudget,
): MergeResult {
	const units = (base?.length ?? 0) + local.length + remote.length;
	if (units > budget.limits.maxUnits) throw new MergeStop("input-limit");
	const lines = new Lines(budget);
	const b = lines.read(base ?? ""),
		l = lines.read(local),
		r = lines.read(remote);
	// Charge raw equality and canonical-order comparisons by an upper bound on
	// their character visits. All paths, including shortcuts, share this budget.
	budget.spend(units * 3);
	const shortcut = (
		text: string,
		count: number,
		source: ChangeSource,
	): MergeResult => ({
		status: "merged",
		text,
		changes:
			text === base
				? []
				: [
						{
							base: { start: 0, end: b.length },
							output: { start: 0, end: count },
							source,
						},
					],
		work: budget.work,
	});
	if (local === remote) return shortcut(local, l.length, "both");
	if (base === null) throw new MergeStop("missing-base");
	if (local === base) return shortcut(remote, r.length, "remote");
	if (remote === base) return shortcut(local, l.length, "local");
	// Canonical order makes work-limit decisions independent of local/remote labels.
	const sides: [number[], ChangeSource][] =
		local < remote
			? [
					[l, "local"],
					[r, "remote"],
				]
			: [
					[r, "remote"],
					[l, "local"],
				];
	const edits = sides.flatMap(([ids, source]) =>
		locate(b, ids, source, budget),
	);
	edits.sort((a, c) => {
		budget.spend();
		return a.base.start - c.base.start || a.base.end - c.base.end;
	});
	const selected: Edit[] = [],
		regions: ConflictRegion[] = [];
	let group: Edit[] = [],
		start = 0,
		end = 0,
		endInsertion = false;
	const flush = () => {
		if (!group.length) return;
		budget.spend(group.length);
		if (group.length === 1) selected.push(group[0]!);
		else if (group.length === 2 && sameEdit(group[0]!, group[1]!, budget))
			selected.push({ ...group[0]!, source: "both" });
		else
			regions.push({
				base: { start, end },
				edits: group.map((edit) => ({
					base: edit.base,
					source: edit.source,
					replacement: lines.render(edit.ids),
				})),
			});
	};
	for (const edit of edits) {
		budget.spend();
		const insertion = edit.base.start === edit.base.end;
		const connected =
			group.length > 0 &&
			(edit.base.start < end ||
				(edit.base.start === end && (insertion || endInsertion)));
		if (!connected) {
			flush();
			group = [];
			start = edit.base.start;
			end = edit.base.end;
			endInsertion = insertion;
		} else if (edit.base.end > end) {
			end = edit.base.end;
			endInsertion = false;
		} else if (insertion && edit.base.end === end) endInsertion = true;
		group.push(edit);
	}
	flush();
	if (regions.length) return { status: "conflict", regions, work: budget.work };
	const output: number[] = [],
		changes: MergeChange[] = [];
	let cursor = 0;
	const append = (ids: number[], from: number, to: number) => {
		budget.spend(to - from);
		for (let i = from; i < to; i++) output.push(ids[i]!);
	};
	for (const edit of selected) {
		budget.spend();
		append(b, cursor, edit.base.start);
		const from = output.length;
		append(edit.ids, 0, edit.ids.length);
		changes.push({
			base: edit.base,
			output: { start: from, end: output.length },
			source: edit.source,
		});
		cursor = edit.base.end;
	}
	append(b, cursor, b.length);
	const text = lines.render(output);
	return { status: "merged", text, changes, work: budget.work };
}

/** Pure, deterministic, fail-closed three-way merge. Never emits partial text. */
export function mergeText(
	base: string | null,
	local: string,
	remote: string,
	limits: Partial<MergeLimits> = {},
): MergeResult {
	let budget: TaskBudget | undefined;
	try {
		budget = new TaskBudget(limits);
		return compute(base, local, remote, budget);
	} catch (error) {
		if (error instanceof MergeStop)
			return {
				status: "stopped",
				reason: error.reason,
				work: budget?.work ?? 0,
			};
		throw error;
	}
}
