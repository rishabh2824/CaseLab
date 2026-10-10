import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type {
	CaseStructure,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "../models/cases";
import { validateStructure } from "./caseGraph";
import { getPersonaFieldErrors } from "./caseRules";

// Persona ids become record keys in a run, and Convex record keys may not start with "_" or "$".
const PERSONA_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Validates a case's personas, roots and referrals for saving: the shared graph rules, safe persona ids and required persona fields.
export function validateGraph(
	personas: PersonaPayload[],
	referrals: ReferralEdgePayload[],
	roots: string[],
): void {
	const problem = validateStructure({ personas, referrals, roots });
	if (problem) throw new ConvexError(problem);

	for (const { id } of personas) {
		if (!PERSONA_ID_FORMAT.test(id)) {
			throw new ConvexError(
				`Invalid persona id: ${JSON.stringify(id)}. A persona id must start with a letter or digit and contain only letters, digits, hyphens, underscores, and periods.`,
			);
		}
	}
	for (const persona of personas) {
		const firstError = Object.values(getPersonaFieldErrors(persona))[0];
		if (firstError)
			throw new ConvexError(`Persona ${persona.id}: ${firstError}`);
	}
}

// Trims persona text, drops file references whose upload is gone and returns the cleaned structure plus the storage ids it uses.
export function cleanStructure(
	{ personas, referrals, roots }: CaseStructure,
	presentStorageIds: Set<Id<"_storage">>,
): { structure: CaseStructure; storageIds: Set<Id<"_storage">> } {
	const kept = (ref: FileRefPayload): FileRefPayload =>
		ref && presentStorageIds.has(ref.storageId) ? ref : null;

	const outPersonas = personas.map((persona) => ({
		id: persona.id,
		name: persona.name.trim(),
		role: persona.role.trim(),
		profilePhoto: kept(persona.profilePhoto),
		knownFacts: persona.knownFacts,
		personalityTraits: persona.personalityTraits,
		availabilityMinutes: persona.availabilityMinutes,
		files: persona.files.flatMap((entry) => {
			const file = kept(entry.file);
			return file ? [{ ...entry, file }] : [];
		}),
	}));

	const storageIds = new Set(
		outPersonas.flatMap((persona) =>
			[
				persona.profilePhoto,
				...persona.files.map((entry) => entry.file),
			].flatMap((ref) => (ref ? [ref.storageId] : [])),
		),
	);
	return {
		structure: { personas: outPersonas, referrals, roots },
		storageIds,
	};
}
