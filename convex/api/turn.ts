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

// Validation, rate limit, and the turn lock -- generation itself runs in /turn-stream
// (http.ts), driven by the client. Public and unauthenticated, same as the rest of the
// student-facing simulation API.
export const start = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (ctx, args) =>
		await startTurn(ctx, args.runId, args.personaId, args.message),
});

// Public and unauthenticated, same as the rest of the student-facing simulation reads. See
// services/turn.ts's getTurnStream for what withText trades off.
export const getTurnStream = query({
	args: { runId: v.id("runs"), personaId: v.string(), withText: v.boolean() },
	handler: async (ctx, args) =>
		await getTurnStreamService(ctx, args.runId, args.personaId, args.withText),
});

// Not client-callable. Called by /turn-stream (http.ts) before it starts generating.
export const claimTurn = internalMutation({
	args: { streamId: v.string() },
	handler: async (ctx, args) => await claimTurnService(ctx, args.streamId),
});

// Not client-callable. Bundles everything runTurn (no direct db access) needs to run its
// classifier fan-out and build the reply prompt.
export const getTurnContext = internalQuery({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, args) =>
		await getTurnContextService(ctx, args.runId, args.personaId),
});

// Not client-callable. Called by runTurn the instant classifyHarassment clears the message as
// "normal" -- not by start (above), so a flagged message never enters this persona's persisted
// history in the first place. See services/turn.ts's appendUserMessage for why.
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

// Not client-callable. Called by runTurn's catch when a turn fails after storing the message.
export const removeUserMessage = internalMutation({
	args: { messageId: v.id("runMessages") },
	handler: async (ctx, args) =>
		await removeUserMessageService(ctx, args.messageId),
});

// Not client-callable. Called by runTurn when the harassment classifier flags the message.
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

// Not client-callable. Called by runTurn once the persona's reply has been generated.
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
