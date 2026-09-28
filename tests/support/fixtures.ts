import type { StartedRun } from "../../src/lib/student/run.svelte.js";
import type {
	ChatMessage,
	Contact,
	Persona,
	PersonaPayload,
	ReferralEdge,
	SharedFile,
} from "../../src/lib/types.js";

let personaSeq = 0;

// Builds a persona with a sequential id and optional overrides.
export function makePersona(overrides: Partial<Persona> = {}): Persona {
	personaSeq += 1;
	return {
		id: `p${personaSeq}`,
		name: `Persona ${personaSeq}`,
		role: "Role",
		profile_photo: null,
		known_facts: "",
		personality_traits: "",
		availability_minutes: null,
		files: [],
		...overrides,
	};
}

// Builds a referral edge.
export function makeReferral(
	from_id: string,
	to_id: string,
	conditions = "",
): ReferralEdge {
	return { from_id, to_id, conditions };
}

// Builds a contact, defaulting to Mary, the CFO.
export function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		id: "mary",
		name: "Mary",
		role: "Chief Financial Officer",
		profile_photo: null,
		availability_duration: null,
		available_at: 0,
		is_referred: false,
		chat_ended: false,
		chat_end_reason: null,
		warning_count: 0,
		...overrides,
	};
}

// Builds a shared file with default details.
export function makeSharedFile(
	overrides: Partial<SharedFile> = {},
): SharedFile {
	return {
		file_id: "7",
		file_name: "budget.pdf",
		content_type: "application/pdf",
		url: "https://spaces.example/budget.pdf",
		...overrides,
	};
}

// Builds a started run's state with one contact and no shared files.
export function makeRunState(overrides: Partial<StartedRun> = {}): StartedRun {
	return {
		run_id: "run-1",
		case: {
			id: "case-1",
			case_name: "Sterling Industries",
			brief: "Reduce office supply costs.",
			simulation_duration: 45,
		},
		contacts: [makeContact()],
		shared_files: [],
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
		profile_photo: null,
		known_facts: "",
		personality_traits: "",
		availability_minutes: null,
		files: [],
		...overrides,
	};
}
