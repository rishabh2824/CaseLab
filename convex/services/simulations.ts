import type { StreamId } from "@convex-dev/persistent-text-streaming";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { RUN_LIFETIME_MINUTES } from "../lib/constants";
import { streaming } from "../lib/streaming";
import { STUDENT_ERROR, studentError } from "../lib/studentErrors";
import {
	type ChatStateMap,
	type ChatStateOut,
	getChatState,
} from "../lib/turnState";
import {
	flattenPersonas,
	graphPersonas,
	graphRootPersonas,
	type PersonaDetail,
	referredContactIds,
} from "./simulationReads";

const GRACE_PERIOD_MINUTES = 15;

// Trims and lower-cases a student's access code.
function normalizeAccessCode(raw: string): string {
	return raw.trim().toLowerCase();
}

// Computes when a run expires: duration plus grace period, capped at the run lifetime.
function computeExpiresAt(
	startTime: number,
	durationMinutes: number | undefined,
): number {
	const capMs = RUN_LIFETIME_MINUTES * 60_000;
	const ttlMs = durationMinutes
		? Math.min((durationMinutes + GRACE_PERIOD_MINUTES) * 60_000, capMs)
		: capMs;
	return startTime + ttlMs;
}

// Returns the storage URL for a stored file, or null if it no longer exists.
async function fileUrl(
	ctx: QueryCtx | MutationCtx,
	storageId: Id<"_storage">,
): Promise<string | null> {
	return await ctx.storage.getUrl(storageId);
}

// Adds the profile photo URL to a persona when it has a photo.
async function hydratePersona(
	ctx: QueryCtx | MutationCtx,
	persona: PersonaDetail,
): Promise<PersonaDetail> {
	if (!persona.profilePhoto) return persona;
	return {
		...persona,
		profilePhotoUrl: await fileUrl(ctx, persona.profilePhoto.storage_id),
	};
}

export type PersonaPhotoOut = {
	storage_id: Id<"_storage">;
	file_name: string;
	content_type: string | null;
	url: string | null;
};

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

