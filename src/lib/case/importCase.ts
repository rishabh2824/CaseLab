import { splitCyclicEdges } from "../../../convex/lib/caseGraph.js";
import type { Persona, ReferralEdge } from "../types.js";
import { reachableFrom } from "./draft.js";

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

// Parses a numeric field to a rounded number, or null if blank; throws if it isn't a number.
function parseNumberField(text: string, label: string): number | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		throw new CaseImportError(
			`Couldn't read "${label}" as a number (was "${trimmed}").`,
		);
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

// Reads personas, roots and referral edges from the form DOM, throwing on duplicate or broken entries.
function readCaseGraphFromDom(doc: Document): RawCaseGraph {
	const personaOrder: string[] = [];
	const personaById = new Map<string, Persona>();
	const roots: string[] = [];

	for (const card of doc.querySelectorAll(".persona-card[data-persona-id]")) {
		const id = card.getAttribute("data-persona-id");
		if (!id) continue;
		if (personaById.has(id)) {
			throw new CaseImportError(`Duplicate persona id "${id}".`);
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
			throw new CaseImportError(
				`A referral (${fromId} → ${toId}) points at a persona that isn't in the file.`,
			);
		}
		if (fromId === toId) {
			throw new CaseImportError(`Persona ${fromId} refers to itself.`);
		}
		const edgeKey = JSON.stringify([fromId, toId]);
		if (seenEdges.has(edgeKey)) {
			throw new CaseImportError(`Duplicate referral (${fromId} → ${toId}).`);
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

// Throws if the graph has a cycle or a persona unreachable from a root.
function validateCaseGraph(graph: RawCaseGraph): void {
	const { personaOrder, personaById, roots, edges } = graph;

	const { dropped } = splitCyclicEdges(personaOrder, edges);
	if (dropped.length > 0) {
		throw new CaseImportError(
			`Cycle detected involving ${dropped[0]?.toId} — referrals can't loop back.`,
		);
	}

	const reachable = reachableFrom(roots, edges);
	for (const id of personaOrder) {
		if (!reachable.has(id)) {
			const name = personaById.get(id)?.name;
			throw new CaseImportError(
				`${id}${name ? ` (${name})` : ""} isn't connected to any root persona.`,
			);
		}
	}
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

// Parses an exported case form into case data, throwing CaseImportError for anything that isn't a clean export.
export function parseHTMLForm(htmlText: string): ImportedCaseData {
	const doc = new DOMParser().parseFromString(htmlText, "text/html");
	if (
		!doc.getElementById("personas-list") ||
		!doc.getElementById("referrals-list")
	) {
		throw new CaseImportError("This doesn't look like a Case Lab import file.");
	}

	const rawGraph = readCaseGraphFromDom(doc);
	if (rawGraph.personaOrder.length === 0) {
		throw new CaseImportError(
			"No personas found in this file — add at least one before importing.",
		);
	}
	if (rawGraph.roots.length === 0) {
		throw new CaseImportError(
			"This file has no root personas — every persona is referred.",
		);
	}
	validateCaseGraph(rawGraph);

	const { personaOrder, personaById, roots, edges } = rawGraph;
	const {
		personas,
		referrals,
		roots: freshRoots,
	} = mintFreshPersonaIds({
		personas: personaOrder.map((id) => personaById.get(id) as Persona),
		referrals: edges,
		roots,
	});

	return {
		caseName: fieldValue(doc, "case_name").trim(),
		accessCode: fieldValue(doc, "access_code").trim(),
		simulationDurationMinutes: parseNumberField(
			fieldValue(doc, "simulation_duration_minutes"),
			"Simulation duration",
		),
		initialBrief: fieldValue(doc, "initial_brief").trim(),
		commonInformation: fieldValue(doc, "common_information").trim(),
		personas,
		referrals,
		roots: freshRoots,
	};
}
