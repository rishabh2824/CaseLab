import { describe, expect, it } from "vitest";
import {
	caseStructure,
	personaPayload,
	referralEdge,
} from "../../tests/support/convexFactories";
import type { Id } from "../_generated/dataModel";
import type { PersonaGraph } from "./simulationReads";
import {
	flattenPersonas,
	graphPersonas,
	graphReferrals,
	graphRootPersonas,
} from "./simulationReads";

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
			roots: ["A", "B"],
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
			roots: ["A", "B"],
		});
		const graph = flattenPersonas(structure);
		const targets = new Set(
			graph.referrals.map((e) => `${e.fromId}->${e.toId}`),
		);
		expect(targets).toEqual(new Set(["A->C", "B->C"]));
		expect(graph.personas.size).toBe(3);
	});

	// Tests that a persona that is both a root and a referral target is stored once.
	it("stores a persona that is both a root and a referral target once", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			referrals: [referralEdge("A", "B")],
			roots: ["A", "B"],
		});
		const graph = flattenPersonas(structure);
		expect(new Set(graph.roots)).toEqual(new Set(["A", "B"]));
		expect(graph.personas.has("B")).toBe(true);
	});
});

// Builds a small persona graph with a photo on one persona for the read tests.
function buildGraph(): PersonaGraph {
	const structure = caseStructure({
		personas: [
			personaPayload("A"),
			personaPayload("B"),
			personaPayload("C", {
				profilePhoto: {
					storageId: "kg2test00000000000000001" as Id<"_storage">,
					fileName: "c.png",
					contentType: "image/png",
				},
			}),
			personaPayload("D"),
		],
		referrals: [
			referralEdge("A", "C"),
			referralEdge("B", "C"),
			referralEdge("A", "D"),
		],
		roots: ["A", "B"],
	});
	return flattenPersonas(structure);
}

describe("graphReferrals", () => {
	// Tests that edges are filtered by the persona that authored them.
	it("filters edges by the persona that authored them", () => {
		const graph = buildGraph();
		const referredIds = new Set(graphReferrals(graph, "A").map((e) => e.toId));
		expect(referredIds).toEqual(new Set(["C", "D"]));
	});
});

describe("graphPersonas", () => {
	// Tests that a set of referred ids is resolved to persona details.
	it("resolves a referred-id set (already deduped by the caller) to persona details", () => {
		const graph = buildGraph();
		const personas = graphPersonas(graph, new Set(["C", "D"]));
		expect(personas.map((p) => p.id).sort()).toEqual(["C", "D"]);
	});

	// Tests that the stored persona is returned as is.
	it("returns the stored persona as is", () => {
		const graph = buildGraph();
		expect(graphPersonas(graph, ["C"])[0]!.profilePhoto?.storageId).toBe(
			"kg2test00000000000000001",
		);
	});
});

describe("graphRootPersonas", () => {
	// Tests that full details are returned for every root, in roots order.
	it("returns full details for every root, in roots order", () => {
		const graph = buildGraph();
		expect(graphRootPersonas(graph).map((p) => p.id)).toEqual(graph.roots);
	});
});
