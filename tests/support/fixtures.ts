import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api.js";
import type {
	ChatMessage,
	Contact,
	Persona,
	PersonaPayload,
	ReferralEdge,
	SharedFile,
} from "../../src/lib/types.js";

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
