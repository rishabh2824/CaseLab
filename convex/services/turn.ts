import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import {
	classifyHarassment,
	LLM_ATTEMPT_TIMEOUT_MS,
	PERSONA_REPLY_RETRIES,
	personaReplyStream,
	RECENT_HISTORY_LIMIT,
} from "../lib/llm";
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
import { MAX_MESSAGE_WORDS } from "../schema";
import {
	flattenPersonas,
	graphPersonaById,
	graphReferrals,
	type PersonaDetail,
} from "./simulationReads";
import { loadLiveRun } from "./simulations";

// The frontend (run.svelte.ts) matches on the plain error message string, same as every
// other rejection here (rate limited, persona unavailable, etc.), so there's no structured
// {message, code} shape to preserve.
const CONVERSATION_ENDED_MESSAGE = "This conversation has ended.";

// Shared by startTurn, applyBoundary, and applyDecisions below -- the only 5-field runMessages
// insert this file ever does, whether the row is the student's own message or one of the
// persona's replies (canned boundary or LLM-generated).
async function appendMessage(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	role: "user" | "assistant",
	content: string,
): Promise<void> {
	await ctx.db.insert("runMessages", {
		runId,
		personaKey: personaId,
		role,
		content,
	});
}

// Split at the boundary Convex requires: this mutation covers validation/availability-check/
// rate-limit/appendMessage -- everything that's pure DB work and needs a transaction. The
// classifier fan-out and the LLM call move to runTurn (an action, scheduled below), since
// both are I/O a mutation can't perform.
export async function startTurn(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	rawMessage: string,
): Promise<void> {
	const message = rawMessage.trim();
	if (!personaId || !message)
		throw new Error("personaId and message are required.");
	if (message.split(/\s+/).filter(Boolean).length > MAX_MESSAGE_WORDS) {
		throw new Error(
			`Message is too long (${MAX_MESSAGE_WORDS} words max). Please shorten it and try again.`,
		);
	}

	const { run, c } = await loadLiveRun(ctx, runId);
	if (getChatState(run.personaChatState, personaId).ended)
		throw new Error(CONVERSATION_ENDED_MESSAGE);

	const elapsed = elapsedMinutes(run.startTime, Date.now());
	if (c.duration && elapsed >= c.duration)
		throw new Error("This simulation has ended.");

	const graph = flattenPersonas(c.structure);
	const persona = graphPersonaById(graph, personaId);
	if (!persona) throw new Error("Persona not found.");
	const availableAt = graph.roots.includes(personaId)
		? 0
		: run.unlockedReferredIds.includes(personaId)
			? (run.unlockedAt[personaId] ?? elapsed)
			: null;
	if (availableAt === null) throw new Error("Persona is not available yet.");
	if (
		!personaAvailability(persona.availabilityDuration, availableAt, elapsed)
			.available
	) {
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

	await appendMessage(ctx, runId, personaId, "user", message);
	// Skipped when it's already this persona -- the common case, since a student's next
	// message is usually to whoever they're already talking to. A patch invalidates the
	// getSimulationState subscription (services/simulations.ts) regardless of whether any
	// field actually changed, re-pushing the full run state (contacts, photo URLs, shared
	// files) to that student on every message otherwise.
	if (run.activePersonaKey !== personaId) {
		await ctx.db.patch(runId, { activePersonaKey: personaId });
	}

	await ctx.scheduler.runAfter(0, internal.api.turn.runTurn, {
		runId,
		personaId,
		message,
		streamId,
	});
}

// A killed action (a deploy racing an in-flight turn, an enforced max-duration, an OOM) skips
// runTurn's own catch, so markStreamingError never runs and a row can be left at "streaming"
// forever -- claimStreamingSlot would then refuse every future turn on this persona for the
// rest of the run (up to RUN_LIFETIME_MINUTES), with no self-service recovery. updatedAt is
// refreshed on every legitimate write to a streamingReplies row (claim, preview flush,
// terminal patch -- see each of their own comments), so a genuinely stuck row is one nothing
// has touched in a while, not one that's merely slow to produce its first delta or between
// flushes. LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES (lib/llm.ts) is the worst-case time
// personaReplyStream itself allows before it gives up, so anything idle well past that can
// only mean the process died mid-turn, never that it's still legitimately working. Exported
// so tests can pin behavior right at the boundary without hard-coding a second copy of it.
export const STREAMING_SLOT_STALE_MS =
	LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES + 30_000;

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
//
// A "streaming" row older than STREAMING_SLOT_STALE_MS is reclaimed instead of rejected --
// see that constant's comment for why an unconditional rejection would otherwise strand a
// persona whenever the action generating its reply gets killed rather than erroring cleanly.
async function claimStreamingSlot(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<Id<"streamingReplies">> {
	const existing = await ctx.db
		.query("streamingReplies")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.first();
	const now = Date.now();
	if (existing) {
		const isStale = now - existing.updatedAt >= STREAMING_SLOT_STALE_MS;
		if (existing.status === "streaming" && !isStale) {
			throw new Error(
				"A reply is already being generated for this contact. Please wait.",
			);
		}
		await ctx.db.patch(existing._id, {
			text: "",
			status: "streaming",
			updatedAt: now,
		});
		return existing._id;
	}
	return await ctx.db.insert("streamingReplies", {
		runId,
		personaKey: personaId,
		text: "",
		status: "streaming",
		updatedAt: now,
	});
}

type PendingReferral = {
	referredPersonaId: string;
	conditionTrigger: string;
	referredName: string;
	referredRole: string;
};
type PendingFile = {
	fileId: Id<"files">;
	fileName: string;
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

// The pending-referral/pending-file filtering gathered here since runTurn (the action below)
// has no direct db access and needs this as one self-contained bundle fetched via
// ctx.runQuery.
export async function getTurnContext(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<TurnContext> {
	const { run, c } = await loadLiveRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const persona = graphPersonaById(graph, personaId);
	if (!persona) throw new Error("Persona not found.");

	// A blank condition can never be satisfied, so it's excluded here rather than shown to the
	// model as a candidate it has to judge -- a blank/unset condition means the case author
	// never configured one, and that must stay a hard guarantee, not something left to the
	// model's own reading of an empty condition string. A referral pointing at a persona that is
	// already a ROOT is excluded for a different reason: roots are reachable from minute 0, so
	// "unlocking" one introduces nobody, and recording it would make that persona surface twice
	// (see simulationReads.ts's referredContactIds).
	const pendingReferrals: PendingReferral[] = graphReferrals(graph, personaId)
		.filter(
			(referral) =>
				!run.unlockedReferredIds.includes(referral.referredPersonaId) &&
				!graph.roots.includes(referral.referredPersonaId) &&
				referral.conditionTrigger.trim(),
		)
		.map((referral) => {
			const referred = graphPersonaById(graph, referral.referredPersonaId);
			return {
				referredPersonaId: referral.referredPersonaId,
				conditionTrigger: referral.conditionTrigger,
				referredName: referred?.name ?? "",
				referredRole: referred?.role ?? "",
			};
		});

	// Each candidate's real `files` row id is resolved here by storage id -- the canonical
	// identity for a file (also what resolveFileRefs in services/files.ts uses), which keys
	// `sharedFiles` consistently with what applyDecisions writes. An entry whose storage object
	// has no `files` row at all is simply never offered, since nothing downstream could ever
	// record the share. Looked up concurrently (Promise.all), not one `await` per entry in a
	// loop -- same pattern services/simulations.ts's hydratePersona/toSharedFileOut callers
	// already use for their own per-item db lookups.
	const pendingFiles: PendingFile[] = (
		await Promise.all(
			persona.files
				.filter((entry) => entry.file && (entry.share_conditions ?? "").trim())
				.map(async (entry) => {
					const file = entry.file!;
					const row = await ctx.db
						.query("files")
						.withIndex("by_storage_id", (q) =>
							q.eq("storageId", file.storage_id),
						)
						.first();
					if (!row || run.sharedFiles.includes(row._id)) return null;
					return {
						fileId: row._id,
						fileName: file.file_name || "file",
						shareConditions: entry.share_conditions ?? null,
						perceivedContents: entry.perceived_contents ?? null,
					};
				}),
		)
	).filter((f): f is PendingFile => f !== null);

	// Bounded to RECENT_HISTORY_LIMIT -- the widest window anything downstream actually looks
	// at (llm.ts's classifier transcript and the persona-reply prompt below both use the same
	// constant), so a long-running conversation doesn't make every single turn re-read its
	// entire history just to discard most of it.
	const rows = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.order("desc")
		.take(RECENT_HISTORY_LIMIT);
	rows.reverse();

	return {
		caseBrief: c.brief,
		commonInformation: c.commonInformation ?? null,
		persona,
		pendingReferrals,
		pendingFiles,
		decisionHistory: rows.map((row) => ({
			role: row.role,
			content: row.content,
		})),
	};
}

// Increments the persona's warning count, ends the chat once NONSENSE_THRESHOLD is reached,
// and appends the persona's canned boundary reply.
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
	// startTurn already refuses a turn on a persona whose chat has ended (before
	// claimStreamingSlot even claims a slot for it), so this always runs with
	// previous.ended false -- there is no "already ended, latch to the earlier reason" case
	// to handle.
	const ended = warningCount >= NONSENSE_THRESHOLD;
	const endReason = ended ? label : previous.endReason;
	await ctx.db.patch(runId, {
		personaChatState: {
			...run.personaChatState,
			[personaId]: {
				warningCount,
				ended,
				endReason: endReason ?? undefined,
			},
		},
	});

	const reply = boundaryReply(personaName, ended);
	await appendMessage(ctx, runId, personaId, "assistant", reply);
	// A boundary reply is generated instantly, without ever streaming through
	// writeStreamingPreview -- clear the row claimStreamingSlot set to "streaming" anyway, so
	// every terminal path (this one and applyDecisions below) leaves it consistent.
	await clearStreamingPreview(ctx, streamId);

	return { ended, endReason: endReason ?? null, warningCount };
}

export type UnlockedReferral = { referredPersonaId: string };
export type SharedFileInput = { fileId: Id<"files"> };

// Persists the reply, any newly-unlocked referrals, and any newly-shared files, all in one
// mutation. Doesn't also build/return a ContactOut/SharedFileOut payload for an SSE meta
// frame -- there's no synchronous caller waiting on one; the reactive getSimulationState
// query (services/simulations.ts) already derives contacts/shared files fresh from this same
// data on every read.
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

	const sharedFileIds = new Set(run.sharedFiles);
	for (const file of sharedFiles) sharedFileIds.add(file.fileId);

	await ctx.db.patch(runId, {
		unlockedReferredIds,
		unlockedAt,
		sharedFiles: [...sharedFileIds],
	});
	await appendMessage(ctx, runId, personaId, "assistant", reply);
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
export async function writeStreamingPreview(
	ctx: MutationCtx,
	streamId: Id<"streamingReplies">,
	text: string,
): Promise<void> {
	await ctx.db.patch(streamId, {
		text,
		status: "streaming",
		updatedAt: Date.now(),
	});
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
async function clearStreamingPreview(
	ctx: MutationCtx,
	streamId: Id<"streamingReplies">,
): Promise<void> {
	await ctx.db.patch(streamId, {
		text: "",
		status: "done",
		updatedAt: Date.now(),
	});
}

export type StreamingPreviewOut = {
	text: string;
	status: "streaming" | "done" | "error";
} | null;

// Marks streamId's row "error" so a client's streamingPreview subscription
// (frontend/src/lib/student/run.svelte.ts) stops rendering whatever partial text had
// streamed in as if generation were still live, and can clear isSending / toast a failure
// instead of waiting forever for a reply that's never coming. Called from runTurn's catch
// (below) on ANY failure -- before any delta has streamed just as much as mid-stream, since
// claimStreamingSlot guarantees the row already exists by the time runTurn ever runs (unlike
// before this was threaded through as an id, there's no "no row yet" case to handle here
// anymore).
export async function markStreamingError(
	ctx: MutationCtx,
	streamId: Id<"streamingReplies">,
): Promise<void> {
	await ctx.db.patch(streamId, { status: "error", updatedAt: Date.now() });
}

// Deliberately scoped to just this one small streamingReplies document, not folded into
// getSimulationState's RunStateOut -- a client subscribed to THIS query only re-renders on
// this persona's own reply deltas. If the deltas instead lived on the run document
// getSimulationState reads, every delta would re-push the entire run state (contacts,
// every persona's history, shared files) to every subscriber, not just the ~40 bytes of new
// text one student watching one reply actually needs.
export async function getStreamingPreview(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<StreamingPreviewOut> {
	const row = await ctx.db
		.query("streamingReplies")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.first();
	return row ? { text: row.text, status: row.status } : null;
}

// Runs inside an action since both the classifier and the reply LLM call are I/O. Ends by
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
		const context = await ctx.runQuery(internal.api.turn.getTurnContext, {
			runId,
			personaId,
		});

		const harassmentPromise = classifyHarassment(
			message,
			context.decisionHistory,
		);
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
		const candidateReferrals: CandidateReferral[] =
			context.pendingReferrals.map((referral, i) => {
				const handle = `R${i + 1}`;
				referralByHandle.set(handle, referral);
				return {
					handle,
					name: referral.referredName,
					role: referral.referredRole,
					conditionTrigger: referral.conditionTrigger,
				};
			});

		const fileByHandle = new Map<string, PendingFile>();
		const candidateFiles: CandidateFile[] = context.pendingFiles.map(
			(file, i) => {
				const handle = `F${i + 1}`;
				fileByHandle.set(handle, file);
				return {
					handle,
					name: file.fileName,
					perceivedContents: file.perceivedContents,
					shareConditions: file.shareConditions,
				};
			},
		);

		const { stable, dynamic } = systemPrompt(
			context.caseBrief,
			context.commonInformation,
			context.persona,
			candidateReferrals,
			candidateFiles,
		);
		// replyInstructions() is static across every persona/case in the whole app, so folding it
		// into the cached block only grows the shared cache hit, never narrows it -- see
		// prompt.ts's SystemPromptParts and llm.ts's personaReplyStream for the cache boundary
		// itself.
		const cacheableSystemPrompt = `${replyInstructions()}\n\n---\n\n${stable}`;

		let fullText = "";
		const extractor = new ReplyExtractor();
		let previewText = "";
		let flushedText = "";
		let lastFlushedAt = 0;
		// context.decisionHistory is already bounded to RECENT_HISTORY_LIMIT at the query level
		// (getTurnContext above), so no further slicing is needed here.
		for await (const delta of personaReplyStream(
			{ cacheable: cacheableSystemPrompt, dynamic },
			context.decisionHistory,
		)) {
			fullText += delta.text;
			previewText += extractor.feed(delta.text);
			if (!cleared) continue;
			const now = Date.now();
			if (
				previewText !== flushedText &&
				now - lastFlushedAt >= STREAM_BATCH_INTERVAL_MS
			) {
				flushedText = previewText;
				lastFlushedAt = now;
				await ctx.runMutation(internal.api.turn.writeStreamingPreview, {
					streamId,
					text: previewText,
				});
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
			await ctx.runMutation(internal.api.turn.writeStreamingPreview, {
				streamId,
				text: previewText,
			});
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
			.map((f) => ({ fileId: f.fileId }));

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
		throw err instanceof Error
			? err
			: new Error("Something went wrong. Please resend your message.");
	}
}
