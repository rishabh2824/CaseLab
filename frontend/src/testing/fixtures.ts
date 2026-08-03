// Domain fixtures shared across the frontend unit tests.
//
// Every builder takes an overrides object and returns a complete, wire-valid
// shape, so a test only states the field it actually cares about. Keeping them
// here (rather than re-declaring a persona literal per file) is what makes a
// wire-shape change surface as one edit instead of a dozen silently-stale
// copies — the same reason the backend keeps its payload builders in conftest.
import type {
	Api,
	Contact,
	Persona,
	ReferralEdge,
	RunState,
	SharedFile,
	TurnMeta,
} from "../lib/types.js";

let personaSeq = 0;

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

export function makeReferral(
	from_id: string,
	to_id: string,
	conditions = "",
): ReferralEdge {
	return { from_id, to_id, conditions };
}

export function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		id: "mary",
		name: "Mary",
		role: "Chief Financial Officer",
		profile_photo: null,
		availability_duration: null,
		is_referred: false,
		available: true,
		available_in: 0,
		expires_in: null,
		chat_ended: false,
		chat_end_reason: null,
		warning_count: 0,
		...overrides,
	};
}

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

export function makeTurnMeta(overrides: Partial<TurnMeta> = {}): TurnMeta {
	return {
		new_contacts: [],
		shared_files: [],
		chat_ended: false,
		chat_end_reason: null,
		warning_count: 0,
		...overrides,
	};
}

export function makeRunState(overrides: Partial<RunState> = {}): RunState {
	return {
		run_id: "run-1",
		case: {
			id: 1,
			case_name: "Sterling Industries",
			initial_brief: "Reduce office supply costs.",
			simulation_duration: 45,
		},
		contacts: [makeContact()],
		active_persona_id: "mary",
		shared_files: [],
		histories: {},
		notes: "",
		...overrides,
	};
}

export const message = (
	role: "user" | "assistant",
	content: string,
): Api<"ChatMessage"> => ({ role, content });
