import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { caseStructureValidator } from "./models/cases";

export const adminRole = v.union(v.literal("super"), v.literal("admin"));
export type AdminRole = "super" | "admin";

export const RUN_LIFETIME_MINUTES = 120;

export const MAX_MESSAGE_WORDS = 50;

export const ACCESS_CODE_FORMAT = /^[a-z]+$/;

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
		commonInformation: v.optional(v.string()),
		duration: v.optional(v.number()),
		accessCode: v.string(),
		ownerAdminId: v.id("admins"),
		structure: caseStructureValidator,
	})
		.index("by_owner", ["ownerAdminId"])
		.index("by_access_code", ["accessCode"]),

	collaborators: defineTable({
		caseId: v.id("cases"),
		adminId: v.id("admins"),
		addedAt: v.number(),
	})
		.index("by_case", ["caseId"])
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
		startTime: v.number(),
		expiresAt: v.number(),
		unlockedReferredIds: v.array(v.string()),
		unlockedAt: v.record(v.string(), v.number()),
		sharedFiles: v.array(v.id("files")),
		personaChatState: v.record(v.string(), chatState),
		destroyJobId: v.optional(v.id("_scheduled_functions")),
	}).index("by_expiry", ["expiresAt"]),

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
		message: v.optional(v.string()),
		settled: v.boolean(),
	})
		.index("by_run_persona", ["runId", "personaKey"])
		.index("by_stream", ["streamId"]),
});
