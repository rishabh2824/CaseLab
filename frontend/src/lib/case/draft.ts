// Pure data-shaping helpers for the case form
import type { Persona, PersonaFieldErrors, ReferralEdge } from "../types.js";

export const createEmptyPersona = (
	overrides: Partial<Persona> = {},
): Persona => ({
	id: crypto.randomUUID(),
	name: "",
	role: "",
	profile_photo: null,
	known_facts: "",
	personality_traits: "",
	availability_minutes: null,
	files: [],
	...overrides,
});

export const createEmptyReferral = (
	overrides: Partial<ReferralEdge> = {},
): ReferralEdge => ({
	from_id: "",
	to_id: "",
	conditions: "",
	...overrides,
});

// Accepts anything shaped like a partial Persona — including the PersonaOut
// the API returns when loading a template/edit source. Only this persona's
// own (flat) fields are defaulted; there's nothing nested left to normalize.
export const normalizePersona = (
	persona: Partial<Persona> | null | undefined,
): Persona => ({
	...createEmptyPersona(),
	...(persona ?? {}),
	files: persona?.files ?? [],
});

export const normalizeReferral = (
	referral: Partial<ReferralEdge> | null | undefined,
): ReferralEdge => ({
	...createEmptyReferral(),
	...(referral ?? {}),
});

export const getPersonaLabel = (
	persona: { name: string },
	fallback: string,
): string => {
	const trimmed = persona.name.trim();
	return trimmed.length > 0 ? trimmed : fallback;
};

export const getPersonaFieldErrors = (persona: Persona): PersonaFieldErrors => {
	const errors: PersonaFieldErrors = {};
	if (!persona.name?.trim()) errors.name = "Name is required.";
	if (!persona.role?.trim()) errors.role = "Role is required.";
	if (
		typeof persona.availability_minutes === "number" &&
		persona.availability_minutes < 1
	) {
		errors.availability = "Must be at least 1 minute.";
	}
	return errors;
};

export const hasFieldErrors = (errors: PersonaFieldErrors): boolean =>
	Object.values(errors).some(Boolean);

// Referral edges authored by a given persona (its "refers out to" list).
export const referralsFrom = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.from_id === personaId);

// Referral edges pointing at a given persona (who refers to it — plural,
// since the flat model allows more than one parent).
export const referralsTo = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.to_id === personaId);

export const isRoot = (roots: string[], personaId: string): boolean =>
	roots.includes(personaId);

// Every persona reachable from `startIds` by following referral edges
// outward, including `startIds` themselves. Used to cascade-delete a
// persona's subtree without discarding a persona still reachable some other
// way (e.g. a second parent, under the flat model's multi-parent support).
export const reachableFrom = (
	startIds: string[],
	referrals: ReferralEdge[],
): Set<string> => {
	const reachable = new Set(startIds);
	const queue = [...startIds];
	while (queue.length > 0) {
		const currentId = queue.shift() as string;
		for (const referral of referrals) {
			if (referral.from_id === currentId && !reachable.has(referral.to_id)) {
				reachable.add(referral.to_id);
				queue.push(referral.to_id);
			}
		}
	}
	return reachable;
};
