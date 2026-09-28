import type {
	CaseStructure,
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
} from "../models/cases";

export type PersonaDetail = {
	id: string;
	name: string;
	role: string;
	profilePhoto: FileRefPayload;
	profilePhotoUrl: string | null;
	availabilityDuration: number | null;
	knownFacts: string | null;
	personalityTraits: string | null;
	files: FileEntryPayload[];
	isReferred: boolean;
};

// Converts a persona payload into the persona detail shape, defaulting missing fields to null.
function getPersonaDetails(
	persona: PersonaPayload,
	isReferred: boolean,
): PersonaDetail {
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profilePhoto: persona.profile_photo ?? null,
		profilePhotoUrl: null,
		availabilityDuration: persona.availability_minutes ?? null,
		knownFacts: persona.known_facts ?? null,
		personalityTraits: persona.personality_traits ?? null,
		files: persona.files ?? [],
		isReferred,
	};
}

export type ReferralEdge = {
	parentPersonaId: string;
	referredPersonaId: string;
	conditionTrigger: string;
};

export type PersonaGraph = {
	personas: Map<string, PersonaDetail>;
	referrals: ReferralEdge[];
	roots: string[];
};

// Turns a case structure into a graph of personas, referral edges and name-sorted roots.
export function flattenPersonas(structure: CaseStructure): PersonaGraph {
	const {
		personas: personaPayloads,
		referrals: referralPayloads,
		roots: rawRoots,
	} = structure;
	const rootSet = new Set(rawRoots);
	const personas = new Map<string, PersonaDetail>();
	for (const p of personaPayloads)
		personas.set(p.id, getPersonaDetails(p, !rootSet.has(p.id)));
	const roots = [...rootSet]
		.filter((id) => personas.has(id))
		.sort((a, b) =>
			(personas.get(a)?.name ?? "").localeCompare(personas.get(b)?.name ?? ""),
		);
	const referrals = referralPayloads.map((r) => ({
		parentPersonaId: r.from_id,
		referredPersonaId: r.to_id,
		conditionTrigger: r.conditions || "",
	}));
	return { personas, referrals, roots };
}

// Returns the referral edges authored by a given persona.
export function graphReferrals(
	graph: PersonaGraph,
	parentPersonaId: string,
): ReferralEdge[] {
	return graph.referrals.filter(
		(edge) => edge.parentPersonaId === parentPersonaId,
	);
}

// Returns the graph's personas for the given ids, skipping unknown ids.
export function graphPersonas(
	graph: PersonaGraph,
	referredIds: Iterable<string>,
): PersonaDetail[] {
	const result: PersonaDetail[] = [];
	for (const id of referredIds) {
		const persona = graph.personas.get(id);
		if (persona) result.push(persona);
	}
	return result;
}

// Dedupes unlocked ids and drops any that are roots.
export function referredContactIds(
	graph: PersonaGraph,
	unlockedReferredIds: Iterable<string>,
): string[] {
	const roots = new Set(graph.roots);
	return [...new Set(unlockedReferredIds)].filter((id) => !roots.has(id));
}

// Returns the root personas in root order.
export function graphRootPersonas(graph: PersonaGraph): PersonaDetail[] {
	return graph.roots.map((id) => graph.personas.get(id)!);
}
