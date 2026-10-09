import { type Infer, v } from "convex/values";

export const fileRefValidator = v.union(
	v.null(),
	v.object({
		storageId: v.id("_storage"),
		fileName: v.string(),
		contentType: v.optional(v.string()),
	}),
);

export const fileEntryValidator = v.object({
	file: fileRefValidator,
	shareConditions: v.string(),
	perceivedContents: v.string(),
});

export const personaPayloadValidator = v.object({
	id: v.string(),
	name: v.string(),
	role: v.string(),
	profilePhoto: fileRefValidator,
	knownFacts: v.string(),
	personalityTraits: v.string(),
	availabilityMinutes: v.union(v.number(), v.null()),
	files: v.array(fileEntryValidator),
});

export const referralEdgeValidator = v.object({
	fromId: v.string(),
	toId: v.string(),
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
