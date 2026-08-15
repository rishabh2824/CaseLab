import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { classifyHarassment, personaReplyStream, RECENT_HISTORY_LIMIT } from "../lib/llm";
import {
	type CandidateFile,
	type CandidateReferral,
	cleanReply,
	coerceHandles,
	parseReply,
	replyInstructions,
	systemPrompt,
} from "../lib/prompt";
import { messageLimit } from "../lib/rateLimits";
import { ReplyExtractor } from "../lib/replyStream";
import {
	boundaryReply,
	type ChatStateOut,
	elapsedMinutes,
	getChatState,
	NONSENSE_THRESHOLD,
	personaAvailability,
} from "../lib/turnState";
import { loadLiveRun } from "./simulations";
import { flattenPersonas, graphPersonaById, graphReferrals, type PersonaDetail } from "./simulationReads";

const MESSAGE_WORDS = 50;


// Mirrors backend/services/simulation/turn.py's CONVERSATION_ENDED, minus its `code` field --
// the frontend (run.svelte.ts) matches on the plain error message string, same as every
// other rejection here (rate limited, persona unavailable, etc.), so there's no structured
// {message, code} shape to preserve.
const CONVERSATION_ENDED_MESSAGE = "This conversation has ended.";

// Mirrors backend/services/simulation/turn.py's prepareTurn, split at the boundary Convex
// requires: this mutation covers prepareTurn's validation/availability-check/rate-limit/
// appendMessage -- everything that's pure DB work and needs a transaction. The classifier
// fan-out and the LLM call that used to happen in the same function move to runTurn (an
// action, scheduled below), since both are I/O a mutation can't perform.
export async function startTurn(ctx: MutationCtx, runId: Id<"runs">, personaId: string, rawMessage: string): Promise<void> {
	const message = rawMessage.trim();
	if (!personaId || !message) throw new Error("personaId and message are required.");
	if (message.split(/\s+/).filter(Boolean).length > MESSAGE_WORDS) {
		throw new Error(`Message is too long (${MESSAGE_WORDS} words max). Please shorten it and try again.`);
	}

	const { run, c } = await loadLiveRun(ctx, runId);
	if (getChatState(run.personaChatState, personaId).ended) throw new Error(CONVERSATION_ENDED_MESSAGE);

	const elapsed = elapsedMinutes(run.startTime, Date.now());
	if (c.duration && elapsed >= c.duration) throw new Error("This simulation has ended.");

	const graph = flattenPersonas(c.structure);
	const persona = graphPersonaById(graph, personaId);
	if (!persona) throw new Error("Persona not found.");
	const availableAt = graph.roots.includes(personaId)
		? 0
		: run.unlockedReferredIds.includes(personaId)
			? (run.unlockedAt[personaId] ?? elapsed)
			: null;
	if (availableAt === null) throw new Error("Persona is not available yet.");
	if (!personaAvailability(persona.availabilityDuration, availableAt, elapsed).available) {
		throw new Error("Persona is not available yet.");
	}

	// Every check above is a read against data already in hand and can reject the request
	// outright -- only pay for the rate-limit write once a message could plausibly succeed.
	await messageLimit(ctx, runId);

	// Claimed last, once nothing above can still reject the turn: this both allocates the
	// streamingReplies row runTurn will write batched deltas to (see claimStreamingSlot) AND
	// is the enforcement point for "only one turn in flight per persona at a time" -- see its
	// own comment for why.
	const streamId = await claimStreamingSlot(ctx, runId, personaId);

	await ctx.db.insert("runMessages", { runId, personaKey: personaId, role: "user", content: message });
	await ctx.db.patch(runId, { activePersonaKey: personaId });

	await ctx.scheduler.runAfter(0, internal.api.turn.runTurn, { runId, personaId, message, streamId });
}

// Claims this persona's streamingReplies row for a new turn, rejecting if one is already in
// flight -- this IS the concurrency guard for turns on the same persona, not just a defense
// against its symptoms (contrast with applyBoundary's endReason latch below, kept as a
// defensive backstop but no longer the primary protection). Two concurrent startTurn calls
// for the same (runId, personaId) both read and write this exact row, so Convex's own
// transaction isolation serializes them: whichever commits second sees the first's
// "streaming" status already there and is rejected, before it can insert a message, consume
// rate-limit budget, or schedule a second runTurn that would interleave writes with the
// first. Returning the row's id (rather than callers re-querying it by index every time) is
// also what lets writeStreamingPreview become a plain patch-by-id -- see its own comment.
async function claimStreamingSlot(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<Id<"streamingReplies">> {
	const existing = await ctx.db
		.query("streamingReplies")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId).eq("personaKey", personaId))
		.first();
	if (existing) {
		if (existing.status === "streaming") {
			throw new Error("A reply is already being generated for this contact. Please wait.");
		}
		await ctx.db.patch(existing._id, { text: "", status: "streaming" });
		return existing._id;
	}
	return await ctx.db.insert("streamingReplies", { runId, personaKey: personaId, text: "", status: "streaming" });
}

