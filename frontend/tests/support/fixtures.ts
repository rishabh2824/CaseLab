// Domain fixtures shared across the frontend unit tests.
//
// Every builder takes an overrides object and returns a complete, wire-valid
// shape, so a test only states the field it actually cares about. Keeping them
// here (rather than re-declaring a persona literal per file) is what makes a
// wire-shape change surface as one edit instead of a dozen silently-stale
// copies — the same reason the backend keeps its payload builders in conftest.
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

// available_at: 0 (the default) means available from the run's own minute 0 -- callers
// simulating an unavailable/not-yet-unlocked contact should override this to some minute
// past whatever elapsed time the test's scenario implies, not pass an `available: false`
// flag (the wire shape no longer carries one -- see types.ts's Contact comment for why).
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
		active_persona_id: "mary",
		shared_files: [],
		...overrides,
	};
}

export const message = (
	role: "user" | "assistant",
	content: string,
): ChatMessage => ({ role, content });

// Returns the raw wire shape verbatim (not the app's draft/renamed Persona type) -- for
// stubbing Convex responses directly, where the point is catching a backend field
// rename/type change at compile time. Mirrors newBackend/convex/models/cases.ts's
// PersonaPayload.
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
