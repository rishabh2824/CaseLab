// Pure data-shaping helpers for the case form
import type { Persona, PersonaFieldErrors, ReferralEdge } from "../types.js";

export function parseIntOrNull(raw: string): number | null {
	if (raw === "") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

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

// Accepts anything shaped like a partial Persona — including the PersonaPayload
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

export const personasById = (personas: Persona[]): Map<string, Persona> =>
	new Map(personas.map((p) => [p.id, p]));

export const rootPersonas = (
	personas: Persona[],
	roots: string[],
): Persona[] => {
	const byId = personasById(personas);
	return roots
		.map((id) => byId.get(id))
		.filter((persona): persona is Persona => Boolean(persona));
};

// Personas not in `roots` — i.e. every persona reachable only via a referral,
// in flat document order. A persona can have more than one referrer under
// the flat model, so the label shows every parent, not just one.
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
					getPersonaLabel(
						byId.get(referral.from_id) ?? { name: "" },
						"Unknown",
					),
				)
				.join(", "),
		}));
};

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
