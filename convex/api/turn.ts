import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "../_generated/server";
import {
	applyBoundary as applyBoundaryService,
	applyDecisions as applyDecisionsService,
	getStreamingPreview as getStreamingPreviewService,
	getTurnContext as getTurnContextService,
	markStreamingError as markStreamingErrorService,
	runTurn as runTurnService,
	startTurn,
	writeStreamingPreview as writeStreamingPreviewService,
} from "../services/turn";

// Split at the mutation/action boundary Convex requires -- see services/turn.ts's startTurn
// for why. Public and unauthenticated, same as the rest of the student-facing simulation API.
export const start = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (ctx, args) =>
		await startTurn(ctx, args.runId, args.personaId, args.message),
});

// Not client-callable. Bundles everything runTurn (an action, no direct db access) needs to
// run its classifier fan-out and build the reply prompt.
export const getTurnContext = internalQuery({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, args) =>
		await getTurnContextService(ctx, args.runId, args.personaId),
});

// Not client-callable. Scheduled by start (above) once the user's message is persisted.
// streamId is the streamingReplies row startTurn already claimed (services/turn.ts's
// claimStreamingSlot) -- threaded through so nothing downstream needs to re-look it up.
export const runTurn = internalAction({
	args: {
		runId: v.id("runs"),
		personaId: v.string(),
		message: v.string(),
		streamId: v.id("streamingReplies"),
	},
	handler: async (ctx, args) =>
		await runTurnService(
			ctx,
			args.runId,
			args.personaId,
			args.message,
			args.streamId,
		),
});

// Not client-callable. Called by runTurn to push a batched preview of the in-progress reply
// to the streamingReplies row a client would subscribe to -- by id, not (runId, personaKey),
// since claimStreamingSlot (services/turn.ts) already resolved that id once per turn.
export const writeStreamingPreview = internalMutation({
	args: { streamId: v.id("streamingReplies"), text: v.string() },
	handler: async (ctx, args) =>
		await writeStreamingPreviewService(ctx, args.streamId, args.text),
});

// Public and unauthenticated, same as the rest of the student-facing simulation reads.
// Scoped to a single small streamingReplies document (see services/turn.ts's
// getStreamingPreview for why) -- the frontend subscribes to this instead of the
// getSimulationState-equivalent `api/simulations:get` query, so an in-progress reply's
// deltas don't re-push the entire run state to every subscriber. Still keyed by
// (runId, personaId), not an id -- unlike the internal mutations above, the frontend never
// has a streamId to key off of.
export const getStreamingPreview = query({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, args) =>
		await getStreamingPreviewService(ctx, args.runId, args.personaId),
});

// Not client-callable. Called by runTurn when the harassment classifier flags the message.
export const applyBoundary = internalMutation({
	args: {
		runId: v.id("runs"),
		personaId: v.string(),
		label: v.string(),
		personaName: v.string(),
		streamId: v.id("streamingReplies"),
	},
	handler: async (ctx, args) =>
		await applyBoundaryService(
			ctx,
			args.runId,
			args.personaId,
			args.label,
			args.personaName,
			args.streamId,
		),
});

// Not client-callable. Called by runTurn's catch on any failure, so a client's
// streamingPreview subscription can stop showing stale "streaming" state and the frontend
// can clear isSending / toast instead of waiting forever for a reply that failed.
export const markStreamingError = internalMutation({
	args: { streamId: v.id("streamingReplies") },
	handler: async (ctx, args) =>
		await markStreamingErrorService(ctx, args.streamId),
});

// Not client-callable. Called by runTurn once the persona's reply has been generated.
export const applyDecisions = internalMutation({
	args: {
		runId: v.id("runs"),
		personaId: v.string(),
		reply: v.string(),
		unlockedReferrals: v.array(v.object({ referredPersonaId: v.string() })),
		sharedFiles: v.array(v.object({ fileId: v.id("files") })),
		streamId: v.id("streamingReplies"),
	},
	handler: async (ctx, args) =>
		await applyDecisionsService(
			ctx,
			args.runId,
			args.personaId,
			args.reply,
			args.unlockedReferrals,
			args.sharedFiles,
			args.streamId,
		),
});
