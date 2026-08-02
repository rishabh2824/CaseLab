// Imports the autofilled HTML form back into the app
import type { Persona, ReferralEdge } from "../types.js";

export class CaseImportError extends Error {}

type FormFieldElement =
	| HTMLInputElement
	| HTMLTextAreaElement
	| HTMLSelectElement;

function fieldValue(root: ParentNode, field: string): string {
	const el = root.querySelector(
		`[data-field="${field}"]`,
	) as FormFieldElement | null;
	return el ? el.value : "";
}

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

// Plain data, straight off the DOM — one persona/edge per element, before any
// graph-level validation (duplicate ids already resolved, dangling refs
// already dropped, since both need personaById which this pass builds).
type RawCaseGraph = {
	personaOrder: string[];
	personaById: Map<string, Persona>;
	roots: string[];
	edges: RawEdge[];
};

// The one DOM-reading pass: walks every persona card and referral row exactly
// once and builds a plain object. Nothing past this point touches the DOM —
// validateCaseGraph below is pure-data, the same split as the backend's
// CaseStructure/validateGraph.
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
		const canShareFiles =
			fieldValue(card, "can_share_files").trim().toLowerCase() === "yes";
		personaOrder.push(id);
		personaById.set(id, {
			id,
			name: fieldValue(card, "name").trim(),
			role: fieldValue(card, "role").trim(),
			known_facts: fieldValue(card, "known_facts").trim(),
			personality_traits: fieldValue(card, "personality_traits").trim(),
			availability_minutes: parseNumberField(
				fieldValue(card, "availability_minutes"),
				`${id} availability`,
				warnings,
			),
			profile_photo: null,
			files: canShareFiles
				? [{ file: null, share_conditions: "", perceived_contents: "" }]
				: [],
		});
		// data-persona-root is the admin's explicit root/referred choice — kept
		// live-accurate by the exported file's own type-select toggle (see
		// exportCase.ts's inline script). Trusted directly here instead of
		// re-derived from the edge list, which is what used to require the
		// data-fixed-root marker plus a document-order fallback just to stop
		// the one mandatory root from silently losing its root-ness.
		if (card.getAttribute("data-persona-root") === "true") roots.push(id);
	}

	const edges: RawEdge[] = [];
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
		// No "one parent" restriction here — the flat model allows a persona to
		// be referred by more than one other persona.
		edges.push({ fromId, toId, conditions });
	}

	return { personaOrder, personaById, roots, edges };
}

type FlatGraph = {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

// Pure-data validation over the already-built graph. Two separate passes —
// conflating them is a real bug: a cycle entirely disconnected from any root
// still needs walking so its cycle-forming edge gets dropped, but "visited by
// that walk" is not the same thing as "reachable from a root," and treating
// them as one set would silently keep personas nothing ever refers to. No DOM
// access from here on.
function validateCaseGraph(graph: RawCaseGraph, warnings: string[]): FlatGraph {
	const { personaOrder, personaById, roots, edges } = graph;
	const edgesFrom = new Map<string, RawEdge[]>();
	for (const edge of edges) {
		const bucket = edgesFrom.get(edge.fromId) ?? [];
		bucket.push(edge);
		edgesFrom.set(edge.fromId, bucket);
	}

	// Pass 1 — 3-color DFS over every persona (not just roots), so a cycle with
	// no root connection at all still gets caught. Same approach as the
	// backend's validateGraph — correct even with multiple parents into the
	// same persona, unlike a per-path ancestry set, which can miss a cycle only
	// reachable via a persona's second parent.
	const UNVISITED = 0;
	const IN_PROGRESS = 1;
	const DONE = 2;
	const state = new Map<string, number>(
		personaOrder.map((id) => [id, UNVISITED]),
	);
	const acceptedEdges: RawEdge[] = [];

	function visit(id: string): void {
		state.set(id, IN_PROGRESS);
		for (const edge of edgesFrom.get(id) ?? []) {
			if (state.get(edge.toId) === IN_PROGRESS) {
				warnings.push(
					`Cycle detected involving ${edge.toId} — that referral was dropped.`,
				);
				continue;
			}
			acceptedEdges.push(edge);
			if (state.get(edge.toId) === UNVISITED) visit(edge.toId);
		}
		state.set(id, DONE);
	}
	for (const id of personaOrder) if (state.get(id) === UNVISITED) visit(id);

	// Pass 2 — reachability from an explicit root, over the now-cycle-free
	// edge set. This is what actually decides which personas survive: one
	// marked "Referred" with nothing pointing to it, or reachable only through
	// an edge pass 1 just dropped, is unreachable here even though pass 1
	// visited it.
	const edgesFromAccepted = new Map<string, string[]>();
	for (const edge of acceptedEdges) {
		const bucket = edgesFromAccepted.get(edge.fromId) ?? [];
		bucket.push(edge.toId);
		edgesFromAccepted.set(edge.fromId, bucket);
	}
	const reachable = new Set<string>(roots);
	const queue = [...roots];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		for (const nextId of edgesFromAccepted.get(id) ?? []) {
			if (!reachable.has(nextId)) {
				reachable.add(nextId);
				queue.push(nextId);
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
				from_id: edge.fromId,
				to_id: edge.toId,
				conditions: edge.conditions,
			})),
		roots: roots.filter((id) => reachable.has(id)),
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

	// One DOM-reading pass builds the whole graph as plain data; everything
	// after this point is pure validation, no further DOM access.
	const rawGraph = readCaseGraphFromDom(doc, warnings);
	if (rawGraph.personaOrder.length === 0) {
		throw new CaseImportError(
			"No personas found in this file — add at least one before importing.",
		);
	}
	const { personas, referrals, roots } = validateCaseGraph(rawGraph, warnings);
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