type PendingReferral = { referredPersonaId: string; conditionTrigger: string; referredName: string; referredRole: string };
type PendingFile = {
	fileId: string;
	fileName: string;
	contentType: string | null;
	objectKey: string;
	shareConditions: string | null;
	perceivedContents: string | null;
};
type DecisionMessage = { role: "user" | "assistant"; content: string };

export type TurnContext = {
	caseBrief: string;
	commonInformation: string | null;
	persona: PersonaDetail;
	pendingReferrals: PendingReferral[];
	pendingFiles: PendingFile[];
	decisionHistory: DecisionMessage[];
};

// Mirrors backend/services/simulation/reads.py's graphReferrals + the pending-referral/
// pending-file filtering that lived inline in turn.py's resolveDecisions -- gathered here
// since runTurn (the action below) has no direct db access and needs this as one
// self-contained bundle fetched via ctx.runQuery.
export async function getTurnContext(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<TurnContext> {
	const { run, c } = await loadLiveRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const persona = graphPersonaById(graph, personaId);
	if (!persona) throw new Error("Persona not found.");

	// A blank condition can never be satisfied, so it's excluded here rather than shown to the
	// model as a candidate it has to judge -- a blank/unset condition means the case author
	// never configured one, and that must stay a hard guarantee, not something left to the
	// model's own reading of an empty condition string.
	const pendingReferrals: PendingReferral[] = graphReferrals(graph, personaId)
		.filter((referral) => !run.unlockedReferredIds.includes(referral.referredPersonaId) && referral.conditionTrigger.trim())
		.map((referral) => {
			const referred = graphPersonaById(graph, referral.referredPersonaId);
			return {
				referredPersonaId: referral.referredPersonaId,
				conditionTrigger: referral.conditionTrigger,
				referredName: referred?.name ?? "",
				referredRole: referred?.role ?? "",
			};
		});

	const pendingFiles: PendingFile[] = persona.files
		.filter((entry) => entry.file?.file_id && !(entry.file.file_id in run.sharedFiles) && (entry.share_conditions ?? "").trim())
		.map((entry) => {
			const file = entry.file!;
			return {
				fileId: file.file_id!,
				fileName: file.file_name || "file",
				contentType: file.content_type ?? null,
				objectKey: file.object_key,
				shareConditions: entry.share_conditions ?? null,
				perceivedContents: entry.perceived_contents ?? null,
			};
		});

	// Bounded to RECENT_HISTORY_LIMIT -- the widest window anything downstream actually looks
	// at (llm.ts's classifier transcript and the persona-reply prompt below both use the same
	// constant), so a long-running conversation doesn't make every single turn re-read its
	// entire history just to discard most of it.
	const rows = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId).eq("personaKey", personaId))
		.order("desc")
		.take(RECENT_HISTORY_LIMIT);
	rows.reverse();

	return {
		caseBrief: c.brief,
		commonInformation: c.commonInformation ?? null,
		persona,
		pendingReferrals,
		pendingFiles,
		decisionHistory: rows.map((row) => ({ role: row.role, content: row.content })),
	};
}

