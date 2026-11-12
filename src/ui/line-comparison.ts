import diffSequence from "@jest/diff-sequences";

export interface DisplayLine {
	number: number;
	text: string;
}
export interface DisplayRow {
	local: DisplayLine | null;
	remote: DisplayLine | null;
	changed: boolean;
}
export type LineComparison =
	| { status: "ready"; rows: DisplayRow[] }
	| { status: "limited" };
/** Bounded display-only alignment. Never used as a merge decision or write target. */
export function compareLines(local: string, remote: string): LineComparison {
	if (local.length + remote.length > 500_000) return { status: "limited" };
	let count = 0,
		work = 0;
	const tokens = new Map<string, number>();
	function read(text: string) {
		const lines: DisplayLine[] = [],
			ids: number[] = [];
		let start = 0;
		function add(end: number) {
			if (++count > 2_000) throw new Error("Display line limit");
			const line = text.slice(start, end);
			let id = tokens.get(line);
			if (id === undefined) {
				id = tokens.size;
				tokens.set(line, id);
			}
			ids.push(id);
			lines.push({ number: lines.length + 1, text: line });
			start = end;
		}
		for (let i = 0; i < text.length; i++)
			if (text.charCodeAt(i) === 10) add(i + 1);
		if (start < text.length) add(text.length);
		return { lines, ids };
	}
	try {
		const left = read(local),
			right = read(remote),
			rows: DisplayRow[] = [];
		let l = 0,
			r = 0;
		function gap(toL: number, toR: number) {
			while (l < toL || r < toR)
				rows.push({
					local: l < toL ? (left.lines[l++] ?? null) : null,
					remote: r < toR ? (right.lines[r++] ?? null) : null,
					changed: true,
				});
		}
		diffSequence(
			left.ids.length,
			right.ids.length,
			(a, b) => {
				if (++work > 200_000) throw new Error("Display work limit");
				return left.ids[a] === right.ids[b];
			},
			(n, a, b) => {
				gap(a, b);
				for (let i = 0; i < n; i++)
					rows.push({
						local: left.lines[l++] ?? null,
						remote: right.lines[r++] ?? null,
						changed: false,
					});
			},
		);
		gap(left.lines.length, right.lines.length);
		return { status: "ready", rows };
	} catch {
		return { status: "limited" };
	}
}
