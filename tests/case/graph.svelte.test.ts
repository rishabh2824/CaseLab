// $state in graph.svelte.ts needs the Svelte compiler's client output, which
// only the jsdom-backed "client" project resolves (see vite.config.ts) — same
// reason tests/student/run.svelte.test.ts lives here rather than in "server".
import { describe, expect, it } from "vitest";
import { CaseGraph } from "../../src/lib/case/graph.svelte.js";
import { makePersona, makeReferral } from "../support/fixtures.js";

// p1 (root) -> p2 -> p4
//           -> p3 -> p4
// p4 has two parents (p2 and p3) — the diamond join reachableFrom's own tests
// already cover at the pure-helper level. These exercise the same shape
// through the CaseGraph method PersonaFields.svelte actually calls when a
// referral's remove button is clicked.
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
	it("keeps a diamond-join persona when only one of its two parent referrals is removed", () => {
		const graph = diamondGraph();

		graph.removeReferralsFrom("p2", ["p4"]);

		// p4 is still reachable via p1 -> p3 -> p4, so nothing cascades away.
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

	it("cascade-deletes a persona once its last referral is removed", () => {
		const graph = new CaseGraph();
		graph.load({
			personas: ["p1", "p2", "p4"].map((id) => makePersona({ id })),
			referrals: [makeReferral("p1", "p2"), makeReferral("p2", "p4")],
			roots: ["p1"],
		});

		graph.removeReferralsFrom("p2", ["p4"]);

		// p4 had exactly one parent (p2) -- with that edge gone it's
		// unreachable and must be cascade-removed, along with its own
		// referral edges.
		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
		expect(graph.referrals).toEqual([makeReferral("p1", "p2")]);
	});

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

		// p5 is only reachable through p4, which is itself now unreachable.
		expect(graph.personas.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
		expect(graph.referrals).toEqual([makeReferral("p1", "p2")]);
	});

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

	it("is a no-op when the persona has no referral to the given target", () => {
		const graph = diamondGraph();
		const before = { personas: graph.personas, referrals: graph.referrals };

		graph.removeReferralsFrom("p3", ["p2"]); // p3 never referred p2

		expect(graph.personas).toEqual(before.personas);
		expect(graph.referrals).toEqual(before.referrals);
	});
});

describe("CaseGraph.removeReferral", () => {
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
