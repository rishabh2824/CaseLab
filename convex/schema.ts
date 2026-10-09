import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { caseStructureValidator } from "./models/cases";

export const adminRole = v.union(v.literal("super"), v.literal("admin"));

const chatState = v.object({
	warningCount: v.number(),
	ended: v.boolean(),
	endReason: v.optional(v.string()),
});

export default defineSchema({
	admins: defineTable({
		email: v.string(),
		name: v.optional(v.string()),
		role: adminRole,
	}).index("by_email", ["email"]),

	cases: defineTable({
		name: v.string(),
		brief: v.string(),
		commonInformation: v.string(),
		duration: v.optional(v.number()),
		accessCode: v.string(),
		ownerAdminId: v.id("admins"),
		isDemo: v.boolean(),
		structure: caseStructureValidator,
	})
		.index("by_owner", ["ownerAdminId"])
		.index("by_access_code", ["accessCode"])
		.index("by_is_demo", ["isDemo"]),

	collaborators: defineTable({
		caseId: v.id("cases"),
		adminId: v.id("admins"),
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
		personaChatState: v.record(v.string(), chatState),
	}),

	runMessages: defineTable({
		runId: v.id("runs"),
		personaKey: v.string(),
		role: v.union(v.literal("user"), v.literal("assistant")),
		content: v.string(),
		// User rows are always done. An assistant row starts pending and ends done or failed.
		status: v.union(
			v.literal("pending"),
			v.literal("done"),
			v.literal("failed"),
		),
		// Only set on assistant rows: the student message the reply answers.
		userMessageId: v.optional(v.id("runMessages")),
	}).index("by_run_persona", ["runId", "personaKey"]),
});
