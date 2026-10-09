import type { Persona, ReferralEdge } from "../types.js";

// Parses a numeric string to a whole number, returning null for blank or non-numeric input.
export function parseIntOrNull(raw: string): number | null {
	if (raw === "") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

// Creates a blank persona with a fresh UUID, with optional field overrides.
export const createEmptyPersona = (
	overrides: Partial<Persona> = {},
): Persona => ({
	id: crypto.randomUUID(),
	name: "",
	role: "",
	profilePhoto: null,
	knownFacts: "",
	personalityTraits: "",
	availabilityMinutes: null,
	files: [],
	...overrides,
});

// Creates a blank referral edge, with optional field overrides.
export const createEmptyReferral = (
	overrides: Partial<ReferralEdge> = {},
): ReferralEdge => ({
	fromId: "",
	toId: "",
	conditions: "",
	...overrides,
});

// Returns whether an admin may be chosen as a collaborator: not a super admin and not the effective owner.
export const isSelectableCollaborator = (
	admin: { _id: string; role: string },
	effectiveOwnerId: string | null,
): boolean => admin.role !== "super" && admin._id !== effectiveOwnerId;

// Returns the persona's trimmed name, or the fallback when the name is blank.
export const getPersonaLabel = (
	persona: { name: string },
	fallback: string,
): string => {
	const trimmed = persona.name.trim();
	return trimmed.length > 0 ? trimmed : fallback;
};

// Returns whether any field in an error map has a message.
export const hasFieldErrors = (
	errors: Record<string, string | undefined>,
): boolean => Object.values(errors).some(Boolean);

// Returns the referrals authored by the given persona.
export const referralsFrom = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.fromId === personaId);

// Returns the referrals that point at the given persona.
export const referralsTo = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.toId === personaId);

// Indexes personas by id.
export const personasById = (personas: Persona[]): Map<string, Persona> =>
	new Map(personas.map((p) => [p.id, p]));

// Returns the root personas in roots order, skipping ids that don't exist.
export const rootPersonas = (
	personas: Persona[],
	roots: string[],
): Persona[] => {
	const byId = personasById(personas);
	return roots
		.map((id) => byId.get(id))
		.filter((persona): persona is Persona => Boolean(persona));
};

// Lists the non-root personas with a display label and the names of their referring parents.
export const referredWithParents = (
	personas: Persona[],
	referrals: ReferralEdge[],
	roots: string[],
): { persona: Persona; label: string; parentLabel: string }[] => {
	const byId = personasById(personas);
	return personas
		.filter((persona) => !roots.includes(persona.id))
		.map((persona, index) => ({
			persona,
			label: getPersonaLabel(persona, `Referred Persona ${index + 1}`),
			parentLabel: referralsTo(referrals, persona.id)
				.map((referral) =>
					getPersonaLabel(byId.get(referral.fromId) ?? { name: "" }, "Unknown"),
				)
				.join(", "),
		}));
};

// Returns every persona id reachable from the start ids by following referrals, safely handling cycles.
export const reachableFrom = (
	startIds: string[],
	referrals: ReferralEdge[],
): Set<string> => {
	const reachable = new Set(startIds);
	const queue = [...startIds];
	while (queue.length > 0) {
		const currentId = queue.shift() as string;
		for (const referral of referrals) {
			if (referral.fromId === currentId && !reachable.has(referral.toId)) {
				reachable.add(referral.toId);
				queue.push(referral.toId);
			}
		}
	}
	return reachable;
};
