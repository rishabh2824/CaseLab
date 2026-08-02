import { apiFetch } from "../api/client.js";
import { slugify } from "../student/Helpers.js";
import type {
	CaseCreatedResponse,
	CasePayload,
	CaseUpdatePayload,
	DraftFileEntry,
	FileEntry,
	FileRef,
	Persona,
	PersonaPayload,
	PresignUploadRequest,
	PresignUploadResponse,
	ReferralEdge,
} from "../types.js";
import { normalizePersona } from "./Helpers.js";

async function uploadFile(file: File, prefix: string): Promise<FileRef> {
	const presign = await apiFetch<PresignUploadResponse>(
		"/api/uploads/presign",
		{
			method: "POST",
			body: {
				file_name: file.name,
				content_type: file.type || null,
				prefix,
			} satisfies PresignUploadRequest,
		},
	);

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

async function normalizeFileEntry(
	entry: DraftFileEntry,
	prefix: string,
): Promise<FileEntry> {
	if (!entry.file) return { ...entry, file: null };
	if (entry.file instanceof File)
		return { ...entry, file: await uploadFile(entry.file, prefix) };
	return { ...entry, file: entry.file };
}

async function normalizeProfilePhoto(
	profilePhoto: File | FileRef | null,
	prefix: string,
): Promise<FileRef | null> {
	if (!profilePhoto) return null;
	if (profilePhoto instanceof File) return uploadFile(profilePhoto, prefix);
	return profilePhoto;
}

async function buildPersonaPayload(
	persona: Partial<Persona>,
	prefix: string,
): Promise<PersonaPayload> {
	const normalized = normalizePersona(persona);
	const profile_photo = await normalizeProfilePhoto(
		normalized.profile_photo,
		prefix,
	);
	const files = await Promise.all(
		(normalized.files ?? []).map((entry) => normalizeFileEntry(entry, prefix)),
	);
	return {
		id: normalized.id,
		name: normalized.name,
		role: normalized.role,
		profile_photo,
		known_facts: normalized.known_facts,
		personality_traits: normalized.personality_traits,
		availability_minutes: normalized.availability_minutes,
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
}: SubmitCaseInput): Promise<CaseCreatedResponse> {
	const slug = slugify(caseName);
	const prefix = slug ? `cases/${slug}` : "cases";
	const personasPayload = await Promise.all(
		personas.map((persona) => buildPersonaPayload(persona, prefix)),
	);
	const basePayload = {
		case_name: caseName.trim(),
		initial_brief: initialBrief.trim(),
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
	const payload: CasePayload | CaseUpdatePayload = isEditMode
		? ({
				...basePayload,
				// The submit button is disabled while isEditMode is true and
				// expectedVersion hasn't loaded yet (see CaseForm.svelte), so
				// this is always a number by the time submitCase can run.
				expected_version: expectedVersion as number,
			} satisfies CaseUpdatePayload)
		: (basePayload satisfies CasePayload);
	return apiFetch<CaseCreatedResponse>(
		isEditMode ? `/api/cases/${editCaseId}` : "/api/cases",
		{
			method: isEditMode ? "PUT" : "POST",
			body: payload,
		},
	);
}
