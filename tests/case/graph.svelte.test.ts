import { describe, expect, it } from "vitest";
import { CaseGraph } from "../../src/lib/case/graph.svelte.js";
import { makePersona, makeReferral } from "../support/fixtures.js";

// Builds a graph where one persona is referred by two parents, forming a diamond.
function diamondGraph(): CaseGraph {
	const graph = new CaseGraph();
	graph.load({
		personas: ["p1", "p2", "p3", "p4"].map((id) => makePersona({ id })),
		referrals: [
			makeReferral("p1", "p2"),
			makeReferral("p1", "p3"),
			makeReferral("p2", "p4"),
			makeReferral("p3", "p4"),
		],
		roots: ["p1"],
	});
	return graph;
}

describe("CaseGraph.removeReferralsFrom", () => {
	// Tests that a diamond-join persona survives when only one of its two parent referrals is removed.
	it("keeps a diamond-join persona when only one of its two parent referrals is removed", () => {
		const graph = diamondGraph();

		graph.removeReferralsFrom("p2", ["p4"]);

		expect(graph.personas.map((p) => p.id).sort()).toEqual([
			"p1",
			"p2",
			"p3",
			"p4",
		]);
		expect(graph.referrals).toEqual([
			makeReferral("p1", "p2"),
			makeReferral("p1", "p3"),
			makeReferral("p3", "p4"),
		]);
	});

	// Tests that a persona is deleted once its last incoming referral is removed.
	it("cascade-deletes a persona once its last referral is removed", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["p1", "p2", "p4"].map((id) => makePersona({ id })),
			referrals: [makeReferral("p1", "p2"), makeReferral("p2", "p4")],
			roots: ["p1"],
		});

		graph.removeReferralsFrom("p2", ["p4"]);

		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
		expect(graph.referrals).toEqual([makeReferral("p1", "p2")]);
	});

	// Tests that removing a referral deletes the whole subtree that becomes unreachable.
	it("cascade-deletes a whole now-unreachable subtree, not just the direct target", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["p1", "p2", "p4", "p5"].map((id) => makePersona({ id })),
			referrals: [
				makeReferral("p1", "p2"),
				makeReferral("p2", "p4"),
				makeReferral("p4", "p5"),
			],
			roots: ["p1"],
		});

		graph.removeReferralsFrom("p2", ["p4"]);

		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
		expect(graph.referrals).toEqual([makeReferral("p1", "p2")]);
	});

	// Tests that only the named referral edges are removed, leaving the persona's other referrals.
	it("only removes the (personaId, targetId) edges named, leaving that persona's other referrals intact", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["p1", "p2", "p3"].map((id) => makePersona({ id })),
			referrals: [makeReferral("p1", "p2"), makeReferral("p1", "p3")],
			roots: ["p1"],
		});

		graph.removeReferralsFrom("p1", ["p2"]);

		expect(graph.referrals).toEqual([makeReferral("p1", "p3")]);
		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p3"]);
	});

	// Tests that removing a nonexistent referral leaves the graph unchanged.
	it("is a no-op when the persona has no referral to the given target", () => {
		const graph = diamondGraph();
		const before = { personas: graph.personas, referrals: graph.referrals };

		graph.removeReferralsFrom("p3", ["p2"]);

		expect(graph.personas).toEqual(before.personas);
		expect(graph.referrals).toEqual(before.referrals);
	});
});

describe("CaseGraph.removeReferral", () => {
	// Tests that removeReferral removes a single edge with the same cascade as removeReferralsFrom.
	it("delegates to removeReferralsFrom for a single edge", () => {
		const graph = diamondGraph();

		graph.removeReferral(makeReferral("p2", "p4"));

		expect(graph.personas.map((p) => p.id).sort()).toEqual([
			"p1",
			"p2",
			"p3",
			"p4",
		]);
		expect(graph.referrals).toEqual([
			makeReferral("p1", "p2"),
			makeReferral("p1", "p3"),
			makeReferral("p3", "p4"),
		]);
	});
});
