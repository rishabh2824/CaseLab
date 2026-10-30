import { describe, expect, it } from "vitest";
import { CaseGraph } from "../../src/lib/case/graph.svelte.js";
import { makePersona, makeReferral } from "../support/factories.js";

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
	});
	return graph;
}

describe("CaseGraph.removePersona", () => {
	// Tests that a diamond-join persona survives when one of its two parents is removed.
	it("keeps a persona that is still reachable through another parent", () => {
		const graph = diamondGraph();

		graph.removePersona("p2");

		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p3", "p4"]);
		expect(graph.referrals).toEqual([
			makeReferral("p1", "p3"),
			makeReferral("p3", "p4"),
		]);
	});

	// Tests that removing a referred persona also removes the subtree only reachable through it.
	it("cascade-deletes everything reachable only through the removed persona", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["p1", "p2", "p4", "p5"].map((id) => makePersona({ id })),
			referrals: [
				makeReferral("p1", "p2"),
				makeReferral("p2", "p4"),
				makeReferral("p4", "p5"),
			],
		});

		graph.removePersona("p4");

		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
		expect(graph.referrals).toEqual([makeReferral("p1", "p2")]);
	});

	// Tests that removing a root drops it from roots along with its subtree, leaving other roots alone.
	it("removes a root and its subtree, keeping the other roots", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["r1", "r2", "c1"].map((id) => makePersona({ id })),
			referrals: [makeReferral("r1", "c1")],
		});

		graph.removePersona("r1");

		expect(graph.roots).toEqual(["r2"]);
		expect(graph.personas.map((p) => p.id)).toEqual(["r2"]);
		expect(graph.referrals).toEqual([]);
	});
});

describe("CaseGraph.removalSet", () => {
	// Tests that the removal set names the persona and only the personas left unreachable.
	it("lists the persona and what only it leads to", () => {
		const graph = diamondGraph();

		expect([...graph.removalSet("p2")]).toEqual(["p2"]);
		expect([...graph.removalSet("p1")].sort()).toEqual([
			"p1",
			"p2",
			"p3",
			"p4",
		]);
	});
});

describe("CaseGraph.link", () => {
	// Tests that a referral between existing personas is added once.
	it("adds a referral between two existing personas, once", () => {
		const graph = diamondGraph();

		graph.link("p2", "p3");
		graph.link("p2", "p3");

		expect(
			graph.referrals.filter((r) => r.fromId === "p2" && r.toId === "p3"),
		).toHaveLength(1);
	});

	// Tests that links into a starting persona, onto itself or closing a loop are refused.
	it("refuses links into a starting persona, to itself, or that close a loop", () => {
		const graph = diamondGraph();

		expect(graph.canLink("p2", "p1")).toBe(false);
		expect(graph.canLink("p2", "p2")).toBe(false);
		expect(graph.canLink("p4", "p2")).toBe(false);
		graph.link("p4", "p2");
		expect(graph.referrals).toHaveLength(4);
	});
});

describe("CaseGraph.unlink", () => {
	// Tests that removing one of two referrals into a persona keeps the persona.
	it("keeps a persona still reachable through another referral", () => {
		const graph = diamondGraph();

		graph.unlink("p2", "p4");

		expect(graph.personas).toHaveLength(4);
		expect(graph.referrals).toHaveLength(3);
	});

	// Tests that removing the only referral into a persona removes it and its branch.
	it("removes a persona left unreachable, with everything only it refers to", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["p1", "p2", "p3"].map((id) => makePersona({ id })),
			referrals: [makeReferral("p1", "p2"), makeReferral("p2", "p3")],
		});

		graph.unlink("p1", "p2");

		expect(graph.personas.map((p) => p.id)).toEqual(["p1"]);
		expect(graph.referrals).toEqual([]);
	});
});
