// Pure data-shaping helpers for the case form
import { ACCESS_CODE_FORMAT } from "../../../convex/schema.js";
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

// A case document's `structure` field (personas/referrals/roots) as read back from Convex --
// validated server-side against caseStructureValidator (models/cases.ts), but that validator
// constrains shape, not the specific Persona/ReferralEdge display types this frontend wants
// (e.g. defaulting a field an older-shaped row never had). CaseForm.svelte (loading a case to
// edit or use as a template) and DemoCaseView.svelte (the read-only demo) both need this exact
// normalization; sharing it here means there's one place that knows how to turn a raw
// `structure` blob into display-ready Personas/Referrals, not two independently-written casts
// that could drift.
export function parseCaseStructure(structure: unknown): {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
} {
	const s = (structure ?? {}) as {
		personas?: unknown[];
		referrals?: unknown[];
		roots?: string[];
	};
	return {
		personas: (s.personas ?? []).map((persona) =>
			normalizePersona(persona as Parameters<typeof normalizePersona>[0]),
		),
		referrals: (s.referrals ?? []).map((referral) =>
			normalizeReferral(referral as Parameters<typeof normalizeReferral>[0]),
		),
		roots: s.roots ?? [],
	};
}

// SUPER admins already have full access to every case, and a case's owner can't also be
// listed as its own collaborator -- mirrors convex/services/cases.ts's resolveCollaboratorIds,
// which rejects both server-side. Named and exported (not an inline filter predicate) so
// convex/parity.test.ts can pin it against that rejection rule.
export const isSelectableCollaborator = (
	admin: { _id: string; role: string },
	effectiveOwnerId: string | null,
): boolean => admin.role !== "super" && admin._id !== effectiveOwnerId;

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

// Shared by any per-field error record this form produces (PersonaFieldErrors,
// CaseInfoFieldErrors below) -- both are just "field name -> message or absent",
// so there's one predicate for "does this record have any errors at all" rather
// than a copy per shape.
export const hasFieldErrors = (
	errors: Record<string, string | undefined>,
): boolean => Object.values(errors).some(Boolean);

export type CaseInfoFieldErrors = Partial<
	Record<
		"caseName" | "initialBrief" | "accessCode" | "simulationDuration",
		string
	>
>;

// A pure function of the case-info scalar fields, computed the same way
// getPersonaFieldErrors is: CaseForm.svelte calls this directly (via a $derived, like
// graph.validation) to decide whether Submit should be disabled, and CaseInfoFields.svelte
// calls the exact same function for its own per-field messages -- one place that knows what
// "invalid" means here, not two independently-derived copies that could disagree.
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
		// Derived from maxSimulationDuration, not hardcoded -- this message used to always say
		// "(2 hours)", which only happened to match RUN_LIFETIME_MINUTES's current value of 120
		// and would have silently gone wrong the moment that constant changed.
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
