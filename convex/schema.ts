import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
	adminRole,
	caseStructureValidator,
	collaboratorAccessValidator,
	fileRefValidator,
} from "./shared/validators";

export default defineSchema(
	{
		admins: defineTable({
			email: v.string(),
			name: v.string(),
			role: adminRole,
		}).index("by_email", ["email"]),

		cases: defineTable({
			name: v.string(),
			brief: v.string(),
			commonInformation: v.string(),
			duration: v.optional(v.number()),
			accessCode: v.string(),
			ownerAdminId: v.id("admins"),
			isTemplate: v.boolean(),
			teachingNotes: v.optional(fileRefValidator),
			structure: caseStructureValidator,
		})
			.index("by_owner", ["ownerAdminId"])
			.index("by_access_code", ["accessCode"])
			.index("by_is_template", ["isTemplate"]),

		collaborators: defineTable({
			caseId: v.id("cases"),
			adminId: v.id("admins"),
			access: collaboratorAccessValidator,
		})
			.index("by_admin", ["adminId"])
			.index("by_case_and_admin", ["caseId", "adminId"]),

		// One row per case that references an uploaded file; the rows count references so shared files are only deleted when none is left.
		caseFiles: defineTable({
			caseId: v.id("cases"),
			storageId: v.id("_storage"),
		})
			.index("by_case", ["caseId"])
			.index("by_storage_id", ["storageId"]),

		runs: defineTable({
			caseId: v.id("cases"),
			expiresAt: v.number(),
			unlockedAt: v.record(v.string(), v.number()),
			sharedFiles: v.array(v.id("_storage")),
		}),

		// One row per student message and its reply. A flagged turn holds the boundary text as its reply.
		turns: defineTable({
			runId: v.id("runs"),
			personaId: v.string(),
			studentMessage: v.string(),
			// Empty while the turn is pending.
			reply: v.string(),
			status: v.union(
				v.literal("pending"),
				v.literal("done"),
				v.literal("failed"),
				v.literal("flagged"),
			),
		})
			.index("by_run_persona", ["runId", "personaId"])
			.index("by_run_status", ["runId", "status"]),
	},
	// TEMPORARY: lets the first deploy through while stored cases still hold the old shape. Remove this flag, convex/migrations.ts and convex/migrations.test.ts after migrations:backfillCaseShape has run on every deployment.
	{ schemaValidation: false },
);
