import { describe, expect, it } from "vitest";
import {
	caseStructure,
	personaPayload,
	referralEdge,
} from "../../tests/support/factories";
import {
	boundaryReply,
	flattenPersonas,
	isChatEnded,
	NONSENSE_THRESHOLD,
} from "./runs";

describe("flattenPersonas", () => {
	// Tests that persona secrets are carried through unchanged.
	it("carries persona secrets through unchanged", () => {
		const structure = caseStructure({
			personas: [
				personaPayload("A", {
					name: "Mary",
					role: "CFO",
					knownFacts: "secret facts",
					personalityTraits: "calm",
					availabilityMinutes: 30,
				}),
			],
		});
		const graph = flattenPersonas(structure);
		const mary = graph.personas.get("A")!;
		expect(mary.knownFacts).toBe("secret facts");
		expect(mary.personalityTraits).toBe("calm");
		expect(mary.availabilityMinutes).toBe(30);
	});

	// Tests that root rows are sorted by name.
	it("sorts root rows by name", () => {
		const structure = caseStructure({
			personas: [
				personaPayload("A", { name: "Zed" }),
				personaPayload("B", { name: "Alice" }),
			],
		});
		const graph = flattenPersonas(structure);
		expect(graph.roots.map((id) => graph.personas.get(id)!.name)).toEqual([
			"Alice",
			"Zed",
		]);
	});

	// Tests that every referral becomes an edge, keeping an empty condition as an empty string.
	it("turns every referral into an edge, keeping an empty condition as an empty string", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			referrals: [referralEdge("A", "B", "")],
		});
		const graph = flattenPersonas(structure);
		expect(graph.referrals).toHaveLength(1);
		expect(graph.referrals[0]).toEqual({
			fromId: "A",
			toId: "B",
			conditions: "",
		});
	});

	// Tests that a persona referred by two parents is stored once, not once per edge.
	it("stores a persona referred by two parents once, not once per edge", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B"), personaPayload("C")],
			referrals: [referralEdge("A", "C"), referralEdge("B", "C")],
		});
		const graph = flattenPersonas(structure);
		expect(graph.referrals.map((e) => `${e.fromId}->${e.toId}`).sort()).toEqual(
			["A->C", "B->C"],
		);
		expect([...graph.personas.keys()].sort()).toEqual(["A", "B", "C"]);
	});

	// Tests that roots are the personas nobody refers to, so a referred persona is not one.
	it("computes the roots as the personas nobody refers to", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B"), personaPayload("C")],
			referrals: [referralEdge("A", "B")],
		});
		const graph = flattenPersonas(structure);
		expect([...graph.roots].sort()).toEqual(["A", "C"]);
		expect([...graph.personas.keys()].sort()).toEqual(["A", "B", "C"]);
		expect(graph.referrals).toHaveLength(1);
	});
});

describe("isChatEnded", () => {
	// Tests that a chat ends exactly when the warnings reach the threshold.
	it("ends the chat at NONSENSE_THRESHOLD warnings and not before", () => {
		expect(isChatEnded(0)).toBe(false);
		expect(isChatEnded(NONSENSE_THRESHOLD - 1)).toBe(false);
		expect(isChatEnded(NONSENSE_THRESHOLD)).toBe(true);
		expect(isChatEnded(NONSENSE_THRESHOLD + 1)).toBe(true);
	});
});

describe("boundaryReply", () => {
	// Tests that boundaryReply names the persona when ending the conversation.
	it("names the persona when ending the conversation", () => {
		expect(boundaryReply("Mary", true)).toMatch(
			/^Mary is ending this conversation/,
		);
	});

	// Tests that boundaryReply gives a fixed warning regardless of name when not ending.
	it("is a fixed warning regardless of name when not ending", () => {
		expect(boundaryReply("Mary", false)).toBe(
			"I am not able to follow that. Please send a clear, respectful, case-related " +
				"question if you want to continue.",
		);
	});

	// Tests that boundaryReply falls back to 'I' for an empty name.
	it("falls back to 'I' for an empty name", () => {
		expect(boundaryReply("", true)).toMatch(/^I is ending this conversation/);
	});
});
