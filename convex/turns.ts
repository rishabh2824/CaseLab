import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
} from "./_generated/server";
import type { ReplyJob } from "./model/reply";
import {
	completePendingTurn,
	failPendingTurn,
	flagPendingTurn,
	loadReplyJob,
	replyToTurn,
	sendMessage as sendStudentMessage,
} from "./model/turns";
import { flagReasonValidator } from "./shared/validators";

// Saves a student message as a pending turn and starts generating the reply.
export const sendMessage = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (ctx, { runId, personaId, message }) =>
		sendStudentMessage(ctx, runId, personaId, message),
});

// Loads what the reply action needs for a pending turn, or null if it already finished or was failed.
export const turnContext = internalQuery({
	args: { turnId: v.id("turns") },
	handler: async (ctx, { turnId }): Promise<ReplyJob | null> =>
		loadReplyJob(ctx, turnId),
});

// Runs a pending turn: classifies the message, generates the reply and applies its outcome.
export const reply = internalAction({
	args: { turnId: v.id("turns") },
	handler: async (ctx, { turnId }): Promise<void> => replyToTurn(ctx, turnId),
});

// Fails a pending turn.
export const failTurn = internalMutation({
	args: { turnId: v.id("turns") },
	handler: async (ctx, { turnId }): Promise<void> =>
		failPendingTurn(ctx, turnId),
});

// Flags a pending turn and answers it with a warning or a chat-ending reply.
export const applyFlag = internalMutation({
	args: {
		turnId: v.id("turns"),
		personaName: v.string(),
		reason: flagReasonValidator,
	},
	handler: async (ctx, { turnId, personaName, reason }): Promise<void> =>
		flagPendingTurn(ctx, turnId, personaName, reason),
});

// Saves the finished reply, unlocks the introduced personas and records shared files.
export const applyDecisions = internalMutation({
	args: {
		turnId: v.id("turns"),
		reply: v.string(),
		unlockedReferrals: v.array(v.object({ referredPersonaId: v.string() })),
		sharedFiles: v.array(v.object({ storageId: v.id("_storage") })),
	},
	handler: async (
		ctx,
		{ turnId, reply: replyText, unlockedReferrals, sharedFiles },
	): Promise<void> =>
		completePendingTurn(ctx, turnId, replyText, unlockedReferrals, sharedFiles),
});
