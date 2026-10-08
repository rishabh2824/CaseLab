import { type Infer, v } from "convex/values";

export const fileRefValidator = v.union(
	v.null(),
	v.object({
		storage_id: v.id("_storage"),
		file_name: v.string(),
		content_type: v.optional(v.string()),
	}),
);

export const fileEntryValidator = v.object({
	file: fileRefValidator,
	share_conditions: v.string(),
	perceived_contents: v.string(),
});

export const personaPayloadValidator = v.object({
	id: v.string(),
	name: v.string(),
	role: v.string(),
	profile_photo: fileRefValidator,
	known_facts: v.string(),
	personality_traits: v.string(),
	availability_minutes: v.union(v.number(), v.null()),
	files: v.array(fileEntryValidator),
});

export const referralEdgeValidator = v.object({
	from_id: v.string(),
	to_id: v.string(),
	conditions: v.string(),
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
