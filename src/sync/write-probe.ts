import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { AuthenticationError } from "./auth";
import { DavLock, DavLockedError } from "./dav-lock";
import { request, responseText } from "./http";
import { PROBE_PREFIX } from "./model";
import { type DavOptions, WebDavStore } from "./webdav";
import { grantWriteAccess, writeScope } from "./write-access";

const strong = (etag: string) => /^"[^"\r\n]+"$/.test(etag);
function locked(result: { status?: number; body: string }) {
	if (result.status === 423) return true;
	if (result.status !== 207) return false;
	const xml = new DOMParser().parseFromString(result.body, "application/xml");
	const statuses = Array.from(xml.getElementsByTagNameNS("DAV:", "status"));
	return (
		!xml.getElementsByTagName("parsererror").length &&
		statuses.length > 0 &&
		statuses.every((node) =>
			/^HTTP\/\d(?:\.\d)? (423|424)(?: |$)/.test(node.textContent ?? ""),
		) &&
		statuses.some((node) => / 423(?: |$)/.test(node.textContent ?? ""))
	);
}

/** Mutates only a newly created, excluded synthetic child. Never scans the user's tree. */
export async function verifyWriteAccess(
	options: DavOptions,
	current = () => true,
) {
	const parent = new WebDavStore(options);
	await parent.testConnection();
	const directory = `${PROBE_PREFIX}${randomUUID()}`;
	const root = new URL(`${directory}/`, parent.root);
	const checks: string[] = [];
	let step = "创建独立测试目录";
	const assert = (condition: unknown, label: string) => {
		if (!condition) throw new Error(label);
		checks.push(label);
	};
	const call = async (
		name: string,
		method: string,
		extra: Record<string, string> = {},
		body?: string,
	) => {
		if (!current()) throw new Error("连接已改变，验证已取消。");
		const url = new URL(
			name.split("/").map(encodeURIComponent).join("/"),
			root,
		);
		const res = await request(
			url,
			method,
			{
				...parent.headers,
				"Cache-Control": "no-cache",
				...extra,
				...(body === undefined
					? {}
					: { "Content-Length": String(Buffer.byteLength(body)) }),
			},
			body,
			15_000,
		);
		if (res.statusCode === 401) {
			res.destroy();
			throw new AuthenticationError();
		}
		return {
			status: res.statusCode,
			etag: res.headers.etag ?? "",
			body: await responseText(res, 64 * 1024),
		};
	};
	const readStrong = async (name: string) => {
		let result = await call(name, "GET");
		for (
			let attempt = 0;
			result.status === 200 && !strong(result.etag) && attempt < 12;
			attempt++
		) {
			await delay(250);
			result = await call(name, "GET");
		}
		return result;
	};
	try {
		assert((await call("", "MKCOL")).status === 201, "新建独立目录");
		const lock = new DavLock(root, parent.headers);
		step = "独占目录锁";
		await lock.run(async () => {
			let competing = false;
			try {
				await new DavLock(root, parent.headers).run(async () => {});
			} catch (error) {
				if (!(error instanceof DavLockedError)) throw error;
				competing = true;
			}
			assert(competing, "拒绝第二个写入锁");
			assert(
				locked(await call("intruder.txt", "PUT", {}, "blocked")),
				"锁阻止无令牌的新建",
			);
			assert(
				(await call("intruder.txt", "GET")).status === 404,
				"被阻止的新建没有留下文件",
			);
			assert(locked(await call("intruder-dir", "MKCOL")), "锁保护子目录");
			const headers = () => lock.conditions();
			const name = "中文 空格%?#.txt";
			step = "路径、内容与版本标识";
			assert(
				[200, 201, 204].includes(
					(
						await call(
							name,
							"PUT",
							{ ...headers(), "If-None-Match": "*" },
							"first-version",
						)
					).status ?? 0,
				),
				"带锁新建",
			);
			const original = await readStrong(name);
			assert(
				original.status === 200 &&
					original.body === "first-version" &&
					strong(original.etag),
				"内容与强 ETag",
			);
			const listing = await new WebDavStore({
				...options,
				url: root.href,
			}).list();
			assert(listing.files.includes(name), "编码路径可列出");
			step = "条件覆盖与删除";
			assert(
				(await call(name, "PUT", { ...headers(), "If-None-Match": "*" }, "bad"))
					.status === 412,
				"拒绝重复新建",
			);
			assert(locked(await call(name, "PUT", {}, "bad")), "锁阻止无令牌覆盖");
			assert(locked(await call(name, "DELETE")), "锁阻止无令牌删除");
			assert(
				[200, 201, 204].includes(
					(
						await call(
							name,
							"PUT",
							{ ...headers(), "If-Match": original.etag },
							"second-version",
						)
					).status ?? 0,
				),
				"带锁条件覆盖",
			);
			const newer = await readStrong(name);
			assert(
				newer.body === "second-version" &&
					strong(newer.etag) &&
					newer.etag !== original.etag,
				"覆盖后版本推进",
			);
			assert(
				(
					await call(
						name,
						"PUT",
						{ ...headers(), "If-Match": original.etag },
						"bad",
					)
				).status === 412,
				"拒绝旧版本覆盖",
			);
			assert(
				(
					await call(name, "DELETE", {
						...headers(),
						"If-Match": original.etag,
					})
				).status === 412,
				"拒绝旧版本删除",
			);
			const invalid = await call(
				name,
				"PUT",
				{ If: `(<urn:uuid:${randomUUID()}>)`, "If-Match": newer.etag },
				"bad",
			);
			assert([412, 423].includes(invalid.status ?? 0), "拒绝无效锁令牌");
			assert(
				(await call(name, "GET")).body === newer.body,
				"拒绝写入后原内容不变",
			);
			step = "中断上传保留原内容";
			const stream = new PassThrough();
			const pending = request(
				new URL(encodeURIComponent(name), root),
				"PUT",
				{
					...parent.headers,
					...headers(),
					"If-Match": newer.etag,
					"Content-Length": "32",
				},
				stream,
				15_000,
			)
				.then(async (res) => {
					await responseText(res, 64 * 1024);
				})
				.catch(() => {});
			stream.write("partial");
			await delay(100);
			stream.destroy(new Error("Synthetic interrupted upload"));
			await pending;
			await delay(100);
			const after = await readStrong(name);
			assert(
				after.status === 200 && after.body === newer.body,
				"中断上传保留原内容",
			);
			assert(
				(await call(name, "DELETE", { ...headers(), "If-Match": after.etag }))
					.status === 204,
				"带锁条件删除",
			);
			assert((await call(name, "GET")).status === 404, "删除结果确认");
		});
		step = "释放写入锁";
		// Reacquisition proves release. No permission is carried by a report on disk.
		await new DavLock(root, parent.headers).run(async () => {});
		if (!current()) throw new Error("连接已改变，验证已取消。");
		return {
			access: grantWriteAccess(writeScope(options)),
			directory,
			checks,
			verifiedAt: Date.now(),
		};
	} catch (error) {
		if (error instanceof AuthenticationError) throw error;
		throw new Error(
			`写入验证未通过（${step}）：${error instanceof Error ? error.message : "请求失败"}。保持仅预览；测试目录 ${directory}。`,
			{ cause: error },
		);
	}
}
