import { describe, expect, it } from "vitest";
import {
	caseStructure,
	fileEntry,
	personaPayload,
	referralEdge,
} from "../../tests/support/factories";
import type { Id } from "../_generated/dataModel";
import { cleanStructure, validateGraph } from "./caseStructure";

const present = "kg2test00000000000000001" as Id<"_storage">;
const gone = "kg2test00000000000000002" as Id<"_storage">;

describe("cleanStructure", () => {
	// Tests that file entries and a photo whose upload is gone are dropped, while the rest of the persona is kept.
	it("drops file entries and photos whose upload no longer exists", () => {
		const { structure, storageIds } = cleanStructure(
			caseStructure({
				personas: [
					personaPayload("A", {
						profilePhoto: {
							storageId: gone,
							fileName: "a.png",
							contentType: "image/png",
						},
						files: [
							fileEntry({ storageId: present, fileName: "kept.pdf" }),
							fileEntry({ storageId: gone, fileName: "lost.pdf" }),
						],
					}),
				],
			}),
			new Set([present]),
		);

		const persona = structure.personas[0]!;
		expect(persona.profilePhoto).toBeNull();
		expect(persona.files.map((f) => f.file?.fileName)).toEqual(["kept.pdf"]);
		expect([...storageIds]).toEqual([present]);
	});

	// Tests that persona name and role are trimmed.
	it("trims persona name and role", () => {
		const { structure } = cleanStructure(
			caseStructure({
				personas: [personaPayload("A", { name: "  Mary ", role: " CFO  " })],
			}),
			new Set(),
		);
		expect(structure.personas[0]).toMatchObject({ name: "Mary", role: "CFO" });
	});
});

describe("validateGraph", () => {
	// Tests that a rule from the shared structure check surfaces through the save-time validator.
	it("surfaces the shared graph rules, such as a cycle", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B")],
				[referralEdge("A", "B"), referralEdge("B", "A")],
				["A"],
			),
		).toThrow(/cycle/i);
	});

	// Tests that persona field errors are reported against the persona's id.
	it("reports the first persona field error with the persona id", () => {
		expect(() =>
			validateGraph([personaPayload("A", { name: "  " })], [], ["A"]),
		).toThrow(/Persona A: Name is required/);
	});

	// Tests that persona ids that cannot be Convex record keys are rejected.
	it.each([
		"$boss",
		"_boss",
		"café",
		"persona id",
		`persona${String.fromCharCode(0)}id`,
		"emoji-🙂",
		`"><script>alert(1)</script>`,
	])("rejects %j as a persona id", (badId) => {
		expect(() => validateGraph([personaPayload(badId)], [], [badId])).toThrow(
			/Invalid persona id/,
		);
	});

	// Tests that the id shapes the authoring UI and old data produce are accepted.
	it.each([
		"550e8400-e29b-41d4-a716-446655440000",
		"1",
		"persona_A",
		"persona.A",
		"A-B",
	])("accepts %j as a persona id", (id) => {
		expect(() => validateGraph([personaPayload(id)], [], [id])).not.toThrow();
	});
});
