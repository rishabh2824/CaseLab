// Payload/graph builders shared by convex-test suites -- everything builds off
// `personaPayload`/`caseStructure` below, so a new required field is one edit instead of
// updating every call site.
import type { Id } from "./_generated/dataModel";
import type {
	CaseStructure,
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "./models/cases";

export function personaPayload(
	id: string,
	overrides: Partial<PersonaPayload> = {},
): PersonaPayload {
	return {
		id,
		name: `Persona ${id}`,
		role: "Role",
		profile_photo: null,
		known_facts: null,
		personality_traits: null,
		availability_minutes: null,
		files: [],
		...overrides,
	};
}

export function referralEdge(
	from_id: string,
	to_id: string,
	conditions: string | null = null,
): ReferralEdgePayload {
	return { from_id, to_id, conditions };
}

export function fileEntry(
	overrides: Partial<{
		storage_id: Id<"_storage">;
		file_name: string;
		content_type: string | null;
		share_conditions: string | null;
		perceived_contents: string | null;
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
