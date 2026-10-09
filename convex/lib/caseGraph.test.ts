import { describe, expect, it } from "vitest";
import { splitCyclicEdges } from "./caseGraph";

const edge = (fromId: string, toId: string) => ({ fromId, toId });
const pairs = (edges: { fromId: string; toId: string }[]) =>
	edges.map((e) => `${e.fromId}>${e.toId}`);

describe("splitCyclicEdges", () => {
	// Tests that a graph without cycles keeps every edge and drops none.
	it("keeps every edge of an acyclic graph", () => {
		const { accepted, dropped } = splitCyclicEdges(
			["A", "B", "C"],
			[edge("A", "B"), edge("B", "C")],
		);
		expect(pairs(accepted)).toEqual(["A>B", "B>C"]);
		expect(dropped).toEqual([]);
	});

	// Tests that the edge closing a cycle is the one dropped.
	it("drops the edge that closes a cycle", () => {
		const { accepted, dropped } = splitCyclicEdges(
			["A", "B", "C"],
			[edge("A", "B"), edge("B", "C"), edge("C", "A")],
		);
		expect(pairs(accepted)).toEqual(["A>B", "B>C"]);
		expect(pairs(dropped)).toEqual(["C>A"]);
	});

	// Tests that a persona referring to itself counts as a cycle.
	it("drops a self-referral", () => {
		const { dropped } = splitCyclicEdges(["A"], [edge("A", "A")]);
		expect(pairs(dropped)).toEqual(["A>A"]);
	});

	// Tests that two parents referring to the same persona is not a cycle.
	it("keeps both edges of a diamond", () => {
		const { accepted, dropped } = splitCyclicEdges(
			["A", "B", "C", "D"],
			[edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")],
		);
		expect(accepted).toHaveLength(4);
		expect(dropped).toEqual([]);
	});

	// Tests that the first dropped edge is the first back edge met, so callers can name it in an error.
	it("reports dropped edges in the order the walk meets them", () => {
		const { dropped } = splitCyclicEdges(
			["A", "B", "C"],
			[edge("A", "B"), edge("B", "A"), edge("B", "C"), edge("C", "B")],
		);
		expect(pairs(dropped)).toEqual(["B>A", "C>B"]);
	});

	// Tests that extra fields on edges are carried through untouched.
	it("returns the original edge objects", () => {
		const withData = { fromId: "A", toId: "B", conditions: "if asked" };
		const { accepted } = splitCyclicEdges(["A", "B"], [withData]);
		expect(accepted[0]).toBe(withData);
	});
});
