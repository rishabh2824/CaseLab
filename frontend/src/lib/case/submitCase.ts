import { getConvexClient } from "convex-svelte";
import { makeFunctionReference } from "convex/server";
import { slugify } from "../format.js";
import type { FileRefPayload, Persona, PersonaPayload, ReferralEdge } from "../types.js";
import { normalizePersona } from "./draft.js";

// String-based references (not generated `api` imports): the convex/ project lives at
// the repo root, outside this Vite project's root -- see AdminAuth.svelte for why.
const presignUploadBatchRef = makeFunctionReference<"action">("api/uploads:presignUploadBatch");
const createCaseRef = makeFunctionReference<"mutation">("api/cases:create");
const updateCaseRef = makeFunctionReference<"mutation">("api/cases:update");

// Where one File-valued upload slot (a persona's profile photo, or one of its
// attachments) lives in the persona list, so results can be matched back
// after a single batched presign + concurrent Spaces PUTs.
type UploadTarget =
	| { kind: "photo"; personaIndex: number }
	| { kind: "file"; personaIndex: number; fileIndex: number };

type PendingUpload = {
	target: UploadTarget;
	file: File;
};

type PresignResult = {
	uploadUrl: string;
	objectKey: string;
	fileName: string;
	contentType?: string;
};

// One presign request for every File across every persona (photos and attachments alike)
// -- not one request per file. Shared by both the create and edit save paths below, since
// the underlying Spaces bucket/credentials are the same either way.
async function presignAll(
	uploads: PendingUpload[],
	prefix: string,
): Promise<PresignResult[]> {
	if (uploads.length === 0) return [];
	return await getConvexClient().action(presignUploadBatchRef, {
		files: uploads.map(({ file }) => ({
			fileName: file.name,
			contentType: file.type || undefined,
			prefix,
		})),
	});
}

async function putToSpaces(
	file: File,
	presign: PresignResult,
): Promise<FileRefPayload> {
	const putResponse = await fetch(presign.uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Type": presign.contentType || "application/octet-stream",
		},
		body: file,
	});

	if (!putResponse.ok) throw new Error("Failed to upload file to Spaces.");

	return {
		object_key: presign.objectKey,
		file_name: presign.fileName,
		content_type: presign.contentType,
	};
}

function targetKey(target: UploadTarget): string {
	return target.kind === "photo"
		? `photo:${target.personaIndex}`
		: `file:${target.personaIndex}:${target.fileIndex}`;
}

// Uploads every File-valued profile photo/attachment across every persona:
// one presign round trip for the whole batch, then every Spaces PUT running
// concurrently (not photo-then-attachments, persona by persona in series).
async function uploadAll(
	personas: Persona[],
	prefix: string,
): Promise<Map<string, FileRefPayload>> {
	const uploads: PendingUpload[] = [];
	personas.forEach((persona, personaIndex) => {
		if (persona.profile_photo instanceof File) {
			uploads.push({
				target: { kind: "photo", personaIndex },
				file: persona.profile_photo,
			});
		}
		persona.files.forEach((entry, fileIndex) => {
			if (entry.file instanceof File) {
				uploads.push({
					target: { kind: "file", personaIndex, fileIndex },
					file: entry.file,
				});
			}
		});
	});

	// Consumed as a queue (not indexed by position) so each pairing is
	// type-narrowed by its own `if (!x) throw` rather than an
	// `PresignResult | undefined` from indexing presigns[i]
	// (noUncheckedIndexedAccess) that a separate length check can't narrow away.
	const presignQueue = await presignAll(uploads, prefix);
	const pairs = uploads.map((upload) => {
		const presign = presignQueue.shift();
		if (!presign) throw new Error("Missing presign response for an upload.");
		return { upload, presign };
	});
	const refPairs = await Promise.all(
		pairs.map(async ({ upload, presign }) => ({
			target: upload.target,
			ref: await putToSpaces(upload.file, presign),
		})),
	);

	const results = new Map<string, FileRefPayload>();
	refPairs.forEach(({ target, ref }) => results.set(targetKey(target), ref));
	return results;
}

function buildPersonaPayload(
	persona: Persona,
	personaIndex: number,
	uploaded: Map<string, FileRefPayload>,
): PersonaPayload {
	const profile_photo =
		persona.profile_photo instanceof File
			? (uploaded.get(targetKey({ kind: "photo", personaIndex })) ?? null)
			: persona.profile_photo;
	const files = persona.files.map((entry, fileIndex) => {
		if (!entry.file) return { ...entry, file: null };
		if (entry.file instanceof File) {
			return {
				...entry,
				file:
					uploaded.get(targetKey({ kind: "file", personaIndex, fileIndex })) ??
					null,
			};
		}
		return { ...entry, file: entry.file };
	});
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profile_photo,
		known_facts: persona.known_facts,
		personality_traits: persona.personality_traits,
		availability_minutes: persona.availability_minutes,
		files,
	};
}

export type SubmitCaseInput = {
	isEditMode: boolean;
	editCaseId?: string | null;
	caseName: string;
	initialBrief: string;
	commonInformation: string;
	simulationDurationMinutes: number | null;
	accessCode: string;
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
	// Convex admin ids (see CaseForm.svelte's collaborator picker, now sourced from
	// api/admins:listAll rather than the old backend's numeric ids).
	collaboratorAdminIds: string[];
};

// Uploads any new (File-valued) profile photos/attachments to Spaces, then creates or
// updates the case -- both go through Convex end to end now. Edit has no optimistic-
// concurrency check (no expected-version conflict to handle): two admins saving the same
// case at once is rare enough that last-write-wins is an accepted tradeoff (see
// newBackend/convex/schema.ts's comment on `cases`).
export async function submitCase({
	isEditMode,
	editCaseId,
	caseName,
	initialBrief,
	commonInformation,
	simulationDurationMinutes,
	accessCode,
	personas,
	referrals,
	roots,
	collaboratorAdminIds,
}: SubmitCaseInput): Promise<unknown> {
	const slug = slugify(caseName);
	const prefix = slug ? `cases/${slug}` : "cases";
	const normalizedPersonas = personas.map((persona) => normalizePersona(persona));
	const uploaded = await uploadAll(normalizedPersonas, prefix);
	const personasPayload = normalizedPersonas.map((persona, personaIndex) =>
		buildPersonaPayload(persona, personaIndex, uploaded),
	);
	const referralsPayload = referrals.map((referral) => ({
		from_id: referral.from_id,
		to_id: referral.to_id,
		conditions: referral.conditions,
	}));

	const scalars = {
		name: caseName.trim(),
		brief: initialBrief.trim(),
		commonInformation: commonInformation.trim(),
		duration: simulationDurationMinutes ?? undefined,
		accessCode: accessCode.trim(),
		personas: personasPayload,
		referrals: referralsPayload,
		roots,
		collaboratorAdminIds,
	};

	if (isEditMode) {
		// editCaseId is always set by the time submitCase can run in edit mode -- the
		// submit button stays disabled until loadCase resolves (see CaseForm.svelte).
		return getConvexClient().mutation(updateCaseRef, { caseId: editCaseId as string, ...scalars });
	}

	return getConvexClient().mutation(createCaseRef, scalars);
}
