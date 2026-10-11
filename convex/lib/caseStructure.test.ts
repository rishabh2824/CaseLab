import { describe, expect, it } from "vitest";
import {
	caseStructure,
	fileEntry,
	personaPayload,
} from "../../tests/support/convexFactories";
import type { Id } from "../_generated/dataModel";
import { cleanStructure } from "./caseStructure";

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
