import { type ConflictRegion, mergeText, type StopReason } from "../merge";

export interface ComparedText {
	base: string | null;
	local: string | null;
	remote: string | null;
}
export interface Fragment {
	text: string;
	truncated: boolean;
}
export interface ConflictFragment {
	label: string;
	base?: Fragment;
	local: Fragment;
	remote: Fragment;
}
export interface ConflictDetail {
	kind: "conflict" | "no-base" | "mergeable" | "stopped" | "unavailable";
	message: string;
	fragments: ConflictFragment[];
	omitted: number;
}
const MAX_REGIONS = 8;
const MAX_CHARS = 8_000;
const MAX_LINES = 40;
function fragment(text: string): Fragment {
	let end = Math.min(text.length, MAX_CHARS);
	let lines = 0;
	for (let i = 0; i < end; i++) {
		if (text.charCodeAt(i) === 10 && ++lines === MAX_LINES) {
			end = i + 1;
			break;
		}
	}
	if (
		end < text.length &&
		end > 0 &&
		text.charCodeAt(end - 1) >= 0xd800 &&
		text.charCodeAt(end - 1) <= 0xdbff &&
		text.charCodeAt(end) >= 0xdc00 &&
		text.charCodeAt(end) <= 0xdfff
	)
		end--;
	return { text: text.slice(0, end), truncated: end < text.length };
}
const reasons: Record<StopReason, string> = {
	"missing-base": "没有共同版本，不能定位三方冲突。",
	"ambiguous-alignment": "重复或移动的内容无法可靠定位，请查看完整比较。",
	"input-limit": "文本超出分析大小限制，请查看完整比较。",
	"line-limit": "文本行数超出分析限制，请查看完整比较。",
	"work-limit": "差异计算达到上限，请查看完整比较。",
	"invalid-limit": "分析限制无效，已停止定位。",
};
function sideText(
	lines: string[],
	region: ConflictRegion,
	side: "local" | "remote",
): string {
	let cursor = region.base.start;
	const output: string[] = [];
	for (const edit of region.edits) {
		if (edit.source !== side && edit.source !== "both") continue;
		output.push(
			lines.slice(cursor, edit.base.start).join(""),
			edit.replacement,
		);
		cursor = edit.base.end;
	}
	output.push(lines.slice(cursor, region.base.end).join(""));
	return output.join("");
}
/** Read-only UI projection; snippets are never used as merge or write targets. */
export function describeConflict(texts: ComparedText): ConflictDetail {
	const { base, local, remote } = texts;
	if (local === null || remote === null)
		return {
			kind: "unavailable",
			message:
				"一端没有可展示的文本：文件缺失、为二进制或超过读取限制。可打开完整比较查看可用的一端。",
			fragments: [],
			omitted: 0,
		};
	if (base === null && local !== remote)
		return {
			kind: "no-base",
			message:
				"没有共同版本，无法确定冲突行。以下仅为两端内容预览，不会自动合并。",
			fragments: [
				{
					label: "两端内容预览",
					local: fragment(local),
					remote: fragment(remote),
				},
			],
			omitted: 0,
		};
	const result = mergeText(base, local, remote);
	if (result.status === "stopped")
		return {
			kind: "stopped",
			message: reasons[result.reason],
			fragments: [],
			omitted: 0,
		};
	if (result.status === "merged")
		return {
			kind: "mergeable",
			message:
				local === remote
					? "两端共享内容一致，无需合并。"
					: "未发现重叠冲突，可合并独立修改。此处仅分析，未应用任何内容。",
			fragments: [],
			omitted: 0,
		};
	const lines = base?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	return {
		kind: "conflict",
		message: `发现 ${result.regions.length} 处冲突。行号对应排除本机 updated 后的共同版本；下方显示冲突范围内的内容。`,
		omitted: Math.max(0, result.regions.length - MAX_REGIONS),
		fragments: result.regions.slice(0, MAX_REGIONS).map((region) => ({
			label:
				region.base.start === region.base.end
					? region.base.start === 0
						? "共同版本开头插入"
						: `共同版本第 ${region.base.start} 行后插入`
					: `共同版本第 ${region.base.start + 1}${region.base.end > region.base.start + 1 ? `–${region.base.end}` : ""} 行`,
			base: fragment(lines.slice(region.base.start, region.base.end).join("")),
			local: fragment(sideText(lines, region, "local")),
			remote: fragment(sideText(lines, region, "remote")),
		})),
	};
}
