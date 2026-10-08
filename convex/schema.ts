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

	files: defineTable({
		storageId: v.id("_storage"),
		name: v.string(),
		contentType: v.optional(v.string()),
	}).index("by_storage_id", ["storageId"]),

	caseFiles: defineTable({
		caseId: v.id("cases"),
		fileId: v.id("files"),
	})
		.index("by_case", ["caseId"])
		.index("by_file", ["fileId"]),

	runs: defineTable({
		caseId: v.id("cases"),
		expiresAt: v.number(),
		unlockedAt: v.record(v.string(), v.number()),
		sharedFiles: v.array(v.id("files")),
		personaChatState: v.record(v.string(), chatState),
	}),

	runMessages: defineTable({
		runId: v.id("runs"),
		personaKey: v.string(),
		role: v.union(v.literal("user"), v.literal("assistant")),
		content: v.string(),
	}).index("by_run_persona", ["runId", "personaKey"]),

	turnStreams: defineTable({
		runId: v.id("runs"),
		personaKey: v.string(),
		streamId: v.string(),
		startedAt: v.number(),
		settled: v.boolean(),
	}).index("by_run_persona", ["runId", "personaKey"]),
});
