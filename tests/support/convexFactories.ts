import type { Id } from "../../convex/_generated/dataModel";
import type {
	CaseStructure,
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "../../convex/models/cases";

// Builds a persona payload with defaults and optional overrides.
export function personaPayload(
	id: string,
	overrides: Partial<PersonaPayload> = {},
): PersonaPayload {
	return {
		id,
		name: `Persona ${id}`,
		role: "Role",
		profilePhoto: null,
		knownFacts: "",
		personalityTraits: "",
		availabilityMinutes: null,
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
	fromId: string,
	toId: string,
	conditions = "",
): ReferralEdgePayload {
	return { fromId, toId, conditions };
}

// Builds a persona file entry with default file details and optional overrides.
export function fileEntry(
	overrides: Partial<{
		storageId: Id<"_storage">;
		fileName: string;
		contentType: string;
		shareConditions: string;
		perceivedContents: string;
	}> = {},
): FileEntryPayload {
	const {
		storageId = "kg2test00000000000000000" as Id<"_storage">,
		fileName = "doc.pdf",
		contentType = "application/pdf",
		shareConditions = "the user asks about the budget",
		perceivedContents = "last quarter's budget",
	} = overrides;
	const file: FileRefPayload = { storageId, fileName, contentType };
	return { file, shareConditions, perceivedContents };
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
