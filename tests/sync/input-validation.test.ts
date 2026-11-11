import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { checkpoint } from "@/sync/checkpoint";
import { digest, smallText } from "@/sync/files";
import { loadSettings } from "@/sync/settings";
import { byteChunks, hasErrorCode } from "@/sync/validation";
import { setup } from "./helpers";

const hash = "a".repeat(64);
const validIntent = () => ({
	id: "12345678-1234-1234-1234-123456789012",
	path: "note.md",
	local: { hash, size: 1, version: "inode" },
	remote: null,
	desired: hash,
	localDesired: hash,
	phase: "prepared",
	blocked: false,
});
const validState = () => ({
	format: 2,
	identity: "test",
	baseline: { "note.md": hash },
	pending: { "note.md": validIntent() },
});

describe("untrusted persisted values", () => {
	it("loads settings only from an object with recognized field types", () => {
		for (const raw of [
			null,
			false,
			5,
			"text",
			[],
			{ url: 12, username: {}, mock: "true" },
		]) {
			expect(loadSettings(raw)).toEqual({ url: "", username: "", mock: false });
		}
		expect(
			loadSettings({
				url: "https://dav.example.test/notes",
				username: "user",
				mock: true,
				password: "discard",
			}),
		).toEqual({
			url: "https://dav.example.test/notes/",
			username: "user",
			mock: true,
		});
	});
	it("preserves valid format 2 fields and creates prototype-free maps", () => {
		const state = checkpoint(validState(), "test");
		expect(state).toEqual(validState());
		expect(Object.getPrototypeOf(state.baseline)).toBeNull();
		expect(Object.getPrototypeOf(state.pending)).toBeNull();
		const weird = JSON.parse(
			`{"format":2,"identity":"test","baseline":{"__proto__":"${hash}","constructor":null},"pending":{}}`,
		) as unknown;
		expect(Object.keys(checkpoint(weird, "test").baseline)).toEqual([
			"__proto__",
			"constructor",
		]);
	});
	it("rejects invalid containers, identities and baseline values without coercion", () => {
		for (const value of [
			null,
			[],
			false,
			{ ...validState(), format: 1 },
			{ ...validState(), identity: "other" },
			{ ...validState(), baseline: [] },
			{ ...validState(), pending: [] },
			{ ...validState(), baseline: { "note.md": { toString: () => hash } } },
			{ ...validState(), baseline: { "../outside": hash } },
		]) {
			expect(() => checkpoint(value, "test")).toThrow();
		}
	});
	it.each([
		["id", 123],
		["path", "other.md"],
		["phase", "done"],
		["blocked", "false"],
		["desired", false],
		["localDesired", []],
		["local", undefined],
		["remote", {}],
		["local", { hash, size: "1", version: "v" }],
		["local", { hash, size: -1, version: "v" }],
		["local", { hash, size: 1.5, version: "v" }],
		["local", { hash, size: 1, version: 12 }],
		["local", { hash, size: 1, version: "v", syncHash: 12 }],
	])("rejects malformed intent %s (%#)", (key, value) => {
		const state = validState();
		Object.assign(state.pending["note.md"], { [key]: value });
		expect(() => checkpoint(state, "test")).toThrow("Corrupt intent");
	});
	it("a corrupt checkpoint stops preview and recovery before changing notes or checkpoints", async () => {
		const s = await setup();
		await writeFile(join(s.a, "note.md"), "unchanged");
		await mkdir(s.A.journal.dir);
		const value = {
			...validState(),
			identity: s.A.journal.identity,
			pending: [],
		};
		await writeFile(
			join(s.A.journal.dir, "000000000001.json"),
			JSON.stringify(value),
		);
		const counters = { ...s.server.counters };
		await expect(s.A.preview()).rejects.toThrow();
		await expect(s.A.recover()).rejects.toThrow();
		expect(await readFile(join(s.a, "note.md"), "utf8")).toBe("unchanged");
		expect(
			(await readdir(s.A.journal.dir)).filter((name) => name.endsWith(".json")),
		).toEqual(["000000000001.json"]);
		expect(
			await readFile(join(s.A.journal.dir, "000000000001.json"), "utf8"),
		).toBe(JSON.stringify(value));
		expect(await readdir(s.A.journal.blobs)).toEqual([]);
		expect(s.server.counters).toEqual(counters);
	});
});

describe("stream and error boundaries", () => {
	it("accepts bytes and UTF-8 strings without changing content", async () => {
		const chunks = [];
		for await (const chunk of byteChunks(
			Readable.from([
				Buffer.from([0, 255]),
				new Uint8Array([13, 10]),
				"中文🙂",
			]),
		))
			chunks.push(chunk);
		expect(Buffer.concat(chunks)).toEqual(
			Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("中文🙂")]),
		);
	});
	it("rejects object-mode values instead of hashing or buffering coerced data", async () => {
		await expect(digest(Readable.from([{ length: 1 }]))).rejects.toThrow(
			"Expected a byte stream",
		);
		await expect(smallText(Readable.from([42]), null)).rejects.toThrow(
			"Expected a byte stream",
		);
	});
	it("checks error codes without assuming a rejected value is an Error", () => {
		expect(
			hasErrorCode(Object.assign(new Error(), { code: "ENOENT" }), "ENOENT"),
		).toBe(true);
		for (const value of [null, undefined, "ENOENT", {}, { code: 123 }])
			expect(hasErrorCode(value, "ENOENT")).toBe(false);
	});
});
