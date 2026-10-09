import { type Infer, v } from "convex/values";

// TEMPORARY: the snake_case case structure that existed before the camelCase rename. Only the
// migration and the widened schema use it. Delete once every deployment has been converted.
const legacyFileRef = v.union(
	v.null(),
	v.object({
		storage_id: v.id("_storage"),
		file_name: v.string(),
		content_type: v.optional(v.string()),
	}),
);

export const legacyCaseStructureValidator = v.object({
	personas: v.array(
		v.object({
			id: v.string(),
			name: v.string(),
			role: v.string(),
			profile_photo: legacyFileRef,
			known_facts: v.string(),
			personality_traits: v.string(),
			availability_minutes: v.optional(v.union(v.number(), v.null())),
			files: v.array(
				v.object({
					file: legacyFileRef,
					share_conditions: v.string(),
					perceived_contents: v.string(),
				}),
			),
		}),
	),
	referrals: v.array(
		v.object({
			from_id: v.string(),
			to_id: v.string(),
			conditions: v.string(),
		}),
	),
	roots: v.array(v.string()),
});

export type LegacyCaseStructure = Infer<typeof legacyCaseStructureValidator>;
