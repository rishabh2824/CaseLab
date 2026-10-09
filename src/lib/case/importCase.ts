import type { Persona, ReferralEdge } from "../types.js";

export class CaseImportError extends Error {}

type FormFieldElement =
	| HTMLInputElement
	| HTMLTextAreaElement
	| HTMLSelectElement;

// Reads the value of the field with the given data-field name, or an empty string if absent.
function fieldValue(root: ParentNode, field: string): string {
	const el = root.querySelector(
		`[data-field="${field}"]`,
	) as FormFieldElement | null;
	return el ? el.value : "";
}

// Parses a numeric field to a rounded number, warning and returning null if it isn't a number.
function parseNumberField(
	text: string,
	label: string,
	warnings: string[],
): number | null {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return null;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		warnings.push(
			`Couldn't read "${label}" as a number (was "${trimmed}") — left blank for you to fill in.`,
		);
		return null;
	}
	return Math.round(parsed);
}

type RawEdge = { fromId: string; toId: string; conditions: string };

type RawCaseGraph = {
	personaOrder: string[];
	personaById: Map<string, Persona>;
	roots: string[];
	edges: RawEdge[];
};

// Reads personas, roots and referral edges from the form DOM, skipping duplicate or broken entries with warnings.
function readCaseGraphFromDom(doc: Document, warnings: string[]): RawCaseGraph {
	const personaOrder: string[] = [];
	const personaById = new Map<string, Persona>();
	const roots: string[] = [];

	for (const card of doc.querySelectorAll(".persona-card[data-persona-id]")) {
		const id = card.getAttribute("data-persona-id");
		if (!id) continue;
		if (personaById.has(id)) {
			warnings.push(
				`Duplicate persona id "${id}" — kept the first one and ignored the rest.`,
			);
			continue;
		}
		const files = Array.from(
			card.querySelectorAll(".files-block .file-row"),
		).map((row) => ({
			file: null,
			shareConditions: fieldValue(row, "share_conditions").trim(),
			perceivedContents: fieldValue(row, "perceived_contents").trim(),
		}));
		personaOrder.push(id);
		personaById.set(id, {
			id,
			name: fieldValue(card, "name").trim(),
			role: fieldValue(card, "role").trim(),
			knownFacts: fieldValue(card, "known_facts").trim(),
			personalityTraits: fieldValue(card, "personality_traits").trim(),
			availabilityMinutes: parseNumberField(
				fieldValue(card, "availability_minutes"),
				`${id} availability`,
				warnings,
			),
			profilePhoto: null,
			files,
		});
		if (card.getAttribute("data-persona-root") === "true") roots.push(id);
	}

	const edges: RawEdge[] = [];
	const seenEdges = new Set<string>();
	for (const row of doc.querySelectorAll(
		'.referral-row[data-referral="true"]',
	)) {
		const fromId = (
			row.querySelector('select[data-role="from"]') as HTMLSelectElement | null
		)?.value;
		const toId = (
			row.querySelector('select[data-role="to"]') as HTMLSelectElement | null
		)?.value;
		const conditions = fieldValue(row, "conditions").trim();
		if (!fromId || !toId) continue;
		if (!personaById.has(fromId) || !personaById.has(toId)) {
			warnings.push(
				`Skipped a referral (${fromId || "?"} → ${toId || "?"}) — one of the personas wasn't found.`,
			);
			continue;
		}
		if (fromId === toId) {
			warnings.push(`Skipped a referral where ${fromId} refers to itself.`);
			continue;
		}
		const edgeKey = JSON.stringify([fromId, toId]);
		if (seenEdges.has(edgeKey)) {
			warnings.push(
				`Skipped a duplicate referral (${fromId} → ${toId}) — kept the first one.`,
			);
			continue;
		}
		seenEdges.add(edgeKey);
		edges.push({ fromId, toId, conditions });
	}

	return { personaOrder, personaById, roots, edges };
}

type FlatGraph = {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

// Walks the graph and keeps every edge that doesn't close a cycle, warning about the ones it drops.
function acceptNonCyclicEdges(
	personaOrder: string[],
	edgesFrom: Map<string, RawEdge[]>,
	warnings: string[],
): RawEdge[] {
	const UNVISITED = 0;
	const IN_PROGRESS = 1;
	const DONE = 2;
	const state = new Map<string, number>(
		personaOrder.map((id) => [id, UNVISITED]),
	);
	const acceptedEdges: RawEdge[] = [];

	const stack: { node: string; edge: number }[] = [];
	for (const startId of personaOrder) {
		if (state.get(startId) !== UNVISITED) continue;
		state.set(startId, IN_PROGRESS);
		stack.push({ node: startId, edge: 0 });

		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const outgoing = edgesFrom.get(frame.node) ?? [];
			if (frame.edge >= outgoing.length) {
				state.set(frame.node, DONE);
				stack.pop();
				continue;
			}
			const edge = outgoing[frame.edge]!;
			frame.edge += 1;
			if (state.get(edge.toId) === IN_PROGRESS) {
				warnings.push(
					`Cycle detected involving ${edge.toId} — that referral was dropped.`,
				);
				continue;
			}
			acceptedEdges.push(edge);
			if (state.get(edge.toId) === UNVISITED) {
				state.set(edge.toId, IN_PROGRESS);
				stack.push({ node: edge.toId, edge: 0 });
			}
		}
	}
	return acceptedEdges;
}