// Mirrors the `if message_label != "normal"` branch of backend/services/simulation/
// turn.py's prepareTurn: increments the persona's warning count, flags the type, ends the
// chat once NONSENSE_THRESHOLD is reached, and appends the persona's canned boundary reply.
export async function applyBoundary(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	label: string,
	personaName: string,
	streamId: Id<"streamingReplies">,
): Promise<ChatStateOut> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");

	const previous = getChatState(run.personaChatState, personaId);
	const warningCount = previous.warningCount + 1;
	const ended = previous.ended || warningCount >= NONSENSE_THRESHOLD;
	// Once a chat has ended, its endReason latches to whatever first ended it. Kept as a
	// defensive backstop, not the primary protection: startTurn's claimStreamingSlot now
	// rejects a second turn on this persona outright while one is already in flight, so the
	// race this originally guarded against (two concurrent turns both reaching applyBoundary
	// for the same persona) can no longer happen in practice.
	const endReason = previous.ended ? previous.endReason : ended ? label : previous.endReason;
	await ctx.db.patch(runId, {
		personaChatState: {
			...run.personaChatState,
			[personaId]: { warningCount, ended, endReason: endReason ?? undefined, lastFlagType: label },
		},
	});

	const reply = boundaryReply(personaName, ended);
	await ctx.db.insert("runMessages", { runId, personaKey: personaId, role: "assistant", content: reply });
	// A boundary reply is generated instantly, without ever streaming through
	// writeStreamingPreview -- clear the row claimStreamingSlot set to "streaming" anyway, so
	// every terminal path (this one and applyDecisions below) leaves it consistent.
	await clearStreamingPreview(ctx, streamId);

	return { ended, endReason: endReason ?? null, warningCount };
}

export type UnlockedReferral = { referredPersonaId: string };
export type SharedFileInput = { fileId: Id<"files">; fileName: string; contentType: string | null; objectKey: string };

// Mirrors backend/services/simulation/turn.py's applyDecisions: persists the reply, any
// newly-unlocked referrals, and any newly-shared files, all in one mutation. Unlike the old
// backend, this doesn't also build/return a ContactOut/SharedFileOut payload for an SSE meta
// frame -- there's no synchronous caller waiting on one; the reactive getSimulationState
// query (services/simulations.ts) already derives contacts/shared files fresh from this same
// data on every read, which is the whole point of the reactive redesign (Phase 6).
export async function applyDecisions(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	reply: string,
	unlockedReferrals: UnlockedReferral[],
	sharedFiles: SharedFileInput[],
	streamId: Id<"streamingReplies">,
): Promise<void> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");

	// Mirrors turn.py's behavior of erroring out (nothing committed) on an empty/unusable
	// reply, rather than persisting a blank assistant bubble: an empty `reply` means the LLM
	// call itself produced nothing usable, so the whole turn is treated as failed -- no
	// referral/file unlocks either, same as any other failure path into markStreamingError.
	if (!reply.trim()) {
		await markStreamingError(ctx, streamId);
		return;
	}

	const elapsed = elapsedMinutes(run.startTime, Date.now());
	const unlockedReferredIds = [...run.unlockedReferredIds];
	const unlockedAt = { ...run.unlockedAt };
	for (const { referredPersonaId } of unlockedReferrals) {
		if (unlockedReferredIds.includes(referredPersonaId)) continue;
		unlockedReferredIds.push(referredPersonaId);
		unlockedAt[referredPersonaId] = elapsed;
	}

	const sharedFilesMap = { ...run.sharedFiles };
	for (const file of sharedFiles) {
		if (file.fileId in sharedFilesMap) continue;
		sharedFilesMap[file.fileId] = {
			fileId: file.fileId,
			fileName: file.fileName,
			contentType: file.contentType ?? undefined,
			objectKey: file.objectKey,
		};
	}

	await ctx.db.patch(runId, { unlockedReferredIds, unlockedAt, sharedFiles: sharedFilesMap });
	await ctx.db.insert("runMessages", { runId, personaKey: personaId, role: "assistant", content: reply });
	await clearStreamingPreview(ctx, streamId);
}

// How often runTurn (below) pushes an accumulated preview to `streamingReplies` while a
// reply is generating -- one write per batch of raw stream chunks, not one per chunk, so a
// long reply doesn't turn into dozens of tiny mutation calls. ~250ms is the plan's own stated
// target for feeling responsive to a subscribed client without excessive function-call volume.
const STREAM_BATCH_INTERVAL_MS = 250;

// Overwrites the streamingReplies row claimStreamingSlot (above) already created for this
// turn with the latest accumulated preview text. Always the FULL preview so far, not a delta
// to append -- callers don't need to track what the row already contains. A plain patch by
// id, not an index lookup first: the row's existence and id are guaranteed by the time
// runTurn (services/turn.ts) calls this, since startTurn always claims/creates it before
// ever scheduling runTurn -- looking it up again here on every single delta (this runs once
// per STREAM_BATCH_INTERVAL_MS, the hottest write path in the whole turn) would double the
// DB operations for no benefit.
export async function writeStreamingPreview(ctx: MutationCtx, streamId: Id<"streamingReplies">, text: string): Promise<void> {
	await ctx.db.patch(streamId, { text, status: "streaming" });
}

