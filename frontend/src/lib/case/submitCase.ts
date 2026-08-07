import { apiFetch } from "../api/client.js";
import { slugify } from "../format.js";
import type { Api, Persona, ReferralEdge } from "../types.js";
import { normalizePersona } from "./draft.js";

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

// One presign request for every File across every persona (photos and
// attachments alike) — not one request per file. getCurrentAdmin's JWT
// decode + admin DB lookup (backend/api/dependencies.py) is paid once for
// the whole case save; generate_presigned_url itself is a local signing
// computation with no Spaces round trip, so batching it is free.
async function presignAll(
	uploads: PendingUpload[],
	prefix: string,
): Promise<Api<"PresignUploadResponse">[]> {
	if (uploads.length === 0) return [];
	const response = await apiFetch<Api<"PresignUploadBatchResponse">>(
		"/api/uploads/presign/batch",
		{
			method: "POST",
			body: {
				files: uploads.map(({ file }) => ({
					file_name: file.name,
					content_type: file.type || null,
					prefix,
				})),
			} satisfies Api<"PresignUploadBatchRequest">,
		},
	);
	return response.files;
}

async function putToSpaces(
	file: File,
	presign: Api<"PresignUploadResponse">,
): Promise<Api<"FileRef">> {
	const putResponse = await fetch(presign.upload_url, {
		method: "PUT",
		headers: {
			"Content-Type": presign.content_type || "application/octet-stream",
		},
		body: file,
	});

	if (!putResponse.ok) throw new Error("Failed to upload file to Spaces.");

	return {
		object_key: presign.object_key,
		file_name: presign.file_name,
		content_type: presign.content_type,
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
): Promise<Map<string, Api<"FileRef">>> {
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
	// `Api<"PresignUploadResponse"> | undefined` from indexing presigns[i]
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

	const results = new Map<string, Api<"FileRef">>();
	refPairs.forEach(({ target, ref }) => results.set(targetKey(target), ref));
	return results;
}

function buildPersonaPayload(
	persona: Persona,
	personaIndex: number,
	uploaded: Map<string, Api<"FileRef">>,
): Api<"PersonaPayload"> {
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
	collaboratorAdminIds: number[];
	// Required in edit mode (the version the form loaded, for the optimistic
	// concurrency check) — unused when creating a brand-new case.
	expectedVersion?: number;
};

// Uploads any new (File-valued) profile photos/attachments to Spaces, then creates or updates the case.
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
	expectedVersion,
}: SubmitCaseInput): Promise<Api<"CaseCreatedResponse">> {
	const slug = slugify(caseName);
	const prefix = slug ? `cases/${slug}` : "cases";
	const normalizedPersonas = personas.map((persona) => normalizePersona(persona));
	const uploaded = await uploadAll(normalizedPersonas, prefix);
	const personasPayload = normalizedPersonas.map((persona, personaIndex) =>
		buildPersonaPayload(persona, personaIndex, uploaded),
	);
	const basePayload = {
		case_name: caseName.trim(),
		brief: initialBrief.trim(),
		common_information: commonInformation.trim(),
		simulation_duration: simulationDurationMinutes,
		access_code: accessCode.trim(),
		personas: personasPayload,
		referrals: referrals.map((referral) => ({
			from_id: referral.from_id,
			to_id: referral.to_id,
			conditions: referral.conditions,
		})),
		roots,
		collaborator_admin_ids: collaboratorAdminIds,
	};
	const payload: Api<"CasePayload"> | Api<"CaseUpdatePayload"> = isEditMode
		? ({
				...basePayload,
				// The submit button is disabled while isEditMode is true and
				// expectedVersion hasn't loaded yet (see CaseForm.svelte), so
				// this is always a number by the time submitCase can run.
				expected_version: expectedVersion as number,
			} satisfies Api<"CaseUpdatePayload">)
		: (basePayload satisfies Api<"CasePayload">);
	return apiFetch<Api<"CaseCreatedResponse">>(
		isEditMode ? `/api/cases/${editCaseId}` : "/api/cases",
		{
			method: isEditMode ? "PUT" : "POST",
			body: payload,
		},
	);
}
