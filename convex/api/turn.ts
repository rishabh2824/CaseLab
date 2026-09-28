import { v } from "convex/values";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "../_generated/server";
import {
	appendUserMessage as appendUserMessageService,
	applyBoundary as applyBoundaryService,
	applyDecisions as applyDecisionsService,
	claimTurn as claimTurnService,
	getTurnContext as getTurnContextService,
	getTurnStream as getTurnStreamService,
	removeUserMessage as removeUserMessageService,
	startTurn,
} from "../services/turn";

// Validates a student's message and claims the persona's reply slot for it.
export const start = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (ctx, args) =>
		await startTurn(ctx, args.runId, args.personaId, args.message),
});

// Returns the status (and optionally the text) of a persona's reply stream.
export const getTurnStream = query({
	args: { runId: v.id("runs"), personaId: v.string(), withText: v.boolean() },
	handler: async (ctx, args) =>
		await getTurnStreamService(ctx, args.runId, args.personaId, args.withText),
});

// Lets exactly one request claim the right to drive a turn's reply.
export const claimTurn = internalMutation({
	args: { streamId: v.string() },
	handler: async (ctx, args) => await claimTurnService(ctx, args.streamId),
});

// Loads the case, persona and history the reply generator needs.
export const getTurnContext = internalQuery({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, args) =>
		await getTurnContextService(ctx, args.runId, args.personaId),
});

// Stores the student's message in the persona's chat.
export const appendUserMessage = internalMutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (ctx, args) =>
		await appendUserMessageService(
			ctx,
			args.runId,
			args.personaId,
			args.message,
		),
});

// Removes a stored student message, used when a turn fails.
export const removeUserMessage = internalMutation({
	args: { messageId: v.id("runMessages") },
	handler: async (ctx, args) =>
		await removeUserMessageService(ctx, args.messageId),
});

// Records a warning or chat-ending boundary reply for a flagged message.
export const applyBoundary = internalMutation({
	args: {
		runId: v.id("runs"),
		personaId: v.string(),
		label: v.string(),
		personaName: v.string(),
		turnId: v.id("turnStreams"),
	},
	handler: async (ctx, args) =>
		await applyBoundaryService(
			ctx,
			args.runId,
			args.personaId,
			args.label,
			args.personaName,
			args.turnId,
		),
});

// Persists a finished reply along with any referral unlocks and shared files.
export const applyDecisions = internalMutation({
	args: {
		runId: v.id("runs"),
		personaId: v.string(),
		reply: v.string(),
		unlockedReferrals: v.array(v.object({ referredPersonaId: v.string() })),
		sharedFiles: v.array(v.object({ fileId: v.id("files") })),
		turnId: v.id("turnStreams"),
	},
	handler: async (ctx, args) =>
		await applyDecisionsService(
			ctx,
			args.runId,
			args.personaId,
			args.reply,
			args.unlockedReferrals,
			args.sharedFiles,
			args.turnId,
		),
});
