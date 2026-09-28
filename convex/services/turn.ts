import type { StreamId } from "@convex-dev/persistent-text-streaming";
import { components, internal } from "../_generated/api";
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
import { streaming } from "../lib/streaming";
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

// Shared by appendUserMessage, applyBoundary, and applyDecisions below -- the only 5-field
// runMessages insert this file ever does, whether the row is the student's own message or one
// of the persona's replies (canned boundary or LLM-generated).
async function appendMessage(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	role: "user" | "assistant",
	content: string,
): Promise<Id<"runMessages">> {
	return await ctx.db.insert("runMessages", {
		runId,
		personaKey: personaId,
		role,
		content,
	});
}

// Called by runTurn only once classifyHarassment has cleared the message as "normal" -- NOT by
// startTurn. A message that never clears (nonsense/harassment) must never enter a persona's
// persisted history: getTurnContext replays the last RECENT_HISTORY_LIMIT runMessages rows as
// trusted prior-turn context into every later generation, so a flagged message stored anyway
// would keep re-poisoning that context window turn after turn even though it was never treated
// as valid input the first time. Returns the row's id so a turn that then fails can take the
// message back out (removeUserMessage below).
export async function appendUserMessage(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	message: string,
): Promise<Id<"runMessages">> {
	return await appendMessage(ctx, runId, personaId, "user", message);
}

// Called by runTurn's catch: a failed turn tells the student to resend, so the message it
// already stored has to go, or the resend would leave it in the persona's history twice. The
// get() guards a run deleted mid-turn, whose cascade already removed it.
export async function removeUserMessage(
	ctx: MutationCtx,
	messageId: Id<"runMessages">,
): Promise<void> {
	if (await ctx.db.get(messageId)) await ctx.db.delete(messageId);
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

	// Claimed last, once nothing above can still reject the turn: this both creates the stream
	// the reply will be generated into AND is the enforcement point for "only one turn in
	// flight per persona at a time" -- see claimTurnSlot's own comment. Nothing is scheduled
	// here: generation starts when a client watching this persona sees the claimable turn (via
	// getTurnStream) and POSTs to /turn-stream (http.ts).
	await claimTurnSlot(ctx, runId, personaId, message);

	// Skipped when it's already this persona -- the common case, since a student's next
	// message is usually to whoever they're already talking to. A patch invalidates the
	// getSimulationState subscription (services/simulations.ts) regardless of whether any
	// field actually changed, re-pushing the full run state (contacts, photo URLs, shared
	// files) to that student on every message otherwise.
	if (run.activePersonaKey !== personaId) {
		await ctx.db.patch(runId, { activePersonaKey: personaId });
	}
}

// A killed action (a deploy racing an in-flight turn, an enforced max-duration, an OOM) skips
// runTurn's own catch, so its stream is left "streaming" until the component's own 20-minute
// timeout sweep -- claimTurnSlot would refuse every turn on this persona until then.
// LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES (lib/llm.ts) is the worst-case time
// personaReplyStream itself allows before it gives up, so a turn open well past that can only
// mean the process died mid-turn, never that it's still legitimately working. Exported so
// tests can pin behavior right at the boundary without hard-coding a second copy of it.
export const STREAMING_SLOT_STALE_MS =
	LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES + 30_000;

type TurnStreamStatus = "pending" | "streaming" | "done" | "error" | "timeout";

async function streamStatus(
	ctx: QueryCtx | MutationCtx,
	streamId: string,
): Promise<TurnStreamStatus> {
	return await ctx.runQuery(
		components.persistentTextStreaming.lib.getStreamStatus,
		{ streamId },
	);
}

// Starts a new turn on this persona's turnStreams row, rejecting if one is already in flight
// -- this IS the concurrency guard for turns on the same persona (contrast with
// applyBoundary's endReason latch below, kept only as a defensive backstop). Two concurrent
// startTurn calls for the same (runId, personaId) both read and write this exact row, so
// Convex's transaction isolation serializes them: whichever commits second sees the first's
// open stream and is rejected, before it can consume rate-limit budget or start a second
// generation. "In flight" is the component's own stream status, not `settled`: a settled turn
// still has its final chunk to write, and deleting its stream underneath it would fail that
// write. A stream open past STREAMING_SLOT_STALE_MS is reclaimed instead -- see that
// constant's comment.
//
// The previous turn's stream is deleted here, so each persona holds at most one stream: once
// a turn settles its reply lives in runMessages, and the stream only mattered while it was
// live.
async function claimTurnSlot(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	message: string,
): Promise<void> {
	const existing = await ctx.db
		.query("turnStreams")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.first();
	const now = Date.now();
	if (existing) {
		const status = await streamStatus(ctx, existing.streamId);
		const open = status === "pending" || status === "streaming";
		if (open && now - existing.startedAt < STREAMING_SLOT_STALE_MS) {
			throw new Error(
				"A reply is already being generated for this contact. Please wait.",
			);
		}
		await streaming.deleteStream(ctx, existing.streamId as StreamId);
	}
	const turn = {
		streamId: await streaming.createStream(ctx),
		startedAt: now,
		message,
		settled: false,
	};
	if (existing) await ctx.db.patch(existing._id, turn);
	else
		await ctx.db.insert("turnStreams", {
			runId,
			personaKey: personaId,
			...turn,
		});
}

