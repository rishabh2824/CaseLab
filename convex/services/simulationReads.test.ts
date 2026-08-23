import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { caseStructure, personaPayload, referralEdge } from "../testFactories";
import type { PersonaGraph } from "./simulationReads";
import {
	flattenPersonas,
	graphPersonaById,
	graphPersonas,
	graphReferrals,
	graphRootPersonas,
} from "./simulationReads";

describe("flattenPersonas", () => {
	it("carries persona secrets through and renames availability_minutes to availabilityDuration", () => {
		const structure = caseStructure({
			personas: [
				personaPayload("A", {
					name: "Mary",
					role: "CFO",
					known_facts: "secret facts",
					personality_traits: "calm",
					availability_minutes: 30,
				}),
			],
		});
		const graph = flattenPersonas(structure);
		const mary = graph.personas.get("A")!;
		expect(mary.knownFacts).toBe("secret facts");
		expect(mary.personalityTraits).toBe("calm");
		expect(mary.availabilityDuration).toBe(30);
		expect(mary.isReferred).toBe(false);
	});

	it("marks a persona as referred only when it isn't a root", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			referrals: [referralEdge("A", "B")],
			roots: ["A"],
		});
		const graph = flattenPersonas(structure);
		expect(graph.personas.get("B")!.isReferred).toBe(true);
	});

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

	it("turns every referral into an edge, with a null condition becoming an empty string", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			referrals: [referralEdge("A", "B", null)],
		});
		const graph = flattenPersonas(structure);
		expect(graph.referrals).toHaveLength(1);
		expect(graph.referrals[0]).toEqual({
			parentPersonaId: "A",
			referredPersonaId: "B",
			conditionTrigger: "",
		});
	});

	it("stores a persona referred by two parents once, not once per edge", () => {
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B"), personaPayload("C")],
			referrals: [referralEdge("A", "C"), referralEdge("B", "C")],
			roots: ["A", "B"],
		});
		const graph = flattenPersonas(structure);
		const targets = new Set(
			graph.referrals.map(
				(e) => `${e.parentPersonaId}->${e.referredPersonaId}`,
			),
		);
		expect(targets).toEqual(new Set(["A->C", "B->C"]));
		expect(graph.personas.size).toBe(3);
	});

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

function buildGraph(): PersonaGraph {
	const structure = caseStructure({
		personas: [
			personaPayload("A"),
			personaPayload("B"),
			personaPayload("C", {
				profile_photo: {
					storage_id: "kg2test00000000000000001" as Id<"_storage">,
					file_name: "c.png",
					content_type: "image/png",
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
	it("filters edges by parent, returning raw (unhydrated) personas", () => {
		const graph = buildGraph();
		const referredIds = new Set(
			graphReferrals(graph, "A").map((e) => e.referredPersonaId),
		);
		expect(referredIds).toEqual(new Set(["C", "D"]));

		const c = graphPersonaById(graph, "C")!;
		expect(c.profilePhotoUrl).toBeNull();
		expect(c.profilePhoto?.storage_id).toBe("kg2test00000000000000001");
	});
});

describe("graphPersonas", () => {
	it("resolves a referred-id set (already deduped by the caller) to persona details", () => {
		const graph = buildGraph();
		// C is referred by two different parents (A and B, see buildGraph) but the graph
		// stores it once -- a Set of referred ids naturally has no duplicate to begin with.
		const personas = graphPersonas(graph, new Set(["C", "D"]));
		expect(personas.map((p) => p.id).sort()).toEqual(["C", "D"]);
	});

	it("returns raw, unhydrated personas", () => {
		const graph = buildGraph();
		expect(graphPersonas(graph, ["C"])[0]!.profilePhotoUrl).toBeNull();
	});
});

describe("graphPersonaById", () => {
	it("finds a root persona", () => {
		const graph = flattenPersonas(caseStructure());
		expect(graphPersonaById(graph, "A")?.id).toBe("A");
	});

	it("finds a referred persona", () => {
		const graph = flattenPersonas(
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [referralEdge("A", "B")],
			}),
		);
		expect(graphPersonaById(graph, "B")?.id).toBe("B");
	});

	it("returns undefined for an unknown id", () => {
		const graph = flattenPersonas(caseStructure());
		expect(graphPersonaById(graph, "nope")).toBeUndefined();
	});
});

describe("graphRootPersonas", () => {
	it("returns full details for every root, in roots order", () => {
		const graph = buildGraph();
		expect(graphRootPersonas(graph).map((p) => p.id)).toEqual(graph.roots);
	});
});