// Builds the student-facing contact for a persona, without exposing its secret fields.
function toContactOut(
	persona: PersonaDetail,
	availableAtMinutes: number,
	chatState: ChatStateOut,
): ContactOut {
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profile_photo: persona.profilePhoto
			? {
					storage_id: persona.profilePhoto.storage_id,
					file_name: persona.profilePhoto.file_name,
					content_type: persona.profilePhoto.content_type ?? null,
					url: persona.profilePhotoUrl,
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

// Builds the contact list from root personas followed by unlocked referred personas.
function buildContacts(
	personaChatState: ChatStateMap,
	unlockedAt: Record<string, number>,
	rootPersonas: PersonaDetail[],
	referredPersonas: PersonaDetail[] = [],
): ContactOut[] {
	const entries = [
		...rootPersonas.map((persona) => ({ persona, availableAt: 0 })),
		...referredPersonas.map((persona) => ({
			persona,
			availableAt: unlockedAt[persona.id] ?? 0,
		})),
	];
	return entries.map(({ persona, availableAt }) =>
		toContactOut(
			persona,
			availableAt,
			getChatState(personaChatState, persona.id),
		),
	);
}

export type SharedFileOut = {
	file_id: string;
	file_name: string;
	content_type: string | null;
	url: string | null;
};

// Builds the student-facing shared file with its URL, or null if the file is gone.
async function toSharedFileOut(
	ctx: QueryCtx | MutationCtx,
	fileId: Id<"files">,
): Promise<SharedFileOut | null> {
	const file = await ctx.db.get(fileId);
	if (!file) return null;
	return {
		file_id: fileId,
		file_name: file.name,
		content_type: file.contentType ?? null,
		url: await fileUrl(ctx, file.storageId),
	};
}

export type ChatMessageOut = { role: "user" | "assistant"; content: string };

// Loads a persona's chat messages for a run as role/content pairs.
async function queryPersonaMessages(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<ChatMessageOut[]> {
	const rows = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.collect();
	return rows.map((row) => ({ role: row.role, content: row.content }));
}

export type RunStateOut = {
	run_id: Id<"runs">;
	case: {
		id: Id<"cases">;
		case_name: string;
		brief: string;
		simulation_duration: number | null;
	};
	contacts: ContactOut[];
	shared_files: SharedFileOut[];
};

// Starts a run for an access code, schedules its destruction and returns its initial state.
export async function startSimulation(
	ctx: MutationCtx,
	accessCodeRaw: string,
): Promise<RunStateOut> {
	const accessCode = normalizeAccessCode(accessCodeRaw);
	if (!accessCode)
		throw studentError(
			STUDENT_ERROR.ACCESS_CODE_REQUIRED,
			"Access code is required.",
		);
	const c = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", accessCode))
		.first();
	if (!c)
		throw studentError(
			STUDENT_ERROR.INVALID_ACCESS_CODE,
			"Invalid access code.",
		);

	const graph = flattenPersonas(c.structure);
	if (graph.roots.length === 0)
		throw studentError(
			STUDENT_ERROR.NO_PERSONAS,
			"This case has no personas configured.",
		);
	const rootPersonas = await Promise.all(
		graphRootPersonas(graph).map((persona) => hydratePersona(ctx, persona)),
	);

	const contacts = buildContacts({}, {}, rootPersonas);

	const startTime = Date.now();
	const expiresAt = computeExpiresAt(startTime, c.duration);
	const runId = await ctx.db.insert("runs", {
		caseId: c._id,
		expiresAt,
		unlockedAt: {},
		sharedFiles: [],
		personaChatState: {},
	});
	await ctx.scheduler.runAt(expiresAt, internal.api.simulations.destroy, {
		runId,
	});

	return {
		run_id: runId,
		case: {
			id: c._id,
			case_name: c.name,
			brief: c.brief,
			simulation_duration: c.duration ?? null,
		},
		contacts,
		shared_files: [],
	};
}

// Loads a run and its case, throwing student errors if the run is missing, expired or orphaned.
export async function loadLiveRun(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const run = await ctx.db.get(runId);
	if (!run) throw studentError(STUDENT_ERROR.RUN_NOT_FOUND, "Run not found.");
	if (Date.now() > run.expiresAt)
		throw studentError(STUDENT_ERROR.RUN_EXPIRED, "Run expired.");
	const c = await ctx.db.get(run.caseId);
	if (!c) throw studentError(STUDENT_ERROR.CASE_NOT_FOUND, "Case not found.");
	return { run, c };
}

// Returns a live run's case summary, contacts and shared files.
export async function getSimulationState(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<RunStateOut> {
	const { run, c } = await loadLiveRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const rootPersonas = await Promise.all(
		graphRootPersonas(graph).map((persona) => hydratePersona(ctx, persona)),
	);
	const referredPersonas = await Promise.all(
		graphPersonas(
			graph,
			referredContactIds(graph, Object.keys(run.unlockedAt)),
		).map((persona) => hydratePersona(ctx, persona)),
	);
	const contacts = buildContacts(
		run.personaChatState,
		run.unlockedAt,
		rootPersonas,
		referredPersonas,
	);
	const sharedFiles = (
		await Promise.all(
			run.sharedFiles.map((fileId) => toSharedFileOut(ctx, fileId)),
		)
	).filter((file): file is SharedFileOut => file !== null);

	return {
		run_id: runId,
		case: {
			id: c._id,
			case_name: c.name,
			brief: c.brief,
			simulation_duration: c.duration ?? null,
		},
		contacts,
		shared_files: sharedFiles,
	};
}

// Returns the chat history between the student and one persona.
export async function getPersonaHistory(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<ChatMessageOut[]> {
	return await queryPersonaMessages(ctx, runId, personaId);
}

export type ExportPersonaOut = {
	id: string;
	name: string;
	role: string;
	messages: ChatMessageOut[];
};
export type ExportSimulationOut = {
	case: { id: Id<"cases">; case_name: string };
	personas: ExportPersonaOut[];
};

// Returns every unlocked persona's transcript for export, roots first then referred by unlock time.
export async function exportSimulation(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<ExportSimulationOut> {
	const { run, c } = await loadLiveRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const referredIds = referredContactIds(
		graph,
		Object.keys(run.unlockedAt),
	).sort((a, b) => (run.unlockedAt[a] ?? 0) - (run.unlockedAt[b] ?? 0));
	const personaIds = [...graph.roots, ...referredIds];

	const personas = await Promise.all(
		personaIds.map(async (personaId): Promise<ExportPersonaOut> => {
			const persona = graph.personas.get(personaId);
			const messages = await queryPersonaMessages(ctx, runId, personaId);
			return {
				id: personaId,
				name: persona?.name ?? "",
				role: persona?.role ?? "",
				messages,
			};
		}),
	);

	return { case: { id: c._id, case_name: c.name }, personas };
}

// Deletes a run together with its messages and turn streams; safe to call on a missing run.
export async function deleteRunCascade(
	ctx: MutationCtx,
	runId: Id<"runs">,
): Promise<void> {
	if ((await ctx.db.get(runId)) === null) return;

	const messages = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId))
		.collect();
	for (const message of messages) await ctx.db.delete(message._id);

	const turns = await ctx.db
		.query("turnStreams")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId))
		.collect();
	for (const turn of turns) {
		await streaming.deleteStream(ctx, turn.streamId as StreamId);
		await ctx.db.delete(turn._id);
	}

	await ctx.db.delete(runId);
}