export type ClaimedTurn = {
	turnId: Id<"turnStreams">;
	runId: Id<"runs">;
	personaId: string;
	message: string;
};

// Called by /turn-stream (http.ts) before it starts generating. Taking the message is the
// atomic claim: the component's own stream() only checks "still pending" non-transactionally,
// so two tabs watching the same persona could otherwise both start a generation. Whichever
// commits second finds the message gone and gets null.
export async function claimTurn(
	ctx: MutationCtx,
	streamId: string,
): Promise<ClaimedTurn | null> {
	const row = await ctx.db
		.query("turnStreams")
		.withIndex("by_stream", (q) => q.eq("streamId", streamId))
		.unique();
	if (!row?.message) return null;
	await ctx.db.patch(row._id, { message: undefined });
	return {
		turnId: row._id,
		runId: row.runId,
		personaId: row.personaKey,
		message: row.message,
	};
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
	turnId: Id<"turnStreams">,
): Promise<ChatStateOut> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");

	const previous = getChatState(run.personaChatState, personaId);
	const warningCount = previous.warningCount + 1;
	// startTurn already refuses a turn on a persona whose chat has ended (before
	// claimTurnSlot even claims a slot for it), so this always runs with
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
	await ctx.db.patch(turnId, { settled: true });

	return { ended, endReason: endReason ?? null, warningCount };
}

export type UnlockedReferral = { referredPersonaId: string };
export type SharedFileInput = { fileId: Id<"files"> };

// Persists the reply, any newly-unlocked referrals, and any newly-shared files, all in one
// mutation. Marking the turn settled in this same transaction (here and in applyBoundary) is
// what swaps the client's live bubble for the persisted reply with no gap or duplicate -- see
// getTurnStream. Doesn't also build/return a ContactOut/SharedFileOut payload for an SSE meta
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
	turnId: Id<"turnStreams">,
): Promise<void> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");

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
	await ctx.db.patch(turnId, { settled: true });
}

export type TurnStreamOut = {
	streamId: string;
	status: TurnStreamStatus;
	settled: boolean;
	// No tab has started generating this turn yet -- a client seeing this POSTs the streamId
	// to /turn-stream (http.ts) to drive it; claimTurn makes sure only one does.
	claimable: boolean;
	// The component's persisted copy of the reply so far ("" unless `withText`).
	text: string;
} | null;

// The student's live view of this persona's latest turn. A tab driving the turn reads the
// reply off its own HTTP stream and passes withText=false, so its subscription only re-runs
// on the handful of status changes per turn; any other tab (a reload, a second window) passes
// true and follows the component's sentence-by-sentence persisted copy instead. Deliberately
// its own small query, not part of getSimulationState's RunStateOut, so a turn's writes
// never re-push the whole run state.
export async function getTurnStream(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
	withText: boolean,
): Promise<TurnStreamOut> {
	const row = await ctx.db
		.query("turnStreams")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.first();
	if (!row) return null;
	const turn = {
		streamId: row.streamId,
		settled: row.settled,
		claimable: row.message !== undefined,
	};
	if (!withText || row.settled)
		return { ...turn, status: await streamStatus(ctx, row.streamId), text: "" };
	return {
		...turn,
		...(await streaming.getStreamBody(ctx, row.streamId as StreamId)),
	};
}

export const TURN_FAILED_PREFIX = "Turn failed:";

