// Test builders shared by the backend tests (branded Convex ids, server payload shapes) and the frontend tests (plain string ids, client shapes).

import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel";
import type {
	CaseStructure,
	FileEntryPayload,
	FileRefPayload,
	ReferralEdgePayload,
	PersonaPayload as ServerPersonaPayload,
} from "../../convex/models/cases";
import type {
	ChatMessage,
	Contact,
	Persona,
	PersonaPayload,
	ReferralEdge,
	SharedFile,
} from "../../src/lib/types.js";

// Builds a persona payload with defaults and optional overrides.
export function personaPayload(
	id: string,
	overrides: Partial<ServerPersonaPayload> = {},
): ServerPersonaPayload {
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
		personas: ServerPersonaPayload[];
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

type RunState = FunctionReturnType<typeof api.simulations.get>;
// A run state with plain string ids, so tests don't have to mint branded Convex ids.
export type StartedRun = Omit<RunState, "runId" | "case"> & {
	runId: string;
	case: Omit<RunState["case"], "id"> & { id: string };
};

let personaSeq = 0;

// Builds a persona with a sequential id and optional overrides.
export function makePersona(overrides: Partial<Persona> = {}): Persona {
	personaSeq += 1;
	return {
		id: `p${personaSeq}`,
		name: `Persona ${personaSeq}`,
		role: "Role",
		profilePhoto: null,
		knownFacts: "",
		personalityTraits: "",
		availabilityMinutes: null,
		files: [],
		...overrides,
	};
}

// Builds a referral edge.
export function makeReferral(
	fromId: string,
	toId: string,
	conditions = "",
): ReferralEdge {
	return { fromId, toId, conditions };
}

// Builds a contact, defaulting to Mary, the CFO.
export function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		id: "mary",
		name: "Mary",
		role: "Chief Financial Officer",
		profilePhotoUrl: null,
		availabilityDuration: null,
		availableAt: 0,
		isReferred: false,
		chatEnded: false,
		...overrides,
	};
}

// Builds a shared file with default details.
export function makeSharedFile(
	overrides: Partial<SharedFile> = {},
): SharedFile {
	return {
		fileId: "7",
		fileName: "budget.pdf",
		contentType: "application/pdf",
		url: "https://spaces.example/budget.pdf",
		...overrides,
	};
}

// Builds a started run's state with one contact and no shared files.
export function makeRunState(overrides: Partial<StartedRun> = {}): StartedRun {
	return {
		runId: "run-1",
		case: {
			id: "case-1",
			caseName: "Sterling Industries",
			brief: "Reduce office supply costs.",
			simulationDuration: 45,
			authors: ["Olive Owner"],
		},
		contacts: [makeContact()],
		sharedFiles: [],
		...overrides,
	};
}

// Builds a chat message.
export const message = (
	role: "user" | "assistant",
	content: string,
): ChatMessage => ({ role, content });

// Builds a persona payload with blank defaults.
export function makePersonaPayload(
	overrides: Partial<PersonaPayload> = {},
): PersonaPayload {
	return {
		id: "p1",
		name: "Persona",
		role: "Role",
		profilePhoto: null,
		knownFacts: "",
		personalityTraits: "",
		availabilityMinutes: null,
		files: [],
		...overrides,
	};
}
