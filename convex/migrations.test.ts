import { describe, expect, it } from "vitest";
import {
	caseStructure,
	personaPayload,
} from "../tests/support/convexFactories";
import type { Id } from "./_generated/dataModel";
import { toCamelStructure } from "./migrations";
import type { LegacyCaseStructure } from "./models/legacyCases";

const storageId = "kg2test00000000000000000" as Id<"_storage">;

// Builds a case structure in the old snake_case shape, with a photo, a file, a referral and no availability on the second persona.
function legacyStructure(): LegacyCaseStructure {
	return {
		personas: [
			{
				id: "A",
				name: "Mary",
				role: "CFO",
				profile_photo: {
					storage_id: storageId,
					file_name: "mary.png",
					content_type: "image/png",
				},
				known_facts: "facts",
				personality_traits: "calm",
				availability_minutes: 30,
				files: [
					{
						file: { storage_id: storageId, file_name: "doc.pdf" },
						share_conditions: "when asked",
						perceived_contents: "numbers",
					},
				],
			},
			{
				id: "B",
				name: "Bob",
				role: "COO",
				profile_photo: null,
				known_facts: "",
				personality_traits: "",
				files: [],
			},
		],
		referrals: [{ from_id: "A", to_id: "B", conditions: "if asked" }],
		roots: ["A"],
	};
}

describe("toCamelStructure", () => {
	// Tests that every snake_case key, including nested file references and referrals, becomes camelCase.
	it("converts every key of a snake_case structure", () => {
		const { structure, changed } = toCamelStructure(legacyStructure());

		expect(changed).toBe(true);
		expect(structure.personas[0]).toEqual({
			id: "A",
			name: "Mary",
			role: "CFO",
			profilePhoto: {
				storageId,
				fileName: "mary.png",
				contentType: "image/png",
			},
			knownFacts: "facts",
			personalityTraits: "calm",
			availabilityMinutes: 30,
			files: [
				{
					file: { storageId, fileName: "doc.pdf" },
					shareConditions: "when asked",
					perceivedContents: "numbers",
				},
			],
		});
		expect(structure.referrals).toEqual([
			{ fromId: "A", toId: "B", conditions: "if asked" },
		]);
		expect(structure.roots).toEqual(["A"]);
	});

	// Tests that a persona saved without an availability gets an explicit null.
	it("gives a persona without an availability an explicit null", () => {
		const { structure } = toCamelStructure(legacyStructure());
		expect(structure.personas[1]?.availabilityMinutes).toBeNull();
	});

	// Tests that a structure already in camelCase is returned untouched, so the backfill can be re-run.
	it("leaves a camelCase structure alone", () => {
		const current = caseStructure({ personas: [personaPayload("A")] });
		const result = toCamelStructure(current);
		expect(result.changed).toBe(false);
		expect(result.structure).toBe(current);
	});
});
