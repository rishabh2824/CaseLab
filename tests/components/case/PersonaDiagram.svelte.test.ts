import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import type { CaseIssue } from "#shared/rules.js";
import { personaPath, referralPath } from "#shared/rules.js";
import { CaseGraph } from "../../../src/lib/case/graph.svelte.js";
import PersonaDiagram from "../../../src/lib/components/case/PersonaDiagram.svelte";
import { makePersona, makeReferral } from "../../support/factories.js";
import {
	clickArrow,
	diagramNode,
	diagramNodeCount,
	dragArrow,
} from "./caseForm/support.js";

const arrowCount = () => document.querySelectorAll(".svelte-flow__edge").length;
const arrow = (fromId: string, toId: string) =>
	document.querySelector(`.svelte-flow__edge[data-id="${fromId}->${toId}"]`);

// A graph where Mary, the starting persona, refers to both Bob and Cy.
function sampleGraph() {
	const graph = new CaseGraph();
	graph.load({
		personas: [
			makePersona({ id: "a", name: "Mary", role: "CFO" }),
			makePersona({ id: "b", name: "Bob", role: "Analyst" }),
			makePersona({ id: "c", name: "Cy", role: "Legal" }),
		],
		referrals: [
			makeReferral("a", "b", "asked"),
			makeReferral("a", "c", "asked"),
		],
	});
	return graph;
}

// Draws the diagram for a graph and waits for its personas to appear.
async function renderDiagram(
	graph: CaseGraph,
	props: {
		selectedId?: string;
		issues?: CaseIssue[];
		disabled?: boolean;
	} = {},
) {
	const onSelect = vi.fn();
	const onSelectReferral = vi.fn();
	await render(PersonaDiagram, {
		graph,
		selectedId: props.selectedId,
		issues: props.issues ?? [],
		disabled: props.disabled ?? false,
		onSelect,
		onSelectReferral,
	});
	await expect.poll(diagramNodeCount).toBe(graph.personas.length);
	await expect.poll(arrowCount).toBe(graph.referrals.length);
	return { onSelect, onSelectReferral };
}

describe("what the diagram draws", () => {
	// Tests that every persona and every referral gets its own box or arrow.
	it("draws a box per persona and an arrow per referral", async () => {
		await renderDiagram(sampleGraph());

		expect(diagramNodeCount()).toBe(3);
		expect(arrowCount()).toBe(2);
		expect(arrow("a", "b")).not.toBeNull();
		expect(arrow("a", "c")).not.toBeNull();
	});

	// Tests that a box shows the persona's name and role, with a stand-in for a blank one.
	it("shows each persona's name and role, with stand-ins for blanks", async () => {
		const graph = sampleGraph();
		graph.personas.push(makePersona({ id: "d", name: "  ", role: "" }));
		graph.referrals.push(makeReferral("a", "d", "asked"));
		await renderDiagram(graph);

		await expect.element(diagramNode("Mary")).toBeVisible();
		await expect.element(page.getByText("CFO", { exact: true })).toBeVisible();
		await expect.element(diagramNode("Unnamed persona")).toBeVisible();
		await expect
			.element(page.getByText("Referred persona", { exact: true }))
			.toBeVisible();
	});

	// Tests that a starting persona gets a filled badge and a referred persona a plain one.
	it("marks starting personas apart from referred ones", async () => {
		await renderDiagram(sampleGraph());

		const badge = (id: string) =>
			document.querySelector(
				`.svelte-flow__node[data-id="${id}"] [aria-hidden="true"]`,
			);
		expect(badge("a")?.className).toContain("bg-brand");
		expect(badge("b")?.className).not.toContain("bg-brand");
		expect(badge("c")?.className).not.toContain("bg-brand");
		// Starting personas take no referrals, so only the referred one has an incoming dot.
		const targets = (id: string) =>
			document.querySelectorAll(
				`.svelte-flow__node[data-id="${id}"] .svelte-flow__handle.target`,
			).length;
		expect(targets("a")).toBe(0);
		expect(targets("b")).toBe(1);
	});

	// Tests that the open persona is outlined.
	it("outlines the selected persona", async () => {
		await renderDiagram(sampleGraph(), { selectedId: "b" });

		const card = (id: string) =>
			document.querySelector(`.svelte-flow__node[data-id="${id}"] .rounded-xl`);
		expect(card("b")?.className).toContain("ring-4");
		expect(card("a")?.className).not.toContain("ring-4");
	});

	// Tests that a persona with a problem shows a marker, and that a referral with no condition is dashed.
	it("flags personas and referrals that need attention", async () => {
		const graph = sampleGraph();
		graph.referrals[0]!.conditions = "";
		const issues: CaseIssue[] = [
			{ path: personaPath("b", "knownFacts"), message: "Add instructions." },
			{ path: referralPath("a", "b"), message: "Add a condition." },
		];
		await renderDiagram(graph, { issues });

		expect(
			document.querySelector(
				'.svelte-flow__node[data-id="b"] [title="Needs attention"]',
			),
		).not.toBeNull();
		expect(
			document.querySelector(
				'.svelte-flow__node[data-id="a"] [title="Needs attention"]',
			),
		).toBeNull();
		const line = arrow("a", "b")?.querySelector(".svelte-flow__edge-path");
		expect(getComputedStyle(line as Element).strokeDasharray).not.toBe("none");
	});

	// Tests that the diagram follows the graph as personas and referrals are added.
	it("redraws when the graph changes", async () => {
		const graph = sampleGraph();
		await renderDiagram(graph);

		graph.addReferral("c");

		await expect.poll(diagramNodeCount).toBe(4);
		await expect.poll(arrowCount).toBe(3);
	});
});

