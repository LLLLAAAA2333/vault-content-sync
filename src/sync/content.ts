import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from "yaml";

export const CONTENT_POLICY = "markdown-local-updated-v1";
export const HEADER_LIMIT = 256 * 1024;
export const isMarkdown = (path: string) => /\.md$/i.test(path);

// Only the frontmatter prefix is buffered; attachments and the Markdown body stream unchanged.
export class MarkdownProjection {
	done = false;
	updated = "";
	private prefix = Buffer.alloc(0);
	constructor(private readonly retain?: string) {}
	push(bytes: Buffer, final = false): Buffer {
		if (this.done) return bytes;
		this.prefix = Buffer.concat([this.prefix, bytes]);
		const bom = this.prefix.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
		const start = bom ? 3 : 0;
		const prefix = this.prefix.subarray(start);
		if (prefix.length < 4 && !final) return Buffer.alloc(0);
		const firstEnd = prefix.indexOf(10);
		const first = prefix
			.subarray(0, firstEnd < 0 ? prefix.length : firstEnd)
			.toString("utf8");
		if (!/^---[\t ]*\r?$/.test(first)) return this.flushWithoutHeader(start);
		if (firstEnd < 0) {
			if (final) return this.flushWithoutHeader(start);
			if (prefix.length > HEADER_LIMIT)
				throw new Error("Markdown frontmatter exceeds budget");
			return Buffer.alloc(0);
		}
		let cursor = firstEnd + 1;
		while (cursor < prefix.length) {
			const end = prefix.indexOf(10, cursor);
			if (end < 0 && !final) break;
			const stop = end < 0 ? prefix.length : end;
			if (
				/^---[\t ]*\r?$/.test(prefix.subarray(cursor, stop).toString("utf8"))
			) {
				if (cursor > HEADER_LIMIT)
					throw new Error("Markdown frontmatter exceeds budget");
				const closeEnd = end < 0 ? stop : end + 1;
				const decoder = new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true,
				});
				const yaml = decoder.decode(prefix.subarray(firstEnd + 1, cursor));
				const doc = parseDocument(yaml, { uniqueKeys: true });
				if (
					doc.errors.length ||
					doc.warnings.length ||
					(doc.contents && !isMap(doc.contents))
				)
					throw new Error("Unsafe Markdown frontmatter");
				visit(doc, (key, node) => {
					if (
						isAlias(node) ||
						(isNode(node) && "anchor" in node && node.anchor) ||
						(key === "key" && isScalar(node) && node.value === "<<")
					)
						throw new Error(
							"Frontmatter aliases and anchors require manual handling",
						);
				});
				let shared = yaml;
				if (isMap(doc.contents)) {
					for (const pair of doc.contents.items) {
						if (!isScalar(pair.key) || typeof pair.key.value !== "string")
							throw new Error("Unsupported frontmatter key");
						if (pair.key.value !== "updated") continue;
						if (
							doc.contents.flow ||
							!pair.key.range ||
							!isNode(pair.value) ||
							!pair.value.range
						)
							throw new Error("Unsupported updated property layout");
						const from = pair.key.range[0];
						if (from > 0 && yaml[from - 1] !== "\n")
							throw new Error(
								"Indented or explicit updated key requires manual handling",
							);
						let to = pair.value.range[2];
						if (to && yaml[to - 1] !== "\n") {
							const eol = yaml.indexOf("\n", to);
							to = eol < 0 ? yaml.length : eol + 1;
						}
						this.updated = yaml.slice(from, to);
						shared = yaml.slice(0, from) + yaml.slice(to);
					}
					// Reparse the remaining map: removal must not change another property's YAML structure.
					const check = parseDocument(shared);
					if (check.errors.length)
						throw new Error("Updated removal changed YAML structure");
				}
				const eol = first.endsWith("\r") ? "\r\n" : "\n";
				if (this.retain) {
					if (isMap(doc.contents) && doc.contents.flow)
						throw new Error("Cannot retain updated in flow frontmatter");
					shared += this.retain.replace(/\r?\n/g, eol);
					if (parseDocument(shared).errors.length)
						throw new Error("Cannot safely retain local updated");
				}
				const header = shared.trim()
					? Buffer.concat([
							prefix.subarray(0, firstEnd + 1),
							Buffer.from(shared),
							prefix.subarray(cursor, closeEnd),
						])
					: Buffer.alloc(0);
				const result = Buffer.concat([
					this.prefix.subarray(0, start),
					header,
					prefix.subarray(closeEnd),
				]);
				this.done = true;
				this.prefix = Buffer.alloc(0);
				return result;
			}
			cursor = stop + 1;
		}
		if (final) throw new Error("Unclosed Markdown frontmatter");
		if (prefix.length > HEADER_LIMIT)
			throw new Error("Markdown frontmatter exceeds budget");
		return Buffer.alloc(0);
	}
	private flushWithoutHeader(bom: number) {
		const result = this.retain
			? Buffer.concat([
					this.prefix.subarray(0, bom),
					Buffer.from(`---\n${this.retain.replace(/\r?\n/g, "\n")}---\n`),
					this.prefix.subarray(bom),
				])
			: this.prefix;
		this.done = true;
		this.prefix = Buffer.alloc(0);
		return result;
	}
}

export function sharedText(path: string, text: string | null) {
	if (text === null || !isMarkdown(path)) return text;
	return new MarkdownProjection()
		.push(Buffer.from(text), true)
		.toString("utf8");
}
