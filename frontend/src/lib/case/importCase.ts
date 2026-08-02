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

type ParsedPersonaCards = {
	personaOrder: string[];
	personaById: Map<string, Persona>;
	// Whichever card was exported with data-fixed-root="true" — the case's one
	// mandatory, un-removable root. Falls back to the first card encountered
	// for a hand-authored file that predates this marker.
	fixedRootId: string | null;
};

function parsePersonaCards(
	doc: Document,
	warnings: string[],
): ParsedPersonaCards {
	const cards = Array.from(
		doc.querySelectorAll(".persona-card[data-persona-id]"),
	);
	const personaOrder: string[] = [];
	const personaById = new Map<string, Persona>();
	let fixedRootId: string | null = null;

	for (const card of cards) {
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
		if (
			fixedRootId === null &&
			card.getAttribute("data-fixed-root") === "true"
		) {
			fixedRootId = id;
		}
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
	}
	if (fixedRootId === null) fixedRootId = personaOrder[0] ?? null;
	return { personaOrder, personaById, fixedRootId };
}

type ParsedEdge = { fromId: string; toId: string; conditions: string };

function parseReferralEdges(
	doc: Document,
	personaById: Map<string, Persona>,
	fixedRootId: string | null,
	warnings: string[],
): ParsedEdge[] {
	const rows = Array.from(
		doc.querySelectorAll('.referral-row[data-referral="true"]'),
	);
	const edges: ParsedEdge[] = [];

	for (const row of rows) {
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

	if (fixedRootId && personaById.has(fixedRootId)) {
		const before = edges.length;
		const kept = edges.filter((edge) => edge.toId !== fixedRootId);
		if (kept.length < before) {
			warnings.push(
				`${fixedRootId} is always a root persona — removed the referral(s) pointing to it.`,
			);
		}
		return kept;
	}
	return edges;
}

type FlatGraph = {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

// Validates the parsed edges (cycle detection, unreachable-persona warnings —
// still necessary; a flat edge list can encode a cycle just as easily as
// nested objects could) and returns the flat graph directly — no tree to
// assemble under the flat model.
function validateAndFlattenGraph(
	personaOrder: string[],
	personaById: Map<string, Persona>,
	edges: ParsedEdge[],
	warnings: string[],
): FlatGraph {
	const edgesFrom = new Map<string, ParsedEdge[]>();
	for (const edge of edges) {
		const bucket = edgesFrom.get(edge.fromId) ?? [];
		bucket.push(edge);
		edgesFrom.set(edge.fromId, bucket);
	}
	const referredIds = new Set(edges.map((edge) => edge.toId));
	const rootIds = personaOrder.filter((id) => !referredIds.has(id));

	// 3-color DFS cycle detection (same approach as the backend's
	// validateGraph) — correct even with multiple parents into the same
	// persona, unlike a per-path ancestry set, which can miss a cycle only
	// reachable via a persona's second parent.
	const UNVISITED = 0;
	const IN_PROGRESS = 1;
	const DONE = 2;
	const state = new Map<string, number>(
		personaOrder.map((id) => [id, UNVISITED]),
	);
	const acceptedEdges: ParsedEdge[] = [];
	const reachable = new Set<string>();

	function visit(id: string): void {
		state.set(id, IN_PROGRESS);
		reachable.add(id);
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
	for (const id of rootIds) visit(id);

	for (const id of personaOrder) {
		if (!reachable.has(id)) {
			const name = personaById.get(id)?.name;
			warnings.push(
				`${id}${name ? ` (${name})` : ""} couldn't be placed — it's only reachable through a referral cycle.`,
			);
		}
	}

	return {
		personas: personaOrder
			.filter((id) => reachable.has(id))
			.map((id) => personaById.get(id) as Persona),
		referrals: acceptedEdges.map((edge) => ({
			from_id: edge.fromId,
			to_id: edge.toId,
			conditions: edge.conditions,
		})),
		roots: rootIds,
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

	const { personaOrder, personaById, fixedRootId } = parsePersonaCards(
		doc,
		warnings,
	);
	if (personaOrder.length === 0) {
		throw new CaseImportError(
			"No personas found in this file — add at least one before importing.",
		);
	}
	const edges = parseReferralEdges(doc, personaById, fixedRootId, warnings);
	const { personas, referrals, roots } = validateAndFlattenGraph(
		personaOrder,
		personaById,
		edges,
		warnings,
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