describe("clicking the diagram", () => {
	// Tests that clicking a box reports which persona it is.
	it("selects a persona when its box is clicked", async () => {
		const { onSelect, onSelectReferral } = await renderDiagram(sampleGraph());

		await diagramNode("Bob").click();

		expect(onSelect).toHaveBeenCalledWith("b");
		expect(onSelectReferral).not.toHaveBeenCalled();
	});

	// Tests that clicking an arrow reports the referral it draws.
	it("selects a referral when its arrow is clicked", async () => {
		const { onSelect, onSelectReferral } = await renderDiagram(sampleGraph());

		clickArrow("a", "b");

		expect(onSelectReferral).toHaveBeenCalledWith("a", "b");
		expect(onSelect).not.toHaveBeenCalled();
	});
});

describe("dragging an arrow to refer one persona to another", () => {
	// Tests that dropping on the middle of a box makes the referral.
	it("adds a referral when an arrow is dropped on another persona", async () => {
		const graph = sampleGraph();
		await renderDiagram(graph);

		await dragArrow("b", "c");

		await expect.poll(arrowCount).toBe(3);
		expect(graph.referrals.map((r) => `${r.fromId}>${r.toId}`)).toEqual([
			"a>b",
			"a>c",
			"b>c",
		]);
	});

	// Tests that the whole box is a drop target, not just its small dot.
	it.each([
		["near its left edge", 0.1],
		["in its middle", 0.5],
		["near its right edge", 0.9],
	])("accepts a drop %s", async (_where, across) => {
		const graph = sampleGraph();
		await renderDiagram(graph);

		await dragArrow("b", "c", { across });

		await expect.poll(() => graph.referrals.length).toBe(3);
	});

	// Tests that a starting persona cannot be the target of a referral.
	it("refuses a referral to a starting persona", async () => {
		const graph = sampleGraph();
		await renderDiagram(graph);

		await dragArrow("b", "a");
		await dragArrow("b", "c");

		// Only the second, valid, drop added an arrow.
		await expect.poll(arrowCount).toBe(3);
		expect(graph.referrals.map((r) => `${r.fromId}>${r.toId}`)).toEqual([
			"a>b",
			"a>c",
			"b>c",
		]);
	});

	// Tests that a referral cannot be added twice or close a loop.
	it("refuses a duplicate referral and a loop", async () => {
		const graph = sampleGraph();
		await renderDiagram(graph);
		await dragArrow("b", "c");
		await expect.poll(arrowCount).toBe(3);

		// Bob already refers to Cy; Cy referring back to Bob would close a loop.
		await dragArrow("b", "c");
		await dragArrow("c", "b");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(graph.referrals).toHaveLength(3);
	});

	// Tests that a locked diagram, such as a view-only case, cannot be connected.
	it("cannot add a referral when the form is locked", async () => {
		const graph = sampleGraph();
		await renderDiagram(graph, { disabled: true });

		await dragArrow("b", "c");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(graph.referrals).toHaveLength(2);
	});
});
