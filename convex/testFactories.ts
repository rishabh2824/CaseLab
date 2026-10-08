import type { Id } from "./_generated/dataModel";
import type {
	CaseStructure,
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "./models/cases";

// Builds a persona payload with defaults and optional overrides.
export function personaPayload(
	id: string,
	overrides: Partial<PersonaPayload> = {},
): PersonaPayload {
	return {
		id,
		name: `Persona ${id}`,
		role: "Role",
		profile_photo: null,
		known_facts: "",
		personality_traits: "",
		availability_minutes: null,
		files: [],
		...overrides,
	};
}

let accessCodeCounter = 0;
// Returns a fresh, letters-only access code that is unique per call.
export function uniqueAccessCode(): string {
	accessCodeCounter += 1;
	let n = accessCodeCounter;
	let letters = "";
	while (n > 0) {
		n -= 1;
		letters = String.fromCharCode(97 + (n % 26)) + letters;
		n = Math.floor(n / 26);
	}
	return `code${letters}`;
}

// Builds a referral edge payload.
export function referralEdge(
	from_id: string,
	to_id: string,
	conditions = "",
): ReferralEdgePayload {
	return { from_id, to_id, conditions };
}

// Builds a persona file entry with default file details and optional overrides.
export function fileEntry(
	overrides: Partial<{
		storage_id: Id<"_storage">;
		file_name: string;
		content_type: string;
		share_conditions: string;
		perceived_contents: string;
	}> = {},
): FileEntryPayload {
	const {
		storage_id = "kg2test00000000000000000" as Id<"_storage">,
		file_name = "doc.pdf",
		content_type = "application/pdf",
		share_conditions = "the user asks about the budget",
		perceived_contents = "last quarter's budget",
	} = overrides;
	const file: FileRefPayload = { storage_id, file_name, content_type };
	return { file, share_conditions, perceived_contents };
}

// Builds a case structure, defaulting to a single root persona.
export function caseStructure(
	overrides: Partial<{
		personas: PersonaPayload[];
		referrals: ReferralEdgePayload[];
		roots: string[];
	}> = {},
): CaseStructure {
	return {
		personas: overrides.personas ?? [personaPayload("A")],
		referrals: overrides.referrals ?? [],
		roots: overrides.roots ?? ["A"],
	};
}
