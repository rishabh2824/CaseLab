import { ACCESS_CODE_FORMAT, RUN_LIFETIME_MINUTES } from "./constants";

// Field rules and messages shared by the Convex backend (which throws the first one) and the browser (which shows them inline). Kept free of Convex imports.

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
			simulationDurationMinutes > RUN_LIFETIME_MINUTES)
	) {
		const hours = RUN_LIFETIME_MINUTES / 60;
		const hoursLabel = Number.isInteger(hours)
			? String(hours)
			: hours.toFixed(1);
		errors.simulationDuration =
			`Simulation duration must be a whole number of minutes between 1 and ${RUN_LIFETIME_MINUTES} ` +
			`(${hoursLabel} hour${hours === 1 ? "" : "s"}).`;
	}

	return errors;
}

// Validates a persona's name, role and availability and returns the messages for any that fail.
export function getPersonaFieldErrors(persona: {
	name: string;
	role: string;
	availabilityMinutes: number | null;
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
