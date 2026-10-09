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
import type { PersonaPayload } from "../models/cases";
import {
	flattenPersonas,
	graphPersonas,
	graphRootPersonas,
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

export type PersonaPhotoOut = {
	storageId: Id<"_storage">;
	fileName: string;
	contentType: string | null;
	url: string | null;
};

export type ContactOut = {
	id: string;
	name: string;
	role: string;
	profilePhoto: PersonaPhotoOut | null;
	availabilityDuration: number | null;
	availableAt: number;
	isReferred: boolean;
	chatEnded: boolean;
	chatEndReason: string | null;
	warningCount: number;
};

// Builds the student-facing contact for a persona, without exposing its secret fields.
function toContactOut(
	persona: PersonaPayload,
	photoUrl: string | null,
	isReferred: boolean,
	availableAtMinutes: number,
	chatState: ChatStateOut,
): ContactOut {
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profilePhoto: persona.profilePhoto
			? {
					storageId: persona.profilePhoto.storageId,
					fileName: persona.profilePhoto.fileName,
					contentType: persona.profilePhoto.contentType ?? null,
					url: photoUrl,
				}
			: null,
		availabilityDuration: persona.availabilityMinutes,
		availableAt: availableAtMinutes,
		isReferred,
		chatEnded: chatState.ended,
		chatEndReason: chatState.endReason,
		warningCount: chatState.warningCount,
	};
}

// Builds the contact list from root personas followed by unlocked referred personas.
async function buildContacts(
	ctx: QueryCtx | MutationCtx,
	personaChatState: ChatStateMap,
	unlockedAt: Record<string, number>,
	rootPersonas: PersonaPayload[],
	referredPersonas: PersonaPayload[],
): Promise<ContactOut[]> {
	const entries = [
		...rootPersonas.map((persona) => ({
			persona,
			availableAt: 0,
			isReferred: false,
		})),
		...referredPersonas.map((persona) => ({
			persona,
			availableAt: unlockedAt[persona.id] ?? 0,
			isReferred: true,
		})),
	];
	return await Promise.all(
		entries.map(async ({ persona, availableAt, isReferred }) =>
			toContactOut(
				persona,
				persona.profilePhoto
					? await fileUrl(ctx, persona.profilePhoto.storageId)
					: null,
				isReferred,
				availableAt,
				getChatState(personaChatState, persona.id),
			),
		),
	);
}

export type SharedFileOut = {
	fileId: string;
	fileName: string;
	contentType: string | null;
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
		fileId: storageId,
		fileName: fileName ?? "file",
		contentType: stored.contentType ?? null,
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
			q.eq("runId", runId).eq("personaId", personaId),
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
	runId: Id<"runs">;
	case: {
		id: Id<"cases">;
		caseName: string;
		brief: string;
		simulationDuration: number | null;
	};
	contacts: ContactOut[];
	sharedFiles: SharedFileOut[];
};

// Starts a run for an access code and schedules its destruction. The run state is read with getSimulationState.
export async function startSimulation(
	ctx: MutationCtx,
	accessCodeRaw: string,
): Promise<{ runId: Id<"runs"> }> {
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

	return { runId: runId };
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
	const contacts = await buildContacts(
		ctx,
		run.personaChatState,
		run.unlockedAt,
		graphRootPersonas(graph),
		graphPersonas(
			graph,
			referredContactIds(graph, Object.keys(run.unlockedAt)),
		),
	);
	const fileNames = new Map(
		c.structure.personas.flatMap((persona) =>
			persona.files.flatMap((entry) =>
				entry.file
					? [[entry.file.storageId, entry.file.fileName] as const]
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
		runId: runId,
		case: {
			id: c._id,
			caseName: c.name,
			brief: c.brief,
			simulationDuration: c.duration ?? null,
		},
		contacts,
		sharedFiles: sharedFiles,
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
	case: { id: Id<"cases">; caseName: string };
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

	return { case: { id: c._id, caseName: c.name }, personas };
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
