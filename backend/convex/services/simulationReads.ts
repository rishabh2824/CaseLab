import type { FileEntryPayload, FileRefPayload, PersonaPayload, ReferralEdgePayload } from "../models/cases";

type CaseStructure = { personas: PersonaPayload[]; referrals: ReferralEdgePayload[]; roots: string[] };

function parseStructure(structure: unknown): CaseStructure {
	const s = (structure ?? {}) as Partial<CaseStructure>;
	return { personas: s.personas ?? [], referrals: s.referrals ?? [], roots: s.roots ?? [] };
}

// Mirrors backend/models/runtime.py's PersonaDetail. `profilePhotoUrl` starts null and is
// filled in by hydratePersona (services/simulations.ts) at response-building time -- this
// module never touches Spaces, same as reads.py.
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

// Mirrors backend/services/simulation/reads.py's getPersonaDetails: renames the wire/admin-
// authoring field `availability_minutes` to the internal `availabilityDuration`.
function getPersonaDetails(persona: PersonaPayload, isReferred: boolean): PersonaDetail {
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

export type ReferralEdge = { parentPersonaId: string; referredPersonaId: string; conditionTrigger: string };

export type PersonaGraph = {
	personas: Map<string, PersonaDetail>;
	referrals: ReferralEdge[];
	roots: string[];
};

// Mirrors backend/services/simulation/reads.py's flattenPersonas: reshapes a case's stored
// structure blob into {personas, referrals, roots}. Unlike the old backend, this is never
// cached onto a run (no RunSnapshot/persona_graph column, no _snapshot_cache) -- callers
// just call this fresh off the live case document every time, which is cheap since the
// case doc is already fetched by then.
export function flattenPersonas(structure: unknown): PersonaGraph {
	const { personas: personaPayloads, referrals: referralPayloads, roots: rawRoots } = parseStructure(structure);
	const rootSet = new Set(rawRoots);
	const personas = new Map<string, PersonaDetail>();
	for (const p of personaPayloads) personas.set(p.id, getPersonaDetails(p, !rootSet.has(p.id)));
	const roots = [...rootSet]
		.filter((id) => personas.has(id))
		.sort((a, b) => (personas.get(a)?.name ?? "").localeCompare(personas.get(b)?.name ?? ""));
	const referrals = referralPayloads.map((r) => ({
		parentPersonaId: r.from_id,
		referredPersonaId: r.to_id,
		conditionTrigger: r.conditions || "",
	}));
	return { personas, referrals, roots };
}

// Referrals authored by a persona. Personas here are raw (never a hydrated photo URL) --
// hydratePersona (services/simulations.ts) is the caller's job at the point it builds a
// response, not this module's; simulationReads.ts never touches Spaces.
export function graphReferrals(graph: PersonaGraph, parentPersonaId: string): ReferralEdge[] {
	return graph.referrals.filter((edge) => edge.parentPersonaId === parentPersonaId);
}

// Persona details for a set of already-unlocked referred persona ids. Map lookup means
// de-duplication is free -- same reasoning as graphReferrals above re: raw personas.
export function graphPersonas(graph: PersonaGraph, referredIds: Iterable<string>): PersonaDetail[] {
	const result: PersonaDetail[] = [];
	for (const id of referredIds) {
		const persona = graph.personas.get(id);
		if (persona) result.push(persona);
	}
	return result;
}

// Raw persona for any id in the graph, root or referred.
export function graphPersonaById(graph: PersonaGraph, personaId: string): PersonaDetail | undefined {
	return graph.personas.get(personaId);
}

// Root personas as full details, in the same name-sorted order as `graph.roots`. The `!` is
// safe, not a shortcut: flattenPersonas only ever puts an id in `roots` after confirming a
// persona with that id exists in `personas`.
export function graphRootPersonas(graph: PersonaGraph): PersonaDetail[] {
	return graph.roots.map((id) => graph.personas.get(id)!);
}
