import { ACCESS_CODE_FORMAT } from "../../../convex/lib/constants.js";
import type { CaseStructure } from "../../../convex/models/cases.js";
import type { Persona, PersonaFieldErrors, ReferralEdge } from "../types.js";

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
	profile_photo: null,
	known_facts: "",
	personality_traits: "",
	availability_minutes: null,
	files: [],
	...overrides,
});

// Creates a blank referral edge, with optional field overrides.
export const createEmptyReferral = (
	overrides: Partial<ReferralEdge> = {},
): ReferralEdge => ({
	from_id: "",
	to_id: "",
	conditions: "",
	...overrides,
});

// Fills in any missing persona fields with blank defaults, including a new id for null input.
export const normalizePersona = (
	persona: Partial<Persona> | null | undefined,
): Persona => ({
	...createEmptyPersona(),
	...(persona ?? {}),
	files: persona?.files ?? [],
});

// Fills in any missing referral fields with blank defaults.
export const normalizeReferral = (
	referral: Partial<ReferralEdge> | null | undefined,
): ReferralEdge => ({
	...createEmptyReferral(),
	...(referral ?? {}),
});

// Converts a stored case structure into normalized form-ready personas, referrals and roots.
export function parseCaseStructure(structure: CaseStructure | undefined): {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
} {
	return {
		personas: (structure?.personas ?? []).map((persona) =>
			normalizePersona(persona),
		),
		referrals: (structure?.referrals ?? []).map((referral) =>
			normalizeReferral(referral),
		),
		roots: structure?.roots ?? [],
	};
}

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

// Validates a persona's name, role and availability and returns the messages for any that fail.
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

// Returns whether any field in an error map has a message.
export const hasFieldErrors = (
	errors: Record<string, string | undefined>,
): boolean => Object.values(errors).some(Boolean);

export type CaseInfoFieldErrors = Partial<
	Record<
		"caseName" | "initialBrief" | "accessCode" | "simulationDuration",
		string
	>
>;

// Validates the case-level fields (name, brief, access code, duration) and returns the messages for any that fail.
export function getCaseInfoErrors({
	caseName,
	initialBrief,
	accessCode,
	simulationDurationMinutes,
	maxSimulationDuration,
}: {
	caseName: string;
	initialBrief: string;
	accessCode: string;
	simulationDurationMinutes: number | null;
	maxSimulationDuration: number;
}): CaseInfoFieldErrors {
	const errors: CaseInfoFieldErrors = {};
	if (!caseName.trim()) errors.caseName = "Case name is required.";
	if (!initialBrief.trim()) errors.initialBrief = "Initial brief is required.";

	const trimmedCode = accessCode.trim();
	if (!trimmedCode) {
		errors.accessCode = "Access code is required.";
	} else if (!ACCESS_CODE_FORMAT.test(trimmedCode)) {
		errors.accessCode = "Access code must contain only lowercase letters.";
	}

	if (
		typeof simulationDurationMinutes === "number" &&
		(simulationDurationMinutes > maxSimulationDuration ||
			simulationDurationMinutes < 1)
	) {
		const maxHours = maxSimulationDuration / 60;
		const hoursLabel = Number.isInteger(maxHours)
			? String(maxHours)
			: maxHours.toFixed(1);
		errors.simulationDuration =
			`Simulation duration must be between 1 and ${maxSimulationDuration} minutes ` +
			`(${hoursLabel} hour${maxHours === 1 ? "" : "s"}).`;
	}

	return errors;
}

// Returns the referrals authored by the given persona.
export const referralsFrom = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.from_id === personaId);

// Returns the referrals that point at the given persona.
export const referralsTo = (
	referrals: ReferralEdge[],
	personaId: string,
): ReferralEdge[] =>
	referrals.filter((referral) => referral.to_id === personaId);

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
					getPersonaLabel(
						byId.get(referral.from_id) ?? { name: "" },
						"Unknown",
					),
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
			if (referral.from_id === currentId && !reachable.has(referral.to_id)) {
				reachable.add(referral.to_id);
				queue.push(referral.to_id);
			}
		}
	}
	return reachable;
};
