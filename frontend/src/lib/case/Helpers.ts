// Pure data-shaping helpers for the case form
import type {
	DraftPersona,
	DraftReferral,
	PartialDraftPersona,
	PartialDraftReferral,
	PersonaFieldErrors,
} from "../types.js";

export const createEmptyPersona = (
	overrides: Partial<DraftPersona> = {},
): DraftPersona => ({
	name: "",
	role: "",
	profile_photo: null,
	known_facts: "",
	personality_traits: "",
	availability_minutes: null,
	file_count: null,
	files: [],
	referral_out_count: null,
	referrals: [],
	...overrides,
});

export const createEmptyReferral = (
	overrides: Partial<DraftReferral> = {},
): DraftReferral => ({
	name: "",
	conditions: "",
	persona: createEmptyPersona(),
	...overrides,
});

// Accepts anything shaped like a (partial) DraftPersona — including the
// PersonaOut the API returns when loading a template/edit source. Only this
// persona's own fields are defaulted; nested referrals are passed through
// as-is (not deep-normalized) — see PartialDraftReferral.
export const normalizePersona = (
	persona: PartialDraftPersona | null | undefined,
): DraftPersona => ({
	...createEmptyPersona(),
	...(persona ?? {}),
	files: persona?.files ?? [],
	referrals: (persona?.referrals ?? []) as DraftReferral[],
});

export const normalizeReferral = (
	referral: PartialDraftReferral | null | undefined,
): DraftReferral => ({
	...createEmptyReferral(),
	...(referral ?? {}),
	persona: normalizePersona(referral?.persona),
});

export const getPersonaLabel = (
	persona: { name: string },
	fallback: string,
): string => {
	const trimmed = persona.name.trim();
	return trimmed.length > 0 ? trimmed : fallback;
};

export const getPersonaFieldErrors = (
	persona: DraftPersona,
): PersonaFieldErrors => {
	const errors: PersonaFieldErrors = {};
	if (!persona.name?.trim()) errors.name = "Name is required.";
	if (!persona.role?.trim()) errors.role = "Role is required.";
	if (
		typeof persona.availability_minutes === "number" &&
		persona.availability_minutes < 1
	) {
		errors.availability = "Must be at least 1 minute.";
	}
	if (typeof persona.file_count === "number" && persona.file_count < 0) {
		errors.fileCount = "Cannot be negative.";
	}
	if (
		typeof persona.referral_out_count === "number" &&
		persona.referral_out_count < 0
	) {
		errors.referralOutCount = "Cannot be negative.";
	}
	return errors;
};

export const hasFieldErrors = (errors: PersonaFieldErrors): boolean =>
	Object.values(errors).some(Boolean);

export type ReferredPersonaItem = {
	path: number[];
	persona: DraftPersona;
	label: string;
	parentLabel: string;
};

export const collectReferredPersonas = (
	personas: DraftPersona[],
): ReferredPersonaItem[] => {
	const referredItems: ReferredPersonaItem[] = [];

	const walk = (
		currentPersona: DraftPersona,
		path: number[],
		parentLabel: string,
	) => {
		const referrals = currentPersona?.referrals ?? [];
		referrals.forEach((referralRaw, referralIndex) => {
			const referral = normalizeReferral(referralRaw);
			const childPath = [...path, referralIndex];
			const referralLabel = getPersonaLabel(
				{ name: referral.name },
				"Referred Persona",
			);
			referredItems.push({
				path: childPath,
				persona: referral.persona,
				label: referralLabel,
				parentLabel,
			});
			const childLabel = getPersonaLabel(referral.persona, "Referred Persona");
			walk(referral.persona, childPath, childLabel);
		});
	};

	personas.forEach((persona, index) => {
		const normalized = normalizePersona(persona);
		const baseLabel = getPersonaLabel(normalized, `Persona ${index + 1}`);
		walk(normalized, [index], baseLabel);
	});

	return referredItems;
};
