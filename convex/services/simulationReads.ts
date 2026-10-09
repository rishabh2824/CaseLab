import type {
	CaseStructure,
	PersonaPayload,
	ReferralEdgePayload,
} from "../models/cases";

export type PersonaGraph = {
	personas: Map<string, PersonaPayload>;
	referrals: ReferralEdgePayload[];
	roots: string[];
};

// Turns a case structure into a graph of personas, referral edges and name-sorted roots.
export function flattenPersonas(structure: CaseStructure): PersonaGraph {
	const personas = new Map(structure.personas.map((p) => [p.id, p]));
	const roots = [...new Set(structure.roots)]
		.filter((id) => personas.has(id))
		.sort((a, b) =>
			(personas.get(a)?.name ?? "").localeCompare(personas.get(b)?.name ?? ""),
		);
	return { personas, referrals: structure.referrals, roots };
}

// Returns the referral edges authored by a given persona.
export function graphReferrals(
	graph: PersonaGraph,
	fromId: string,
): ReferralEdgePayload[] {
	return graph.referrals.filter((edge) => edge.fromId === fromId);
}

// Returns the graph's personas for the given ids, skipping unknown ids.
export function graphPersonas(
	graph: PersonaGraph,
	referredIds: Iterable<string>,
): PersonaPayload[] {
	const result: PersonaPayload[] = [];
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
export function graphRootPersonas(graph: PersonaGraph): PersonaPayload[] {
	return graph.roots.map((id) => graph.personas.get(id)!);
}
