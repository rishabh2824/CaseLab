// Case and message limits, and the field rules built on them. Shared by the Convex backend (which throws the first failing rule) and the browser (which shows them inline). Kept free of Convex imports.

export const MAX_DURATION_MINUTES = 120;

export const MAX_MESSAGE_WORDS = 50;

// Backstop for messages whose few "words" are enormous, which the word limit alone lets through.
export const MAX_MESSAGE_CHARS = 2000;

export const ACCESS_CODE_FORMAT = /^[a-z]+$/;

export type CaseInfoFieldErrors = Partial<
	Record<
		"caseName" | "initialBrief" | "accessCode" | "simulationDuration",
		string
	>
>;

export type PersonaFieldErrors = Partial<
	Record<"name" | "role" | "availability", string>
>;

// Validates the case-level fields (name, brief, access code, duration) and returns the messages for any that fail, in field order.
export function getCaseInfoErrors({
	caseName,
	initialBrief,
	accessCode,
	simulationDurationMinutes,
}: {
	caseName: string;
	initialBrief: string;
	accessCode: string;
	simulationDurationMinutes: number | null;
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
		(!Number.isInteger(simulationDurationMinutes) ||
			simulationDurationMinutes < 1 ||
			simulationDurationMinutes > MAX_DURATION_MINUTES)
	) {
		const hours = MAX_DURATION_MINUTES / 60;
		const hoursLabel = Number.isInteger(hours)
			? String(hours)
			: hours.toFixed(1);
		errors.simulationDuration =
			`Simulation duration must be a whole number of minutes between 1 and ${MAX_DURATION_MINUTES} ` +
			`(${hoursLabel} hour${hours === 1 ? "" : "s"}).`;
	}

	return errors;
}

// Validates a persona's name, role and availability and returns the messages for any that fail.
export function getPersonaFieldErrors(persona: {
	name: string;
	role: string;
	availabilityMinutes?: number | null;
}): PersonaFieldErrors {
	const errors: PersonaFieldErrors = {};
	if (!persona.name.trim()) errors.name = "Name is required.";
	if (!persona.role.trim()) errors.role = "Role is required.";
	if (
		typeof persona.availabilityMinutes === "number" &&
		(!Number.isInteger(persona.availabilityMinutes) ||
			persona.availabilityMinutes < 1)
	) {
		errors.availability = "Must be a whole number of minutes, at least 1.";
	}
	return errors;
}

// Returns whether an admin may be chosen as a collaborator: anyone but the effective owner. Super admins are allowed so they can be credited as authors. Shared by the picker and the server's save-time check.
export const isSelectableCollaborator = (
	admin: { _id: string },
	effectiveOwnerId: string | null,
): boolean => admin._id !== effectiveOwnerId;

// Counts whitespace-separated words. Shared by the server's message limit and the student page's live counter, so they cannot disagree.
export const countWords = (value: string): number =>
	value.trim().split(/\s+/).filter(Boolean).length;