// Drops cyclic edges and personas unreachable from a root, returning the cleaned graph with warnings.
function validateCaseGraph(graph: RawCaseGraph, warnings: string[]): FlatGraph {
	const { personaOrder, personaById, roots, edges } = graph;
	const edgesFrom = Map.groupBy(edges, (edge) => edge.fromId);

	const acceptedEdges = acceptNonCyclicEdges(personaOrder, edgesFrom, warnings);

	const edgesFromAccepted = Map.groupBy(acceptedEdges, (edge) => edge.fromId);
	const reachable = new Set<string>(roots);
	const queue = [...roots];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		for (const edge of edgesFromAccepted.get(id) ?? []) {
			if (!reachable.has(edge.toId)) {
				reachable.add(edge.toId);
				queue.push(edge.toId);
			}
		}
	}

	for (const id of personaOrder) {
		if (!reachable.has(id)) {
			const name = personaById.get(id)?.name;
			warnings.push(
				`${id}${name ? ` (${name})` : ""} isn't connected to any root persona — removed.`,
			);
		}
	}

	return {
		personas: personaOrder
			.filter((id) => reachable.has(id))
			.map((id) => personaById.get(id) as Persona),
		referrals: acceptedEdges
			.filter((edge) => reachable.has(edge.fromId) && reachable.has(edge.toId))
			.map((edge) => ({
				fromId: edge.fromId,
				toId: edge.toId,
				conditions: edge.conditions,
			})),
		roots: roots.filter((id) => reachable.has(id)),
	};
}

// Gives every persona a new UUID and rewrites referrals and roots to match.
function mintFreshPersonaIds(graph: FlatGraph): FlatGraph {
	const idMap = new Map(
		graph.personas.map((persona) => [persona.id, crypto.randomUUID()]),
	);
	return {
		personas: graph.personas.map((persona) => ({
			...persona,
			id: idMap.get(persona.id) as string,
		})),
		referrals: graph.referrals.map((referral) => ({
			...referral,
			fromId: idMap.get(referral.fromId) as string,
			toId: idMap.get(referral.toId) as string,
		})),
		roots: graph.roots.map((id) => idMap.get(id) as string),
	};
}

export type ImportedCaseData = {
	caseName: string;
	accessCode: string;
	simulationDurationMinutes: number | null;
	initialBrief: string;
	commonInformation: string;
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

export type ParsedHTMLForm = {
	data: ImportedCaseData;
	warnings: string[];
};

// Parses an exported case form into case data plus warnings, throwing CaseImportError for unusable files.
export function parseHTMLForm(htmlText: string): ParsedHTMLForm {
	const doc = new DOMParser().parseFromString(htmlText, "text/html");
	if (
		!doc.getElementById("personas-list") ||
		!doc.getElementById("referrals-list")
	) {
		throw new CaseImportError("This doesn't look like a Case Lab import file.");
	}

	const warnings: string[] = [];
	const caseName = fieldValue(doc, "case_name").trim();
	const accessCode = fieldValue(doc, "access_code").trim();
	const initialBrief = fieldValue(doc, "initial_brief").trim();
	const commonInformation = fieldValue(doc, "common_information").trim();
	const simulationDurationMinutes = parseNumberField(
		fieldValue(doc, "simulation_duration_minutes"),
		"Simulation duration",
		warnings,
	);

	const rawGraph = readCaseGraphFromDom(doc, warnings);
	if (rawGraph.personaOrder.length === 0) {
		throw new CaseImportError(
			"No personas found in this file — add at least one before importing.",
		);
	}
	const { personas, referrals, roots } = mintFreshPersonaIds(
		validateCaseGraph(rawGraph, warnings),
	);
	if (roots.length === 0) {
		throw new CaseImportError(
			"This file has no root personas — every persona is referred.",
		);
	}

	return {
		data: {
			caseName,
			accessCode,
			simulationDurationMinutes,
			initialBrief,
			commonInformation,
			personas,
			referrals,
			roots,
		},
		warnings,
	};
}
