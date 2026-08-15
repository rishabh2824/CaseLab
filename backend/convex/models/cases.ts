import { type Infer, v } from "convex/values";

// Mirrors backend/models/cases.py's FileRef/FileEntry/PersonaPayload/ReferralEdge --
// including their exact optionality (every field below is `T | null | undefined` in the
// generated frontend types, not just `T | undefined`, since Pydantic's `T | None = None`
// serializes an unset field as JSON `null`, and the untouched frontend often carries that
// null through rather than omitting the key). Deliberately snake_case, not Convex's usual
// camelCase: this shape lives inside `cases.structure` (a JSON blob preserved as-is from
// the old backend's migrated data -- see schema.ts) and is exactly what the still-untouched
// CaseGraph/CaseGraphEditor frontend already reads and writes. There's no benefit to a
// translation layer here when the stored data and the only consumer already agree on this
// shape.
const nullableString = v.optional(v.union(v.string(), v.null()));

export const fileRefValidator = v.union(
	v.null(),
	v.object({
		// Never read server-side (see services/files.ts's resolveFileRefs, which
		// resolves purely by object_key) -- accepted only so the untouched frontend can
		// round-trip an already-resolved ref's id without the shape being rejected.
		file_id: nullableString,
		object_key: v.string(),
		file_name: v.string(),
		content_type: nullableString,
	}),
);

export const fileEntryValidator = v.object({
	file: v.optional(fileRefValidator),
	share_conditions: nullableString,
	perceived_contents: nullableString,
});

export const personaPayloadValidator = v.object({
	id: v.string(),
	name: v.string(),
	role: v.string(),
	profile_photo: v.optional(fileRefValidator),
	known_facts: nullableString,
	personality_traits: nullableString,
	availability_minutes: v.optional(v.union(v.number(), v.null())),
	files: v.optional(v.array(fileEntryValidator)),
});

export const referralEdgeValidator = v.object({
	from_id: v.string(),
	to_id: v.string(),
	conditions: nullableString,
});

export type FileRefPayload = Infer<typeof fileRefValidator>;
export type FileEntryPayload = Infer<typeof fileEntryValidator>;
export type PersonaPayload = Infer<typeof personaPayloadValidator>;
export type ReferralEdgePayload = Infer<typeof referralEdgeValidator>;
