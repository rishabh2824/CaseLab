import { describe, expect, it } from "vitest";
import {
	casePath,
	filePath,
	PERSONAS_PATH,
	personaPath,
	referralPath,
} from "#shared/rules.js";
import {
	fieldDomId,
	pathKey,
	personaOf,
	tabOf,
} from "../../src/lib/case/fieldPath.js";

describe("field paths", () => {
	// Tests that case fields sit on the information tab, and persona and referral fields on the personas tab.
	it("puts case fields on the info tab and persona and referral fields on the personas tab", () => {
		expect(tabOf(casePath("accessCode"))).toBe("info");
		expect(tabOf(PERSONAS_PATH)).toBe("personas");
		expect(tabOf(personaPath("a", "name"))).toBe("personas");
		expect(tabOf(filePath("a", 0, "file"))).toBe("personas");
		expect(tabOf(referralPath("a", "b"))).toBe("personas");
	});

	// Tests that a field names the persona to open, and a referral names the persona it points at.
	it("names the persona a field belongs to, and a referral's is the one it points at", () => {
		expect(personaOf(casePath("name"))).toBeUndefined();
		expect(personaOf(PERSONAS_PATH)).toBeUndefined();
		expect(personaOf(personaPath("a", "role"))).toBe("a");
		expect(personaOf(filePath("a", 1, "shareConditions"))).toBe("a");
		expect(personaOf(referralPath("a", "b"))).toBe("b");
	});

	// Tests that every distinct field gets its own key and DOM id.
	it("gives distinct fields distinct keys and DOM ids", () => {
		const paths = [
			casePath("name"),
			casePath("brief"),
			personaPath("a", "name"),
			personaPath("b", "name"),
			filePath("a", 0, "file"),
			filePath("a", 1, "file"),
			referralPath("a", "b"),
			referralPath("b", "a"),
		];
		expect(new Set(paths.map(pathKey)).size).toBe(paths.length);
		expect(new Set(paths.map(fieldDomId)).size).toBe(paths.length);
	});
});
