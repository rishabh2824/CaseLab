import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { simulationLimit } from "../lib/rateLimits";
import { type ChatStateMap, type ChatStateOut, getChatState, personaAvailability } from "../lib/turnState";
import {
	flattenPersonas,
	graphPersonaById,
	graphPersonas,
	graphRootPersonas,
	type PersonaDetail,
} from "./simulationReads";

// Mirrors backend/domain_constants.py's SIMULATION_DURATION -- the cap on how long a run
// can live even when a case sets no duration.
const RUN_LIFETIME_MINUTES = 120;
// Mirrors backend/services/simulation/run_store.py's GRACE_PERIOD: extra time tacked onto
// a case's configured duration so students can finish up chat after time is "up".
const GRACE_PERIOD_MINUTES = 15;

function normalizeAccessCode(raw: string): string {
	return raw.trim().toLowerCase();
}

// Mirrors backend/services/simulation/run_store.py's expiry().
function computeExpiresAt(startTime: number, durationMinutes: number | undefined): number {
	const capMs = RUN_LIFETIME_MINUTES * 60_000;
	const ttlMs = durationMinutes ? Math.min((durationMinutes + GRACE_PERIOD_MINUTES) * 60_000, capMs) : capMs;
	return startTime + ttlMs;
}

// Mirrors backend/services/simulation/state.py's hydratePersona. The persona graph
// (simulationReads.ts) stores each photo as a raw file reference, never a URL -- this
// re-derives the stable /files/:objectKey path (see http.ts) at read time from that
// reference. `process.env.CONVEX_SITE_URL` is a built-in Convex deployment variable, not
// one we configure ourselves.
function fileUrl(objectKey: string): string {
	const siteUrl = process.env.CONVEX_SITE_URL;
	if (!siteUrl) throw new Error("Missing required environment variable: CONVEX_SITE_URL");
	return `${siteUrl}/files/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

function hydratePersona(persona: PersonaDetail): PersonaDetail {
	if (!persona.profilePhoto) return persona;
	return { ...persona, profilePhotoUrl: fileUrl(persona.profilePhoto.object_key) };
}

export type PersonaPhotoOut = {
	file_id: string | null;
	object_key: string;
	file_name: string;
	content_type: string | null;
	url: string;
};

// Deliberately carries raw timing (available_at) rather than a derived available/
// available_in/expires_in triple -- the earlier design baked those into this payload at
// query-evaluation time via personaAvailability(..., Date.now()), which is wrong for a
// Convex query specifically: a subscription only ever re-runs when its underlying DATA
// changes, never on elapsed wall-clock time alone. That meant a persona's availability
// window silently never expired, and "available in N min" never ticked down, until some
// unrelated write happened to re-trigger the query. The frontend (run.svelte.ts) now
// computes available/available_in/expires_in itself, against its own ticking clock, using
// the same personaAvailability logic mirrored client-side (frontend/src/lib/student/
// availability.ts) -- the run-expiry path never had this problem, because the scheduled
// `destroy` (api/simulations.ts) is itself a WRITE that invalidates the query.
export type ContactOut = {
	id: string;
	name: string;
	role: string;
	profile_photo: PersonaPhotoOut | null;
	availability_duration: number | null;
	available_at: number;
	is_referred: boolean;
	chat_ended: boolean;
	chat_end_reason: string | null;
	warning_count: number;
};

function toContactOut(persona: PersonaDetail, availableAtMinutes: number, chatState: ChatStateOut): ContactOut {
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profile_photo: persona.profilePhoto
			? {
					file_id: persona.profilePhoto.file_id ?? null,
					object_key: persona.profilePhoto.object_key,
					file_name: persona.profilePhoto.file_name,
					content_type: persona.profilePhoto.content_type ?? null,
					url: persona.profilePhotoUrl ?? "",
				}
			: null,
		availability_duration: persona.availabilityDuration,
		available_at: availableAtMinutes,
		is_referred: persona.isReferred,
		chat_ended: chatState.ended,
		chat_end_reason: chatState.endReason,
		warning_count: chatState.warningCount,
	};
}

// Mirrors backend/services/simulation/state.py's buildContacts: every root persona (always
// available from minute 0), plus every unlocked referred persona (available from whenever
// it was unlocked). Takes the run's chat-state/unlock-time maps directly (not a full run
// doc) so startSimulation can call this while still deciding a brand-new run's initial
// contacts, before any row exists. No `elapsed` parameter -- unlike the old version, this no
// longer needs "now" at all; it just reports each persona's fixed available_at minute and
// lets the caller (or, for a live run, the frontend) compare that against elapsed time.
function buildContacts(
	personaChatState: ChatStateMap,
	unlockedAt: Record<string, number>,
	rootPersonas: PersonaDetail[],
	referredPersonas: PersonaDetail[] = [],
): ContactOut[] {
	const entries = [
		...rootPersonas.map((persona) => ({ persona, availableAt: 0 })),
		...referredPersonas.map((persona) => ({ persona, availableAt: unlockedAt[persona.id] ?? 0 })),
	];
	return entries.map(({ persona, availableAt }) =>
		toContactOut(persona, availableAt, getChatState(personaChatState, persona.id)),
	);
}

export type SharedFileOut = { file_id: string; file_name: string; content_type: string | null; url: string };

// Mirrors backend/services/simulation/state.py's toSharedFileOut.
function toSharedFileOut(record: Doc<"runs">["sharedFiles"][string]): SharedFileOut {
	return {
		file_id: record.fileId,
		file_name: record.fileName,
		content_type: record.contentType ?? null,
		url: fileUrl(record.objectKey),
	};
}

export type ChatMessageOut = { role: "user" | "assistant"; content: string };

// Shared by exportSimulation and getPersonaHistory below.
async function queryPersonaMessages(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<ChatMessageOut[]> {
	const rows = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId).eq("personaKey", personaId))
		.collect();
	return rows.map((row) => ({ role: row.role, content: row.content }));
}

// Deliberately carries no `histories` map -- the earlier design folded every visible
// persona's full transcript into this same reactive query, so every new message (any
// persona, not just the one the student is looking at) re-pushed EVERY persona's entire
// history to every subscriber: a 5-persona/40-message run re-reads and re-ships ~200
// documents per turn to deliver the one new message that actually changed. The frontend only
// ever renders one persona's messages at a time (the active chat panel) and export goes
// through the separate exportRun query below, which legitimately needs everyone's transcript
// at once -- so getPersonaHistory (below) is its own scoped query instead, the same
// reasoning as services/turn.ts's streamingReplies being its own table rather than a field
// on this one.
export type RunStateOut = {
	run_id: Id<"runs">;
	case: { id: Id<"cases">; case_name: string; brief: string; simulation_duration: number | null };
	contacts: ContactOut[];
	active_persona_id: string;
	shared_files: SharedFileOut[];
};

// Mirrors backend/services/simulation/state.py's startSimulation.
export async function startSimulation(ctx: MutationCtx, accessCodeRaw: string): Promise<RunStateOut> {
	const accessCode = normalizeAccessCode(accessCodeRaw);
	if (!accessCode) throw new Error("Access code is required.");
	await simulationLimit(ctx, accessCode);
	const c = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", accessCode))
		.first();
	if (!c) throw new Error("Invalid access code.");

	const graph = flattenPersonas(c.structure);
	if (graph.roots.length === 0) throw new Error("This case has no personas configured.");
	const rootPersonas = graphRootPersonas(graph).map(hydratePersona);

	// A brand-new run is 0 minutes into its own timeline by definition -- every root persona
	// is available_at 0, so the first one that's actually reachable this instant (hasn't
	// already expired its own availability window at elapsed=0, an edge case but one
	// personaAvailability already handles) becomes active.
	const contacts = buildContacts({}, {}, rootPersonas);
	const activePersonaKey =
		rootPersonas.find((persona) => personaAvailability(persona.availabilityDuration, 0, 0).available)?.id ??
		rootPersonas[0].id;

	const startTime = Date.now();
	const expiresAt = computeExpiresAt(startTime, c.duration);
	const runId = await ctx.db.insert("runs", {
		caseId: c._id,
		startTime,
		expiresAt,
		activePersonaKey,
		unlockedReferredIds: [],
		unlockedAt: {},
		sharedFiles: {},
		personaChatState: {},
	});
	const destroyJobId = await ctx.scheduler.runAt(expiresAt, internal.api.simulations.destroy, { runId });
	await ctx.db.patch(runId, { destroyJobId });

	return {
		run_id: runId,
		case: { id: c._id, case_name: c.name, brief: c.brief, simulation_duration: c.duration ?? null },
		contacts,
		active_persona_id: activePersonaKey,
		shared_files: [],
	};
}

// Shared by getSimulationState/exportSimulation below, and by services/turn.ts. A read
// never deletes an expired row -- the scheduled `destroy` job (see api/simulations.ts) owns
// that, same rationale as the old backend's getRun.
export async function loadLiveRun(ctx: QueryCtx, runId: Id<"runs">): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");
	if (Date.now() > run.expiresAt) throw new Error("Run expired.");
	const c = await ctx.db.get(run.caseId);
	if (!c) throw new Error("Case not found.");
	return { run, c };
}

// Mirrors backend/services/simulation/state.py's getSimulationState, minus the per-persona
// histories it used to also return -- see RunStateOut's own comment for why.
export async function getSimulationState(ctx: QueryCtx, runId: Id<"runs">): Promise<RunStateOut> {
	const { run, c } = await loadLiveRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const rootPersonas = graphRootPersonas(graph).map(hydratePersona);
	const referredPersonas = graphPersonas(graph, run.unlockedReferredIds).map(hydratePersona);
	const contacts = buildContacts(run.personaChatState, run.unlockedAt, rootPersonas, referredPersonas);
	const sharedFiles = Object.values(run.sharedFiles).map(toSharedFileOut);

	return {
		run_id: runId,
		case: { id: c._id, case_name: c.name, brief: c.brief, simulation_duration: c.duration ?? null },
		contacts,
		active_persona_id: run.activePersonaKey,
		shared_files: sharedFiles,
	};
}

// Scoped to a single persona's transcript -- what the frontend (run.svelte.ts) subscribes to
// for whichever contact's chat panel is currently open, instead of a `histories` map on
// getSimulationState above. A turn landing for persona A no longer re-pushes persona B..E's
// entire histories to a client only looking at A; each persona's messages only get re-sent
// to a client actually subscribed to that persona. Not run through loadLiveRun -- same as
// getStreamingPreview (services/turn.ts), whose expiry/not-found errors already surface via
// the getSimulationState subscription every client also holds.
export async function getPersonaHistory(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<ChatMessageOut[]> {
	return await queryPersonaMessages(ctx, runId, personaId);
}

export type ExportPersonaOut = { id: string; name: string; role: string; messages: ChatMessageOut[] };
export type ExportSimulationOut = {
	case: { id: Id<"cases">; case_name: string };
	personas: ExportPersonaOut[];
};

// Mirrors backend/services/simulation/state.py's exportSimulation: every root persona, plus
// every referred persona unlocked so far (oldest-unlocked first), each carrying its full
// user/assistant transcript. `run.unlockedReferredIds` is populated by services/turn.ts's
// applyDecisions as referrals unlock over the course of a run.
export async function exportSimulation(ctx: QueryCtx, runId: Id<"runs">): Promise<ExportSimulationOut> {
	const { run, c } = await loadLiveRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const referredIds = [...run.unlockedReferredIds].sort(
		(a, b) => (run.unlockedAt[a] ?? 0) - (run.unlockedAt[b] ?? 0),
	);
	const personaIds = [...graph.roots, ...referredIds];

	const personas = await Promise.all(
		personaIds.map(async (personaId): Promise<ExportPersonaOut> => {
			const persona = graphPersonaById(graph, personaId);
			const messages = await queryPersonaMessages(ctx, runId, personaId);
			return { id: personaId, name: persona?.name ?? "", role: persona?.role ?? "", messages };
		}),
	);

	return { case: { id: c._id, case_name: c.name }, personas };
}

// Deletes every row scoped to a run -- its messages and any in-progress streaming-preview
// row -- before the run document itself. Convex has no FK cascade the way Postgres did, so
// this has to be explicit: without it, a deleted run's runMessages/streamingReplies rows are
// unreachable (nothing can look them up by runId once the run is gone) but never actually
// removed, the same class of leak the migration plan called out for files. Both `destroy`
// (api/simulations.ts, the primary per-run expiry path) and deleteExpiredRuns below (the
// backstop sweep) call this instead of deleting the run row directly.
export async function deleteRunCascade(ctx: MutationCtx, runId: Id<"runs">): Promise<void> {
	const messages = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId))
		.collect();
	for (const message of messages) await ctx.db.delete(message._id);

	const streamingRows = await ctx.db
		.query("streamingReplies")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId))
		.collect();
	for (const row of streamingRows) await ctx.db.delete(row._id);

	await ctx.db.delete(runId);
}

// Mirrors backend/services/simulation/run_store.py's deleteRuns: a backstop sweep for any
// run whose scheduled `destroy` job (see startSimulation above and api/simulations.ts) was
// somehow lost -- e.g. a deploy that raced the scheduler, or a transient scheduler failure.
// Every run is normally deleted precisely at its own expiresAt by that job, so this finds
// nothing in the common case; api/simulations.ts's weekly cron is what actually calls it.
export async function deleteExpiredRuns(ctx: MutationCtx): Promise<number> {
	const now = Date.now();
	const expired = await ctx.db
		.query("runs")
		.withIndex("by_expiry", (q) => q.lt("expiresAt", now))
		.collect();
	for (const run of expired) await deleteRunCascade(ctx, run._id);
	return expired.length;
}
