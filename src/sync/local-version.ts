import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { isMarkdown, MarkdownProjection } from "./content";
import { digest, hashFile } from "./files";
import { hashOf, type Seen } from "./model";
import type { Journal } from "./state";

export async function localVersion(
	journal: Journal,
	path: string,
	desired: string | null,
	local: Seen,
) {
	if (!desired) return null;
	if (local && hashOf(local) === desired) return local.hash;
	if (!isMarkdown(path) || !local) return desired;
	const prefix = new MarkdownProjection();
	for await (const chunk of createReadStream(journal.blob(local.hash), {
		highWaterMark: 64 * 1024,
	})) {
		prefix.push(Buffer.from(chunk));
		if (prefix.done) break;
	}
	if (!prefix.done) prefix.push(Buffer.alloc(0), true);
	if (!prefix.updated) return desired;
	const transform = new MarkdownProjection(prefix.updated);
	const sharedSource = journal.blob(desired);
	async function* content() {
		for await (const chunk of createReadStream(sharedSource, {
			highWaterMark: 64 * 1024,
		}))
			yield transform.push(Buffer.from(chunk));
		yield transform.push(Buffer.alloc(0), true);
	}
	const result = await digest(Readable.from(content()), journal.blobs);
	if (
		hashOf(await hashFile(journal.blob(result.hash), undefined, path)) !==
		desired
	)
		throw new Error("Local updated restoration changed shared content");
	return result.hash;
}
