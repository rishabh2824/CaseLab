import { describe, expect, it } from "vitest";
import { countWords } from "./messageRules";

describe("countWords", () => {
	// Tests that words are split on tabs, newlines and runs of spaces.
	it("counts words separated by tabs, newlines, and multiple spaces", () => {
		expect(countWords("hello\tworld\n\nfoo   bar")).toBe(4);
	});

	// Tests that blank input has no words.
	it.each(["", "   \n\t  "])("returns 0 for %j", (value) => {
		expect(countWords(value)).toBe(0);
	});

	// Tests that hyphenated words and emoji each count as one word.
	it("counts a hyphenated word as one and an emoji as a word", () => {
		expect(countWords("hyphen-joined stays one")).toBe(3);
		expect(countWords("emoji 🙂 counts")).toBe(3);
	});
});
