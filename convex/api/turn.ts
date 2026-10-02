import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import {
	applyBoundary as applyBoundaryService,
	applyDecisions as applyDecisionsService,
	getTurnStream as getTurnStreamService,
	startTurn,
} from "../services/turn";

// Validates a student's message and claims the persona's reply slot for it.
export const start = internalMutation({
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

// Persists the student's message and the finished reply along with any referral unlocks and shared files.
export const applyDecisions = internalMutation({
	args: {
		runId: v.id("runs"),
		personaId: v.string(),
		message: v.string(),
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
			args.message,
			args.reply,
			args.unlockedReferrals,
			args.sharedFiles,
			args.turnId,
		),
});
