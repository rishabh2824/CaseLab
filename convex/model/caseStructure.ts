import { validateStructure } from "../shared/caseGraph";
import { appError, ERROR_CODE } from "../shared/errors";
import type {
	CaseStructure,
	PersonaPayload,
	ReferralEdgePayload,
} from "../shared/validators";

// Validates the shape of a case's personas and referrals for saving.
export function validateGraph(
	personas: PersonaPayload[],
	referrals: ReferralEdgePayload[],
): void {
	const problem = validateStructure({ personas, referrals });
	if (problem) throw appError(ERROR_CODE.INVALID_CASE, problem);
}

// Trims the text a persona is shown by.
export function trimStructure({
	personas,
	referrals,
}: CaseStructure): CaseStructure {
	return {
		personas: personas.map((persona) => ({
			...persona,
			name: persona.name.trim(),
			role: persona.role.trim(),
		})),
		referrals,
	};
}
