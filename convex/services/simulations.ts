import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { RUN_LIFETIME_MINUTES } from "../lib/constants";
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

// Builds the student-facing shared file with its URL, or null if the upload is gone.
async function toSharedFileOut(
	ctx: QueryCtx | MutationCtx,
	storageId: Id<"_storage">,
	fileName: string | undefined,
): Promise<SharedFileOut | null> {
	const stored = await ctx.db.system.get("_storage", storageId);
	if (!stored) return null;
	return {
		file_id: storageId,
		file_name: fileName ?? "file",
		content_type: stored.contentType ?? null,
		url: await fileUrl(ctx, storageId),
	};
}

export type ChatMessageOut = { role: "user" | "assistant"; content: string };
export type ReplyStatusOut = {
	id: Id<"runMessages">;
	status: "pending" | "done" | "failed";
} | null;

// Loads a persona's message rows for a run, oldest first.
async function queryPersonaRows(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<Doc<"runMessages">[]> {
	return await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.collect();
}

// Reduces message rows to role/content pairs, hiding pending and failed replies.
function toChatMessages(rows: Doc<"runMessages">[]): ChatMessageOut[] {
	return rows
		.filter((row) => row.role === "user" || row.status === "done")
		.map((row) => ({ role: row.role, content: row.content }));
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

// Starts a run for an access code and schedules its destruction. The run state is read with getSimulationState.
export async function startSimulation(
	ctx: MutationCtx,
	accessCodeRaw: string,
): Promise<{ run_id: Id<"runs"> }> {
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

	return { run_id: runId };
}

// Loads a run and its case, throwing student errors if the run or its case is missing. Reads no clock, so it is safe in queries: the scheduled destroy is what ends a run.
export async function loadRun(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const run = await ctx.db.get(runId);
	if (!run) throw studentError(STUDENT_ERROR.RUN_NOT_FOUND, "Run not found.");
	const c = await ctx.db.get(run.caseId);
	if (!c) throw studentError(STUDENT_ERROR.CASE_NOT_FOUND, "Case not found.");
	return { run, c };
}

// Like loadRun, but also rejects a run past its expiry, covering the gap before the scheduled destroy fires. Mutations only.
export async function loadLiveRun(
	ctx: MutationCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const loaded = await loadRun(ctx, runId);
	if (Date.now() > loaded.run.expiresAt)
		throw studentError(STUDENT_ERROR.RUN_EXPIRED, "Run expired.");
	return loaded;
}

// Returns a run's case summary, contacts and shared files.
export async function getSimulationState(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<RunStateOut> {
	const { run, c } = await loadRun(ctx, runId);
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
	const fileNames = new Map(
		c.structure.personas.flatMap((persona) =>
			persona.files.flatMap((entry) =>
				entry.file
					? [[entry.file.storage_id, entry.file.file_name] as const]
					: [],
			),
		),
	);
	const sharedFiles = (
		await Promise.all(
			run.sharedFiles.map((storageId) =>
				toSharedFileOut(ctx, storageId, fileNames.get(storageId)),
			),
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

// Returns the chat history between the student and one persona, plus the state of the latest reply.
export async function getPersonaHistory(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<{ messages: ChatMessageOut[]; reply: ReplyStatusOut }> {
	const rows = await queryPersonaRows(ctx, runId, personaId);
	const last = rows.at(-1);
	return {
		messages: toChatMessages(rows),
		reply:
			last?.role === "assistant" ? { id: last._id, status: last.status } : null,
	};
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
	const { run, c } = await loadRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const referredIds = referredContactIds(
		graph,
		Object.keys(run.unlockedAt),
	).sort((a, b) => (run.unlockedAt[a] ?? 0) - (run.unlockedAt[b] ?? 0));
	const personaIds = [...graph.roots, ...referredIds];

	const personas = await Promise.all(
		personaIds.map(async (personaId): Promise<ExportPersonaOut> => {
			const persona = graph.personas.get(personaId);
			const rows = await queryPersonaRows(ctx, runId, personaId);
			const last = rows.at(-1);
			// A student message whose reply is still pending is left out of the export.
			const messages = toChatMessages(
				last?.role === "assistant" && last.status === "pending"
					? rows.slice(0, -2)
					: rows,
			);
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

// Deletes a run together with its messages; safe to call on a missing run.
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

	await ctx.db.delete(runId);
}
