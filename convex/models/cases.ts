import { type Infer, v } from "convex/values";

// Every field below is `T | null | undefined`, not just `T | undefined`: the still-untouched
// CaseGraph/CaseGraphEditor frontend expects an unset field to arrive as JSON `null` rather
// than an omitted key, and often carries that null through itself. Deliberately snake_case,
// not Convex's usual camelCase: this shape lives inside `cases.structure` (a JSON blob -- see
// schema.ts) and is exactly what that frontend already reads and writes. There's no benefit
// to a translation layer here when the stored data and the only consumer already agree on
// this shape.
const nullableString = v.optional(v.union(v.string(), v.null()));

export const fileRefValidator = v.union(
	v.null(),
	v.object({
		storage_id: v.id("_storage"),
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

// The exact shape of `cases.structure` (schema.ts) -- shared from here rather than restated
// inline there, so the table's own validator and buildStructure's return type (see
// services/cases.ts) can never drift from each other or from create/update's own argument
// validators above.
export const caseStructureValidator = v.object({
	personas: v.array(personaPayloadValidator),
	referrals: v.array(referralEdgeValidator),
	roots: v.array(v.string()),
});

export type FileRefPayload = Infer<typeof fileRefValidator>;
export type FileEntryPayload = Infer<typeof fileEntryValidator>;
export type PersonaPayload = Infer<typeof personaPayloadValidator>;
export type ReferralEdgePayload = Infer<typeof referralEdgeValidator>;
export type CaseStructure = Infer<typeof caseStructureValidator>;
