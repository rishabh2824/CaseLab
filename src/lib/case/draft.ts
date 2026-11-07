import type { Persona, ReferralEdge } from "../types.js";

// Reads a number field as typed: null when blank, NaN when the text is not a number, otherwise its value. Nothing is rounded or dropped here, so the form's validation sees exactly what the user entered.
export function numberInputValue(input: HTMLInputElement): number | null {
	if (input.validity.badInput) return Number.NaN;
	return input.value === "" ? null : input.valueAsNumber;
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
	responseDelaySeconds: null,
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

// Returns the persona's trimmed name, or the fallback when the name is blank.
export const getPersonaLabel = (
	persona: { name: string },
	fallback: string,
): string => {
	const trimmed = persona.name.trim();
	return trimmed.length > 0 ? trimmed : fallback;
};

// Returns the referrals that point at the given persona.
export const referralsTo = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.toId === personaId);

// Indexes personas by id.
export const personasById = <P extends { id: string }>(
	personas: P[],
): Map<string, P> => new Map(personas.map((p) => [p.id, p]));
