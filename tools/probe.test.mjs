import assert from "node:assert/strict";
import test from "node:test";
import { startMock } from "./mock-server.mjs";
import { probe } from "./probe.mjs";

test("overlapping-body probe passes an atomic server and catches a header-time precheck server", async () => {
	for (const unsafe of [false, true]) {
		const server = await startMock({ unsafe });
		try {
			const r = await probe(server.url);
			assert.equal(r.checks.stalePut, true);
			assert.equal(r.checks.staleDelete, true);
			for (const key of [
				"create",
				"overwrite",
				"put-vs-delete",
				"delete-vs-put",
			])
				assert.equal(r.checks[`overlap:${key}`], !unsafe);
			assert.equal(r.observedPass, !unsafe);
			assert.equal(r.automaticWritesEnabled, false);
		} finally {
			await server.stop();
		}
	}
});
