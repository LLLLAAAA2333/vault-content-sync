import { expect, it } from "vitest";
import { collectionUrl, savedCollectionUrl } from "@/sync/connection";

it.each([
	"https://name:synthetic-secret@example.com/dav/",
	"https://name@example.com/dav/",
	"https://example.com/dav/?token=synthetic-secret",
	"https://example.com/dav/#synthetic-secret",
	"http://example.com/dav/",
	"file:///tmp/synthetic-secret",
	"synthetic-secret",
])("does not persist or echo unsafe URL input", (value) => {
	expect(savedCollectionUrl(value)).toBe("");
	expect(() => collectionUrl(value)).toThrow();
	try {
		collectionUrl(value);
	} catch (error) {
		expect(String(error)).not.toContain("synthetic-secret");
	}
});
it("normalizes plain collection URLs and allows only loopback HTTP", () => {
	expect(collectionUrl("https://example.com/notes").href).toBe(
		"https://example.com/notes/",
	);
	expect(savedCollectionUrl("  https://example.com/notes/ ")).toBe(
		"https://example.com/notes/",
	);
	for (const host of ["localhost", "127.0.0.1", "[::1]"])
		expect(collectionUrl(`http://${host}:1234/`).protocol).toBe("http:");
	for (const value of [null, {}, undefined, ""])
		expect(savedCollectionUrl(value)).toBe("");
});
