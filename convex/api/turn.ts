import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
} from "../_generated/server";
import {
	applyBoundary as applyBoundaryService,
	applyDecisions as applyDecisionsService,
	failTurn as failTurnService,
	loadTurn,
	runReply,
	sendMessage as sendMessageService,
} from "../services/turn";

// Saves a student message with a pending reply and starts generating the reply.
export const sendMessage = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (ctx, args) =>
		await sendMessageService(ctx, args.runId, args.personaId, args.message),
});

// Loads what the reply action needs for a pending reply.
export const turnContext = internalQuery({
	args: { replyId: v.id("runMessages") },
	handler: async (ctx, args) => await loadTurn(ctx, args.replyId),
});

// Generates and saves the reply for a pending reply row.
export const reply = internalAction({
	args: { replyId: v.id("runMessages") },
	handler: async (ctx, args) => await runReply(ctx, args.replyId),
});

// Fails a reply that is still pending, so the student can send again.
export const failTurn = internalMutation({
	args: { replyId: v.id("runMessages") },
	handler: async (ctx, args) => await failTurnService(ctx, args.replyId),
});

// Records a warning or chat-ending boundary reply for a flagged message.
export const applyBoundary = internalMutation({
	args: {
		replyId: v.id("runMessages"),
		label: v.string(),
		personaName: v.string(),
	},
	handler: async (ctx, args) =>
		await applyBoundaryService(ctx, args.replyId, args.label, args.personaName),
});

// Saves the finished reply along with any referral unlocks and shared files.
export const applyDecisions = internalMutation({
	args: {
		replyId: v.id("runMessages"),
		reply: v.string(),
		unlockedReferrals: v.array(v.object({ referredPersonaId: v.string() })),
		sharedFiles: v.array(v.object({ storageId: v.id("_storage") })),
	},
	handler: async (ctx, args) =>
		await applyDecisionsService(
			ctx,
			args.replyId,
			args.reply,
			args.unlockedReferrals,
			args.sharedFiles,
		),
});
