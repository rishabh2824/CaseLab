import { describe, expect, it } from "vitest";
import { getPersonaInitials } from "../src/lib/format.js";

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

	// Tests that an emoji initial is the whole code point, not half of a surrogate pair.
	it("keeps an emoji initial whole instead of splitting its surrogate pair", () => {
		expect(getPersonaInitials("👩‍⚕️ Doctor")).toBe("👩D");
		expect(getPersonaInitials("🙂")).toBe("🙂");
	});
});
