import { type Infer, v } from "convex/values";

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
