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
		// Files carry no id of their own in the exported form (see exportCase.ts's
		// fileRowMarkup) — each `.file-row` becomes one placeholder entry, in DOM
		// order, with `file: null`. The admin attaches the real attachment to each
		// slot in-app after import; matching them up is on them, by position.
		const files = Array.from(
			card.querySelectorAll(".files-block .file-row"),
		).map((row) => ({
			file: null,
			share_conditions: fieldValue(row, "share_conditions").trim(),
			perceived_contents: fieldValue(row, "perceived_contents").trim(),
		}));
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
			files,
		});
		// data-persona-root is the admin's explicit root/referred choice — kept
		// live-accurate by the exported file's own type-select toggle (see
		// exportCase.ts's inline script). Trusted directly here instead of
		// re-derived from the edge list, so the one mandatory root can't
		// silently lose its root-ness.
		if (card.getAttribute("data-persona-root") === "true") roots.push(id);
	}

	const edges: RawEdge[] = [];
	// Same (from, to) pair seen twice — a hand-edited export can produce this even though the
	// exported form's own selects never duplicate a referral row on their own. Tracked as a
	// per-pair Set, not just personaById, since the flat model still allows a persona to be
	// referred by more than one *other* persona — only an exact repeat of the same edge is
	// rejected.
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

// Pass 1 of validateCaseGraph below, split out as its own function purely for
// readability. 3-color DFS over every persona (not just roots), so a cycle with no root
// connection at all still gets caught. Same approach as the backend's validateGraph —
// correct even with multiple parents into the same persona, unlike a per-path ancestry
// set, which can miss a cycle only reachable via a persona's second parent.
//
// Iterative, not recursive: mirrors the backend's own iterative three-colour DFS
// (services/cases.ts's validateGraph) for the same reason — a long referral chain is a
// perfectly legal shape for a real import to produce, and recursing once per node risks
// blowing the call stack on a large file. The explicit stack holds (node,
// next-edge-index) so a node is only marked DONE once every one of its outgoing edges has
// been walked, exactly as the recursive version (still visible in git history) did on
// return.
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

// Pure-data validation over the already-built graph. Two separate passes —
// conflating them is a real bug: a cycle entirely disconnected from any root
// still needs walking so its cycle-forming edge gets dropped, but "visited by
// that walk" is not the same thing as "reachable from a root," and treating
// them as one set would silently keep personas nothing ever refers to. No DOM
// access from here on.
function validateCaseGraph(graph: RawCaseGraph, warnings: string[]): FlatGraph {
	const { personaOrder, personaById, roots, edges } = graph;
	const edgesFrom = Map.groupBy(edges, (edge) => edge.fromId);

	// Pass 1 (see acceptNonCyclicEdges above).
	const acceptedEdges = acceptNonCyclicEdges(personaOrder, edgesFrom, warnings);

	// Pass 2 — reachability from an explicit root, over the now-cycle-free
	// edge set. This is what actually decides which personas survive: one
	// marked "Referred" with nothing pointing to it, or reachable only through
	// an edge pass 1 just dropped, is unreachable here even though pass 1
	// visited it.
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
				from_id: edge.fromId,
				to_id: edge.toId,
				conditions: edge.conditions,
			})),
		roots: roots.filter((id) => reachable.has(id)),
	};
}

// The exported HTML's `data-persona-id` attribute exists only so this file's own referral
// <select>s and root toggles can point at "this card" while an admin (or an LLM) fills in
// the visible fields around it -- an admin never sees or needs to type the value itself.
// Left alone, it's also the original persona's real id, carried over unedited by a normal
// export/re-import round trip. But it's untrusted input once it reaches here (see
// validatePersonaId's comment in services/cases.ts): a hand-edited attribute containing a
// character outside printable ASCII, or a leading "$", saves fine client-side and then fails
// at the server with "Invalid persona id" -- a failure this form has no way to preempt.
// Minting a fresh id per persona removes that failure mode entirely, and is also more honest
// about what an import produces: a brand-new case with its own new personas, not a
// resurrection of the source file's exact identities.
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
			from_id: idMap.get(referral.from_id) as string,
			to_id: idMap.get(referral.to_id) as string,
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
