import { once } from "node:events";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AuthenticationError } from "@/sync/auth";
import { DavLock, DavLockedError } from "@/sync/dav-lock";
import "./helpers";

const servers: http.Server[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	}
});
const token = "<urn:uuid:synthetic-lock>";
const xml = (depth = "infinity", timeout = "Second-600") =>
	`<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:depth>${depth}</d:depth><d:timeout>${timeout}</d:timeout><d:locktoken><d:href>${token.slice(1, -1)}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
async function serve(
	options: {
		status?: number;
		body?: string;
		unlock?: number;
		header?: string | string[] | null;
	} = {},
) {
	const calls: { method?: string; headers: http.IncomingHttpHeaders }[] = [];
	const server = http.createServer((req, res) => {
		calls.push({ method: req.method, headers: req.headers });
		req.resume();
		if (req.method === "UNLOCK") res.writeHead(options.unlock ?? 204).end();
		else
			res
				.writeHead(
					options.status ?? 200,
					options.header === null
						? {}
						: { "Lock-Token": options.header ?? token },
				)
				.end(options.body ?? xml());
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	const root = new URL(`http://127.0.0.1:${address.port}/collection/`);
	return { root, calls, lock: new DavLock(root, {}) };
}

it("uses a tagged collection token, releases on success, and disallows expired leases", async () => {
	const s = await serve();
	expect(() => s.lock.conditions()).toThrow("失效");
	await s.lock.run(async () => {
		expect(s.lock.conditions()).toEqual({ If: `<${s.root.href}> (${token})` });
		vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
		expect(() => s.lock.conditions()).toThrow("失效");
	});
	expect(s.calls.map((c) => c.method)).toEqual(["LOCK", "UNLOCK"]);
	expect(s.calls[0]?.headers.depth).toBe("infinity");
	expect(s.calls[1]?.headers["lock-token"]).toBe(token);
	expect(() => s.lock.conditions()).toThrow("失效");
});
it("canonicalizes a bare token confirmed by the LOCK response for If and UNLOCK", async () => {
	const s = await serve({ header: token.slice(1, -1) });
	await s.lock.run(async () => {
		expect(s.lock.conditions()).toEqual({ If: `<${s.root.href}> (${token})` });
	});
	expect(s.calls.at(-1)?.headers["lock-token"]).toBe(token);
});
it.each([
	null,
	"token",
	"<urn:test",
	"urn:test>",
	"urn:one urn:two",
	["urn:one", "urn:two"],
])(
	"stops on missing, malformed or ambiguous token headers %#",
	async (header) => {
		const s = await serve({ header });
		const task = vi.fn();
		await expect(s.lock.run(task)).rejects.toThrow("Lock-Token");
		expect(task).not.toHaveBeenCalled();
		expect(s.calls).toHaveLength(1);
	},
);
it.each([
	xml().replace("urn:uuid:synthetic-lock", "urn:uuid:other"),
	xml().replace("<d:write/>", "<d:read/>"),
	xml("0"),
	xml("infinity", "Second-5"),
	xml("infinity", "Infinite"),
	xml("infinity", "Second-3600"),
	xml("infinity", "unknown"),
	"<bad>",
])(
	"rejects unconfirmed scope or lease and still releases its acquired token %#",
	async (body) => {
		const s = await serve({ body });
		const task = vi.fn();
		await expect(s.lock.run(task)).rejects.toThrow();
		expect(task).not.toHaveBeenCalled();
		expect(s.calls.at(-1)?.method).toBe("UNLOCK");
	},
);
it.each([401, 423, 405])(
	"rejects HTTP %s before entering any mutation",
	async (status) => {
		const s = await serve({ status });
		const task = vi.fn();
		const error = await s.lock.run(task).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(
			status === 401
				? AuthenticationError
				: status === 423
					? DavLockedError
					: Error,
		);
		expect(task).not.toHaveBeenCalled();
	},
);
it("preserves the original transfer failure if releasing also fails, but reports a lone unlock failure", async () => {
	const s = await serve({ unlock: 500 });
	await expect(
		s.lock.run(async () => {
			throw new Error("original failure");
		}),
	).rejects.toThrow("original failure");
	await expect(s.lock.run(async () => 1)).rejects.toThrow("释放远端写入锁失败");
});