// The body of /turn-stream (http.ts): runs as the persistentTextStreaming component's stream
// writer, so every `append` goes straight to the driving tab's HTTP response and, at sentence
// boundaries, to the component's persisted copy. Ends by calling applyBoundary or
// applyDecisions (both mutations) to persist the outcome.
//
// Referral/file eligibility is no longer a separate classifier fan-out: the same Sonnet call
// that writes the persona's reply also judges each candidate's condition itself (see
// lib/prompt.ts's systemPrompt), since it already has the full case context a standalone
// classifier never did. classifyHarassment stays its own small, unbiased Haiku call (see its
// own comment in lib/llm.ts for why) -- and since it almost always resolves to "normal", it
// runs CONCURRENTLY with the (much slower) Sonnet reply stream rather than gating it, so the
// common case doesn't pay the classifier's round-trip as extra latency before the reply even
// starts generating. The two are reconciled via `cleared` below: nothing streamed from Sonnet
// is ever appended (and so never shown to the client) until harassment has resolved to
// "normal" -- if it resolves any other way, the Sonnet output is discarded
// entirely and applyBoundary's canned reply is used instead, with no visible flicker either
// way, at the cost of occasionally paying for a Sonnet generation that goes unused.
//
// The same "normal" resolution also gates persisting the student's own message (see
// appendUserMessage): `appendUserMessagePromise` fires the instant the classifier clears, in
// parallel with the still-streaming reply, and is awaited (both on the success path and in the
// catch below) before runTurn returns -- so a flagged message never touches runMessages.
//
// Any throw fails the turn: the component marks the stream "error", which the client turns
// into a "please resend" toast. The catch first takes back the student's message if it was
// already stored (see removeUserMessage for why).
export async function runTurn(
	ctx: ActionCtx,
	{ turnId, runId, personaId, message }: ClaimedTurn,
	append: (text: string) => Promise<void>,
): Promise<void> {
	// Declared outside the try so the catch below can still await it -- a failure partway
	// through the reply stream must not strand this mid-flight (see its own comment).
	let appendUserMessagePromise: Promise<Id<"runMessages"> | null> =
		Promise.resolve(null);
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
		appendUserMessagePromise = harassmentPromise.then(async (label) => {
			if (label !== "normal") return null;
			cleared = true;
			return await ctx.runMutation(internal.api.turn.appendUserMessage, {
				runId,
				personaId,
				message,
			});
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
		let extractor = new ReplyExtractor();
		// Decoded reply text not yet appended -- held back until harassment clears.
		let pending = "";
		let appended = false;
		// context.decisionHistory is already bounded to RECENT_HISTORY_LIMIT at the query level
		// (getTurnContext above), so no further slicing is needed here. It holds only PRIOR
		// turns now -- the current message is appended in-memory rather than fetched back from
		// runMessages, since appendUserMessage (above) may not have written it yet (or, if the
		// classifier flags this message, ever).
		const replyHistory = [
			...context.decisionHistory,
			{ role: "user" as const, content: message },
		];
		for await (const delta of personaReplyStream(
			{ cacheable: cacheableSystemPrompt, dynamic },
			replyHistory,
		)) {
			if (delta.type === "reset") {
				// The stream is retrying after a failed attempt. Appended text can't be taken
				// back (the component's stream is append-only), so the retry is only safe while
				// nothing has been shown yet -- otherwise fail the turn and let the student
				// resend.
				if (appended)
					throw new Error("Reply failed after it started streaming.");
				fullText = "";
				pending = "";
				extractor = new ReplyExtractor();
				continue;
			}
			fullText += delta.text;
			pending += extractor.feed(delta.text);
			if (cleared && pending) {
				await append(pending);
				pending = "";
				appended = true;
			}
		}

		const label = await harassmentPromise;
		// Guaranteed to already be settled by now (it resolves off the same harassmentPromise
		// this just awaited), but awaited explicitly anyway so nothing below can ever run ahead
		// of the user's own message actually landing in runMessages.
		await appendUserMessagePromise;
		if (label !== "normal") {
			await ctx.runMutation(internal.api.turn.applyBoundary, {
				runId,
				personaId,
				label,
				personaName: context.persona.name,
				turnId,
			});
			return;
		}

		if (pending) await append(pending);

		const parsed = parseReply(fullText);
		const reply = cleanReply((parsed?.reply as string | undefined) ?? "");
		// Mirrors turn.py: an empty/unusable reply fails the whole turn (no referral/file
		// unlocks either) rather than persisting a blank assistant bubble.
		if (!reply.trim()) throw new Error("The reply came back empty.");

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
			turnId,
		});
	} catch (err) {
		// Swallow (don't let a failure here shadow the real error below), but still wait for
		// it: classifyHarassment fails open (lib/llm.ts), so it can resolve "normal" and start
		// this write even when the failure below is the reply stream's own fetch throwing --
		// without this await, that write could land after the removal below and survive it.
		const messageId = await appendUserMessagePromise.catch(() => null);
		if (messageId)
			await ctx.runMutation(internal.api.turn.removeUserMessage, { messageId });
		// The component rethrows this from a promise nothing awaits, so it surfaces as an
		// unhandled rejection -- the fixed prefix is what lets vite.config.ts's onUnhandledError
		// tell an expected turn failure apart from a real one.
		throw new Error(
			`${TURN_FAILED_PREFIX} ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
