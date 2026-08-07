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
			brief: "Reduce office supply costs.",
			simulation_duration: 45,
		},
		contacts: [makeContact()],
		active_persona_id: "mary",
		shared_files: [],
		histories: {},
		...overrides,
	};
}

export const message = (
	role: "user" | "assistant",
	content: string,
): Api<"ChatMessage"> => ({ role, content });

// --- Wire-shape (Api<K>) builders -------------------------------------------
//
// Unlike makePersona/makeContact/etc. above (which return the app's draft or
// renamed types), these return the raw schema shape verbatim -- for stubbing
// API responses directly (MSW handlers, e2e route mocks), where the point is
// catching a backend field rename/type change at compile time.

export function makePersonaPayload(
	overrides: Partial<Api<"PersonaPayload">> = {},
): Api<"PersonaPayload"> {
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

export function makeCaseDetail(
	overrides: Partial<Api<"CaseDetail">> = {},
): Api<"CaseDetail"> {
	return {
		id: 1,
		case_name: "Sterling Industries",
		access_code: "STERLING",
		brief: "Reduce office supply costs.",
		common_information: "Company background.",
		simulation_duration: 45,
		personas: [makePersonaPayload()],
		referrals: [],
		roots: ["p1"],
		version: 1,
		owner_admin_id: 1,
		collaborator_admin_ids: [],
		...overrides,
	};
}

export function makeAdminOut(
	overrides: Partial<Api<"AdminOut">> = {},
): Api<"AdminOut"> {
	return {
		id: 1,
		email: "admin@wisc.edu",
		name: "Admin One",
		role: 2,
		...overrides,
	};
}