// Called by applyDecisions and applyBoundary (both above) once a turn has reached a terminal
// state -- clears the accumulated text and marks the row "done" so a client's streamingPreview
// subscription (frontend/src/lib/student/run.svelte.ts) stops showing it: streamingPreview
// only surfaces text while status is "streaming", so this is what makes the live bubble
// disappear once the canonical reply has landed in runMessages. Safe to patch by id
// unconditionally, same reasoning as writeStreamingPreview above -- both callers already
// confirmed the run itself still exists (via their own `ctx.db.get(runId)`), and the
// streamingReplies row is deleted in the same cascade as the run (deleteRunCascade,
// services/simulations.ts), so if the run's still there, so is this row.
async function clearStreamingPreview(ctx: MutationCtx, streamId: Id<"streamingReplies">): Promise<void> {
	await ctx.db.patch(streamId, { text: "", status: "done" });
}

export type StreamingPreviewOut = { text: string; status: "streaming" | "done" | "error" } | null;

// Marks streamId's row "error" so a client's streamingPreview subscription
// (frontend/src/lib/student/run.svelte.ts) stops rendering whatever partial text had
// streamed in as if generation were still live, and can clear isSending / toast a failure
// instead of waiting forever for a reply that's never coming. Called from runTurn's catch
// (below) on ANY failure -- before any delta has streamed just as much as mid-stream, since
// claimStreamingSlot guarantees the row already exists by the time runTurn ever runs (unlike
// before this was threaded through as an id, there's no "no row yet" case to handle here
// anymore). Guarded with a get-by-id first, not a bare patch, because this specific row CAN
// legitimately be gone already: the run expiring and deleteRunCascade (services/
// simulations.ts) running mid-turn is a real (if rare) race a long-running LLM call can lose
// to, and patching a deleted document throws.
export async function markStreamingError(ctx: MutationCtx, streamId: Id<"streamingReplies">): Promise<void> {
	if (await ctx.db.get(streamId)) {
		await ctx.db.patch(streamId, { status: "error" });
	}
}

// Deliberately scoped to just this one small streamingReplies document, not folded into
// getSimulationState's RunStateOut -- a client subscribed to THIS query only re-renders on
// this persona's own reply deltas. If the deltas instead lived on the run document
// getSimulationState reads, every delta would re-push the entire run state (contacts,
// every persona's history, shared files) to every subscriber, not just the ~40 bytes of new
// text one student watching one reply actually needs.
export async function getStreamingPreview(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<StreamingPreviewOut> {
	const row = await ctx.db
		.query("streamingReplies")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId).eq("personaKey", personaId))
		.first();
	return row ? { text: row.text, status: row.status } : null;
}

