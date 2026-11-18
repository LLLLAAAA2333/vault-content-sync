import * as http from "node:http";
import * as https from "node:https";
import type { Readable } from "node:stream";
import * as timers from "node:timers";
import { byteChunks } from "./validation";

export function request(
	url: URL,
	method: string,
	headers: Record<string, string> = {},
	body?: Readable | string,
	deadlineMs = 120_000,
): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const req = (url.protocol === "https:" ? https : http).request(
			url,
			{ method, headers },
			resolve,
		);
		const timer = timers.setTimeout(
			() => req.destroy(new Error("Request deadline exceeded")),
			deadlineMs,
		);
		req.on("error", reject);
		req.on("close", () => timers.clearTimeout(timer));
		if (typeof body === "string") req.end(body);
		else if (body) {
			body.on("error", (e) => req.destroy(e));
			req.on("error", () => body.destroy());
			req.on("response", (res) => {
				if ((res.statusCode ?? 500) >= 400) body.destroy();
			});
			body.pipe(req);
		} else req.end();
	});
}
export async function responseText(
	res: http.IncomingMessage,
	limit = 16 * 1024 * 1024,
) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of byteChunks(res)) {
		size += chunk.length;
		if (size > limit) {
			res.destroy();
			throw new Error("Response exceeds budget");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
