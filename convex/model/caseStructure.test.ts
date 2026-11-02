import { describe, expect, it } from "vitest";
import {
	caseStructure,
	personaPayload,
	referralEdge,
} from "../../tests/support/factories";
import { trimStructure, validateGraph } from "./caseStructure";

describe("trimStructure", () => {
	// Tests that persona name and role are trimmed.
	it("trims persona name and role", () => {
		const structure = trimStructure(
			caseStructure({
				personas: [personaPayload("A", { name: "  Mary ", role: " CFO  " })],
			}),
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
			),
		).toThrow(/cycle/i);
	});
});
