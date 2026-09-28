import { describe, expect, it } from "vitest";
import { countWords, getPersonaInitials } from "../src/lib/format.js";

describe("countWords", () => {
	// Tests that countWords splits on tabs, newlines and runs of spaces.
	it("counts words separated by tabs, newlines, and multiple spaces", () => {
		expect(countWords("hello\tworld\n\nfoo   bar")).toBe(4);
	});

	// Tests that countWords returns 0 for an empty string.
	it("returns 0 for an empty string", () => {
		expect(countWords("")).toBe(0);
	});

	// Tests that countWords returns 0 for a whitespace-only string.
	it("returns 0 for a whitespace-only string", () => {
		expect(countWords("   \n\t  ")).toBe(0);
	});

	// Tests that countWords treats null and undefined as empty.
	it('handles null and undefined via String(value ?? "")', () => {
		expect(countWords(null)).toBe(0);
		expect(countWords(undefined)).toBe(0);
	});
});

describe("getPersonaInitials", () => {
	// Tests that a single-word name yields one initial.
	it("takes the first letter of a single word", () => {
		expect(getPersonaInitials("Mary")).toBe("M");
	});

	// Tests that a two-word name yields two initials.
	it("takes the first letter of each of two words", () => {
		expect(getPersonaInitials("Mary Smith")).toBe("MS");
	});

	// Tests that only the first two words contribute initials.
	it("takes only the first two words when there are three or more", () => {
		expect(getPersonaInitials("Mary Jane Smith")).toBe("MJ");
	});

	// Tests that missing or empty names yield the 'NA' placeholder.
	it.each([undefined, null, ""])("returns 'NA' for %j", (value) => {
		expect(getPersonaInitials(value)).toBe("NA");
	});

	// Tests that leading and repeated spaces do not produce blank initials.
	it("collapses leading and repeated spaces instead of producing a blank initial", () => {
		expect(getPersonaInitials("  Mary   Smith")).toBe("MS");
	});

	// Tests that a single-character name yields that character.
	it("handles a single-character name", () => {
		expect(getPersonaInitials("X")).toBe("X");
	});

	// Tests that a unicode/emoji name yields two initials without throwing.
	it("handles a unicode/emoji name without throwing", () => {
		const name = "👩‍⚕️ Doctor";
		expect(getPersonaInitials(name)).toBe(`${name[0]?.toUpperCase()}D`);
		expect(getPersonaInitials(name)).toHaveLength(2);
	});
});
