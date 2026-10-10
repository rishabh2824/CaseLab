import { validateStructure } from "../../../convex/lib/caseGraph.js";
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

type CaseGraph = {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

// Reads personas, roots and referral edges from the form DOM, in document order.
function readCaseGraphFromDom(doc: Document): CaseGraph {
	const personas: Persona[] = [];
	const roots: string[] = [];

	for (const card of doc.querySelectorAll(".persona-card[data-persona-id]")) {
		const id = card.getAttribute("data-persona-id");
		if (!id) continue;
		const files = Array.from(
			card.querySelectorAll(".files-block .file-row"),
		).map((row) => ({
			file: null,
			shareConditions: fieldValue(row, "share_conditions").trim(),
			perceivedContents: fieldValue(row, "perceived_contents").trim(),
		}));
		personas.push({
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

	const referrals: ReferralEdge[] = [];
	for (const row of doc.querySelectorAll(
		'.referral-row[data-referral="true"]',
	)) {
		const fromId = (
			row.querySelector('select[data-role="from"]') as HTMLSelectElement | null
		)?.value;
		const toId = (
			row.querySelector('select[data-role="to"]') as HTMLSelectElement | null
		)?.value;
		if (!fromId || !toId) continue;
		referrals.push({
			fromId,
			toId,
			conditions: fieldValue(row, "conditions").trim(),
		});
	}

	return { personas, referrals, roots };
}

// Gives every persona a new UUID and rewrites referrals and roots to match.
function mintFreshPersonaIds(graph: CaseGraph): CaseGraph {
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

	const graph = readCaseGraphFromDom(doc);
	const problem = validateStructure(graph);
	if (problem) throw new CaseImportError(problem);
	const { personas, referrals, roots } = mintFreshPersonaIds(graph);

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
		roots,
	};
}
