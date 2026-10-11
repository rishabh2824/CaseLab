import { describe, expect, it } from "vitest";
import {
	reachableFrom,
	splitCyclicEdges,
	validateStructure,
} from "./caseGraph";

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

describe("reachableFrom", () => {
	const referrals = [edge("p1", "p2"), edge("p2", "p3")];

	// Tests that a linear chain is followed to its end.
	it("follows a linear chain to its end", () => {
		expect(reachableFrom(["p1"], referrals)).toEqual(
			new Set(["p1", "p2", "p3"]),
		);
	});

	// Tests that a diamond node is reachable from either parent alone.
	it.each([["p2"], ["p3"]])(
		"reaches a diamond node when starting from only %s",
		(start) => {
			const diamond = [edge("p2", "p4"), edge("p3", "p4")];
			expect(reachableFrom([start!], diamond)).toEqual(new Set([start, "p4"]));
		},
	);

	// Tests that a cycle does not make the walk loop forever.
	it("terminates on a cycle instead of looping forever", () => {
		const cycle = [edge("p1", "p2"), edge("p2", "p3"), edge("p3", "p1")];
		expect(reachableFrom(["p1"], cycle)).toEqual(new Set(["p1", "p2", "p3"]));
	});

	// Tests that no start ids reach nothing, and an unknown start id reaches only itself.
	it("returns an empty set for no start ids, and just the id for an unknown one", () => {
		expect(reachableFrom([], referrals)).toEqual(new Set());
		expect(reachableFrom(["ghost"], referrals)).toEqual(new Set(["ghost"]));
	});
});

describe("validateStructure", () => {
	const persona = (id: string, name = id) => ({ id, name });

	// Tests that a sound graph, including a persona with two parents, has no problem.
	it("accepts a sound graph, including a persona referred by two parents", () => {
		expect(
			validateStructure({
				personas: [persona("A"), persona("B"), persona("C")],
				referrals: [edge("A", "C"), edge("B", "C")],
				roots: ["A", "B"],
			}),
		).toBeNull();
	});

	// Tests that each rule reports its own problem.
	it.each([
		["no personas", [], [], [], /at least one persona/],
		["no roots", [persona("A")], [], [], /at least one root/],
		[
			"duplicate persona ids",
			[persona("A"), persona("A")],
			[],
			["A"],
			/Duplicate persona id/,
		],
		["an unknown root", [persona("A")], [], ["A", "X"], /Unknown root/],
		["a duplicate root", [persona("A")], [], ["A", "A"], /Duplicate root/],
		[
			"an unknown referral source",
			[persona("A")],
			[edge("X", "A")],
			["A"],
			/Unknown referral fromId/,
		],
		[
			"an unknown referral target",
			[persona("A")],
			[edge("A", "X")],
			["A"],
			/Unknown referral toId/,
		],
		[
			"a duplicate referral",
			[persona("A"), persona("B")],
			[edge("A", "B"), edge("A", "B")],
			["A"],
			/Duplicate referral/,
		],
		[
			"a cycle",
			[persona("A"), persona("B")],
			[edge("A", "B"), edge("B", "A")],
			["A"],
			/cycle/i,
		],
		["a self-referral", [persona("A")], [edge("A", "A")], ["A"], /cycle/i],
	] as const)("reports %s", (_label, personas, referrals, roots, expected) => {
		expect(
			validateStructure({
				personas: [...personas],
				referrals: [...referrals],
				roots: [...roots],
			}),
		).toMatch(expected);
	});

	// Tests that an unreachable persona is named in the problem.
	it("names a persona that no root can reach", () => {
		expect(
			validateStructure({
				personas: [persona("A"), persona("B", "Orphan")],
				referrals: [],
				roots: ["A"],
			}),
		).toMatch(/B \(Orphan\) isn't connected/);
	});
});
