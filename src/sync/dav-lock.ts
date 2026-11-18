import { AuthenticationError } from "./auth";
import { request, responseText } from "./http";

export class DavLockedError extends Error {
	constructor() {
		super("远端正在被其他设备同步，请稍后重新核验。");
	}
}

// Some WebDAV implementations return the token URI without the RFC 4918
// angle brackets. Preserve its opaque bytes; send the standard coded URL.
function lockTokenHeader(values: string[] | undefined) {
	if (values?.length !== 1) return;
	const header = values[0] ?? "";
	const uri =
		header.startsWith("<") && header.endsWith(">")
			? header.slice(1, -1)
			: header;
	const validUri =
		/^[a-z][a-z0-9+.-]*:(?:[a-z0-9._~:/?#@!$&'()*+,;=[\]-]|%[0-9a-f]{2})+$/i.test(
			uri,
		);
	return validUri ? `<${uri}>` : undefined;
}

/** Exclusive collection lock: one writer per remote tree, including new children. */
export class DavLock {
	private token = "";
	private expires = 0;
	constructor(
		private root: URL,
		private headers: Record<string, string>,
	) {}
	conditions() {
		// Reserve the full 120-second transfer deadline before admitting a write.
		if (!this.token || performance.now() + 120_000 >= this.expires)
			throw new Error("远端写入锁已失效，请重新核验后重试。");
		return { If: `<${this.root.href}> (${this.token})` };
	}
	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.token) throw new Error("已有同步操作正在使用此连接。");
		const started = performance.now();
		const response = await request(
			this.root,
			"LOCK",
			{
				...this.headers,
				Depth: "infinity",
				Timeout: "Second-600",
				"Content-Type": "application/xml; charset=utf-8",
			},
			'<d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>',
			15_000,
		);
		if (response.statusCode === 401) {
			response.destroy();
			throw new AuthenticationError();
		}
		if (response.statusCode !== 200) {
			response.destroy();
			if (response.statusCode === 423) throw new DavLockedError();
			throw new Error(
				`服务器不支持所需的目录写入锁（HTTP ${response.statusCode}），保持仅预览。`,
			);
		}
		const token = lockTokenHeader(response.headersDistinct["lock-token"]);
		if (!token) {
			response.destroy();
			throw new Error(
				response.headers["lock-token"] === undefined
					? "服务器已响应 LOCK，但响应头缺少 Lock-Token"
					: "服务器已响应 LOCK，但 Lock-Token 响应头格式无效",
			);
		}
		this.token = token;
		let failure = false;
		try {
			const xml = new DOMParser().parseFromString(
				await responseText(response, 64 * 1024),
				"application/xml",
			);
			const active = Array.from(
				xml.getElementsByTagNameNS("DAV:", "activelock"),
			).find(
				(node) =>
					node
						.getElementsByTagNameNS("DAV:", "locktoken")[0]
						?.textContent?.trim() === token.slice(1, -1),
			);
			const duration =
				active
					?.getElementsByTagNameNS("DAV:", "timeout")[0]
					?.textContent?.trim() ?? "";
			const seconds = Number(/^Second-(\d+)$/.exec(duration)?.[1]);
			if (
				xml.getElementsByTagName("parsererror").length ||
				!active ||
				!active
					.getElementsByTagNameNS("DAV:", "lockscope")[0]
					?.getElementsByTagNameNS("DAV:", "exclusive").length ||
				!active
					.getElementsByTagNameNS("DAV:", "locktype")[0]
					?.getElementsByTagNameNS("DAV:", "write").length ||
				active
					.getElementsByTagNameNS("DAV:", "depth")[0]
					?.textContent?.trim() !== "infinity" ||
				!Number.isFinite(seconds) ||
				seconds < 150 ||
				seconds > 600
			)
				throw new Error("服务器未确认有效的独占目录锁，保持仅预览。");
			// Stop before the server's lease deadline. Every mutation also submits the token.
			this.expires = started + (Math.min(seconds, 600) - 5) * 1000;
			return await task();
		} catch (error) {
			failure = true;
			throw error;
		} finally {
			this.token = "";
			this.expires = 0;
			await this.release(token, failure);
		}
	}
	private async release(token: string, suppress: boolean) {
		try {
			const released = await request(
				this.root,
				"UNLOCK",
				{ ...this.headers, "Lock-Token": token },
				undefined,
				15_000,
			);
			const status = released.statusCode;
			await responseText(released, 64 * 1024);
			if (status !== 204)
				throw new Error(`释放远端写入锁失败（HTTP ${status}），请稍后重试。`);
		} catch (error) {
			if (!suppress) throw error;
		}
	}
}
