// Node project: pure string helpers, no DOM required.
import { describe, expect, it } from "vitest";
import { countWords, getPersonaInitials } from "../src/lib/format.js";

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

describe("getPersonaInitials", () => {
	it("takes the first letter of a single word", () => {
		expect(getPersonaInitials("Mary")).toBe("M");
	});

	it("takes the first letter of each of two words", () => {
		expect(getPersonaInitials("Mary Smith")).toBe("MS");
	});

	it("takes only the first two words when there are three or more", () => {
		expect(getPersonaInitials("Mary Jane Smith")).toBe("MJ");
	});

	it.each([undefined, null, ""])("returns 'NA' for %j", (value) => {
		expect(getPersonaInitials(value)).toBe("NA");
	});

	it("collapses leading and repeated spaces instead of producing a blank initial", () => {
		// A naive split(" ") would produce a leading "" entry from the double
		// space and pick that as the "first" part.
		expect(getPersonaInitials("  Mary   Smith")).toBe("MS");
	});

	it("handles a single-character name", () => {
		expect(getPersonaInitials("X")).toBe("X");
	});

	it("handles a unicode/emoji name without throwing", () => {
		const name = "👩‍⚕️ Doctor";
		// `part[0]` indexes by UTF-16 code unit, not grapheme, so an astral
		// emoji (a surrogate pair) only contributes its leading half here —
		// documenting the real behavior rather than a hand-typed literal that's
		// easy to get subtly wrong.
		expect(getPersonaInitials(name)).toBe(`${name[0]?.toUpperCase()}D`);
		expect(getPersonaInitials(name)).toHaveLength(2);
	});
});
