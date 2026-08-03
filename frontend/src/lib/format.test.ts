// Node project: pure string helpers, no DOM required.
import { describe, expect, it } from "vitest";
import { countWords, slugify } from "./format.js";

describe("slugify", () => {
	it("collapses a run of unicode/punctuation into a single '-'", () => {
		// Regression guard: the replace regex must collapse the whole run
		// ("  — ", multiple spaces plus an em dash) into one separator, not one
		// per offending character (which would produce "a---b").
		expect(slugify("Café — Déjà Vu!!  Meeting")).toBe("caf-d-j-vu-meeting");
	});

	it("trims leading/trailing separators instead of leaving a dangling '-'", () => {
		expect(slugify("  !!!Hello World???  ")).toBe("hello-world");
	});

	it('handles null, undefined, and numbers via String(value ?? "")', () => {
		expect(slugify(null)).toBe("");
		expect(slugify(undefined)).toBe("");
		expect(slugify(42)).toBe("42");
	});

	it("returns an empty string for an all-punctuation input", () => {
		// Every character gets collapsed to one separator, which then gets
		// trimmed away entirely — must not leave a bare "-".
		expect(slugify("!!!???...")).toBe("");
	});
});

describe("countWords", () => {
	// countWords backs the 50-word send limit enforced client-side on the chat
	// composer; the backend enforces the same limit server-side, so a drift
	// here (e.g. counting tabs/newlines as word characters) would let a
	// message through client-side that the backend then rejects.
	it("counts words separated by tabs, newlines, and multiple spaces", () => {
		expect(countWords("hello\tworld\n\nfoo   bar")).toBe(4);
	});

	it("returns 0 for an empty string", () => {
		expect(countWords("")).toBe(0);
	});

	it("returns 0 for a whitespace-only string", () => {
		expect(countWords("   \n\t  ")).toBe(0);
	});

	it('handles null and undefined via String(value ?? "")', () => {
		expect(countWords(null)).toBe(0);
		expect(countWords(undefined)).toBe(0);
	});
});