// Mirrors backend/services/simulation/turn.py's resolveDecisions plus the classifier/LLM
// portion of prepareTurn, run inside an action since both are I/O (LLM calls). Ends by
// calling applyBoundary or applyDecisions (both mutations) to persist the outcome.
//
// Referral/file eligibility is no longer a separate classifier fan-out: the same Sonnet call
// that writes the persona's reply also judges each candidate's condition itself (see
// lib/prompt.ts's systemPrompt), since it already has the full case context a standalone
// classifier never did. classifyHarassment stays its own small, unbiased Haiku call (see its
// own comment in lib/llm.ts for why) -- and since it almost always resolves to "normal", it
// runs CONCURRENTLY with the (much slower) Sonnet reply stream rather than gating it, so the
// common case doesn't pay the classifier's round-trip as extra latency before the reply even
// starts generating. The two are reconciled via `cleared` below: nothing streamed from Sonnet
// is ever written to streamingReplies (and so never shown to the client) until harassment has
// resolved to "normal" -- if it resolves any other way, the Sonnet output is discarded
// entirely and applyBoundary's canned reply is used instead, with no visible flicker either
// way, at the cost of occasionally paying for a Sonnet generation that goes unused.
//
// The whole body is one try/catch, not one per I/O stage: this is a scheduled action
// nothing awaits (startTurn just fires it via ctx.scheduler.runAfter), so an uncaught throw
// anywhere in here is otherwise invisible -- it fails the scheduled job silently, in Convex's
// own logs only. Two things depend on this catch actually running: isSending client-side
// never clears (no assistant message ever gets inserted for the effect watching
// serverHistories to observe), and if streaming had already begun, streamingReplies is left
// frozen at status "streaming" with partial text -- streamingPreview only stops showing that
// once status changes, so without this it renders as a live bubble forever. markStreamingError
// closes both: the frontend now clears isSending and toasts on status "error", the same way a
// synchronous startTurn rejection already does.
export async function runTurn(
	ctx: ActionCtx,
	runId: Id<"runs">,
	personaId: string,
	message: string,
	streamId: Id<"streamingReplies">,
): Promise<void> {
	try {
		const context = await ctx.runQuery(internal.api.turn.getTurnContext, { runId, personaId });

		const harassmentPromise = classifyHarassment(message, context.decisionHistory);
		// Flips true only once harassmentPromise resolves clean -- read inside the stream loop
		// below to decide whether it's safe to reveal anything yet. Safe as a plain closure
		// variable (not a race): everything here runs on Convex's single-threaded JS runtime,
		// so this callback is guaranteed to have run by the time any later `await` resumes and
		// the loop re-checks it, same as any other microtask-ordering guarantee in JS.
		let cleared = false;
		void harassmentPromise.then((label) => {
			if (label === "normal") cleared = true;
		});

		const referralByHandle = new Map<string, PendingReferral>();
		const candidateReferrals: CandidateReferral[] = context.pendingReferrals.map((referral, i) => {
			const handle = `R${i + 1}`;
			referralByHandle.set(handle, referral);
			return { handle, name: referral.referredName, role: referral.referredRole, conditionTrigger: referral.conditionTrigger };
		});

		const fileByHandle = new Map<string, PendingFile>();
		const candidateFiles: CandidateFile[] = context.pendingFiles.map((file, i) => {
			const handle = `F${i + 1}`;
			fileByHandle.set(handle, file);
			return { handle, name: file.fileName, perceivedContents: file.perceivedContents, shareConditions: file.shareConditions };
		});

		const prompt = systemPrompt(context.caseBrief, context.commonInformation, context.persona, candidateReferrals, candidateFiles);
		// context.decisionHistory is already bounded to RECENT_HISTORY_LIMIT at the query level
		// (getTurnContext above), so no further slicing is needed here.
		const messages = [
			{ role: "system" as const, content: `${replyInstructions()}\n\n---\n\n${prompt}` },
			...context.decisionHistory,
		];

		let fullText = "";
		const extractor = new ReplyExtractor();
		let previewText = "";
		let flushedText = "";
		let lastFlushedAt = 0;
		for await (const delta of personaReplyStream(messages)) {
			fullText += delta.text;
			previewText += extractor.feed(delta.text);
			if (!cleared) continue;
			const now = Date.now();
			if (previewText !== flushedText && now - lastFlushedAt >= STREAM_BATCH_INTERVAL_MS) {
				flushedText = previewText;
				lastFlushedAt = now;
				await ctx.runMutation(internal.api.turn.writeStreamingPreview, { streamId, text: previewText });
			}
		}

		const label = await harassmentPromise;
		if (label !== "normal") {
			await ctx.runMutation(internal.api.turn.applyBoundary, {
				runId,
				personaId,
				label,
				personaName: context.persona.name,
				streamId,
			});
			return;
		}

		if (previewText !== flushedText) {
			await ctx.runMutation(internal.api.turn.writeStreamingPreview, { streamId, text: previewText });
		}

		const parsed = parseReply(fullText);
		const reply = cleanReply((parsed?.reply as string | undefined) ?? "");

		const unlockedReferrals = [...new Set(coerceHandles(parsed?.introduce))]
			.map((handle) => referralByHandle.get(handle))
			.filter((r): r is PendingReferral => r !== undefined)
			.map((r) => ({ referredPersonaId: r.referredPersonaId }));

		const sharedFiles = [...new Set(coerceHandles(parsed?.send_files))]
			.map((handle) => fileByHandle.get(handle))
			.filter((f): f is PendingFile => f !== undefined)
			.map((f) => ({ fileId: f.fileId as Id<"files">, fileName: f.fileName, contentType: f.contentType, objectKey: f.objectKey }));

		await ctx.runMutation(internal.api.turn.applyDecisions, {
			runId,
			personaId,
			reply,
			unlockedReferrals,
			sharedFiles,
			streamId,
		});
	} catch (err) {
		await ctx.runMutation(internal.api.turn.markStreamingError, { streamId });
		throw err instanceof Error ? err : new Error("Something went wrong. Please resend your message.");
	}
}
