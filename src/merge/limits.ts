/** Task-wide structural and work bounds. See docs/MERGE_CONTRACT.md. */
export interface MergeLimits {
	maxUnits: number;
	maxLines: number;
	maxWork: number;
}
export const MERGE_LIMITS: Readonly<MergeLimits> = Object.freeze({
	maxUnits: 1_572_864,
	maxLines: 60_000,
	maxWork: 8_000_000,
});
export type StopReason =
	| "missing-base"
	| "input-limit"
	| "line-limit"
	| "work-limit"
	| "ambiguous-alignment"
	| "invalid-limit";
export class MergeStop extends Error {
	constructor(readonly reason: StopReason) {
		super(reason);
	}
}
export class TaskBudget {
	readonly limits: MergeLimits;
	work = 0;
	lines = 0;
	constructor(options: Partial<MergeLimits>) {
		this.limits = { ...MERGE_LIMITS, ...options };
		for (const key of Object.keys(MERGE_LIMITS) as (keyof MergeLimits)[]) {
			const n = this.limits[key];
			if (!Number.isSafeInteger(n) || n < 0 || n > MERGE_LIMITS[key])
				throw new MergeStop("invalid-limit");
		}
	}
	spend(n = 1) {
		if (n > this.limits.maxWork - this.work) throw new MergeStop("work-limit");
		this.work += n;
	}
	line() {
		if (++this.lines > this.limits.maxLines) throw new MergeStop("line-limit");
		this.spend();
	}
}
