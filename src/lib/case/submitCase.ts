import type { GenericId } from "convex/values";
import { getConvexClient } from "convex-svelte";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import type {
	FileRefPayload,
	Persona,
	PersonaPayload,
	ReferralEdge,
} from "../types.js";

// FileRefPayload is nullable (an unset ref), but a just-uploaded file always resolves to a
// real ref -- narrowed here once so every reader of `uploaded` below isn't left re-guarding
// against a null this map never actually holds.
type UploadedFileRef = Exclude<FileRefPayload, null>;

// One request for every File across every persona (photos and attachments alike) -- not one
// request per file. Shared by both the create and edit save paths below. A Convex upload URL
// carries no file metadata -- it's generated and consumed once, with the file's own name/
// content type attached separately when Convex resolves the upload -- so this is just "give
// me N URLs," paying the admin auth check once per case save instead of once per file.
async function generateUploadUrls(count: number): Promise<string[]> {
	if (count === 0) return [];
	return await getConvexClient().mutation(api.api.uploads.generateUploadUrls, {
		count,
	});
}

async function putToConvexStorage(
	file: File,
	uploadUrl: string,
): Promise<UploadedFileRef> {
	const response = await fetch(uploadUrl, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!response.ok) throw new Error("Failed to upload file.");
	const { storageId } = (await response.json()) as {
		storageId: GenericId<"_storage">;
	};

	return {
		storage_id: storageId,
		file_name: file.name,
		content_type: file.type || undefined,
	};
}

// Every File-valued profile photo/attachment across every persona, keyed by the File object
// itself -- a Map, not a list of {target, file} pairs threaded back together by position
// (photo vs. attachment, persona index, file index), since the File instance already is a
// unique key and buildPersonaPayload below already has the File in hand at each call site.
function collectPendingUploads(personas: Persona[]): File[] {
	const files: File[] = [];
	for (const persona of personas) {
		if (persona.profile_photo instanceof File)
			files.push(persona.profile_photo);
		for (const entry of persona.files) {
			if (entry.file instanceof File) files.push(entry.file);
		}
	}
	return files;
}

// Uploads every File-valued profile photo/attachment across every persona: one round trip
// for the whole batch's upload URLs, then every upload running concurrently (not
// photo-then-attachments, persona by persona in series).
//
// Promise.allSettled, not Promise.all: with a plain Promise.all, one failed upload in a batch
// of several rejects immediately and discards every OTHER upload's result along with it --
// those files already landed in Convex storage, but nothing would know their storage ids to
// clean them up, leaving them orphaned until the weekly sweepOrphanedStorage backstop. Settling
// the whole batch first means the ones that succeeded can be discarded (via discardNewUploads,
// the same cleanup path a rejected create/update already goes through below) before this
// function throws, so a partial-failure upload leaves nothing stranded either.
async function uploadAll(
	personas: Persona[],
): Promise<Map<File, UploadedFileRef>> {
	const pending = collectPendingUploads(personas);
	const uploadUrls = await generateUploadUrls(pending.length);
	if (uploadUrls.length !== pending.length) {
		throw new Error("Missing upload URL for an upload.");
	}
	const settled = await Promise.allSettled(
		pending.map((file, i) => putToConvexStorage(file, uploadUrls[i] as string)),
	);
	const succeeded = new Map<File, UploadedFileRef>();
	const failures: unknown[] = [];
	settled.forEach((result, i) => {
		if (result.status === "fulfilled") {
			succeeded.set(pending[i] as File, result.value);
		} else {
			failures.push(result.reason);
		}
	});
	if (failures.length > 0) {
		await discardNewUploads(succeeded);
		const firstFailure = failures[0];
		throw firstFailure instanceof Error
			? firstFailure
			: new Error("Failed to upload one or more files.");
	}
	return succeeded;
}

function buildPersonaPayload(
	persona: Persona,
	uploaded: Map<File, UploadedFileRef>,
): PersonaPayload {
	const profile_photo =
		persona.profile_photo instanceof File
			? (uploaded.get(persona.profile_photo) ?? null)
			: persona.profile_photo;
	const files = persona.files.map((entry) => {
		if (!(entry.file instanceof File))
			return { ...entry, file: entry.file ?? null };
		return { ...entry, file: uploaded.get(entry.file) ?? null };
	});
	// Persona and PersonaPayload agree field-for-field except profile_photo/files (see
	// types.ts's Persona = Omit<PersonaPayload, ...> & {...}), so spreading persona and
	// overriding just the two resolved fields can't silently drop a field the way a hand-listed
	// object literal could if PersonaPayload ever grew one.
	return { ...persona, profile_photo, files };
}

// Best-effort cleanup for uploads a failed create/update leaves stranded (see discardUploads
// in api/uploads.ts) -- swallows its own failure so a cleanup hiccup never masks the save
// error the admin actually needs to see; any upload it fails to reach is still caught by the
// weekly sweepOrphanedStorage backstop (api/files.ts, convex/crons.ts).
async function discardNewUploads(
	uploaded: Map<File, UploadedFileRef>,
): Promise<void> {
	if (uploaded.size === 0) return;
	const storageIds = [...uploaded.values()].map((ref) => ref.storage_id);
	try {
		await getConvexClient().mutation(api.api.uploads.discardUploads, {
			storageIds,
		});
	} catch {
		// Left for sweepOrphanedStorage.
	}
}

export type SubmitCaseInput = {
	// null means create; a case id means update that case. Not a separate isEditMode flag
	// alongside it -- the two could never legitimately disagree (edit mode always has a case
	// id by the time submitCase can run; create mode never does), so there was nothing a
	// second field could express that this one doesn't already.
	editCaseId: string | null;
	caseName: string;
	initialBrief: string;
	commonInformation: string;
	simulationDurationMinutes: number | null;
	accessCode: string;
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
	// Convex admin ids (see CaseForm.svelte's collaborator picker, sourced from
	// api/admins:listAll).
	collaboratorAdminIds: string[];
};

// Uploads any new (File-valued) profile photos/attachments to Convex storage, then creates
// or updates the case -- both go through Convex end to end now. Edit has no optimistic-
// concurrency check (no expected-version conflict to handle): two admins saving the same
// case at once is rare enough that last-write-wins is an accepted tradeoff (see
// convex/schema.ts's comment on `cases`). Both create and update return `{ caseId }` (see
// api/cases.ts) -- surfaced here, not discarded, so a successful create can hand the caller
// its new case's id (CaseForm.svelte uses it to leave the create route once the case exists,
// rather than staying somewhere a second Submit click re-runs `create` against the same
// now-already-saved case).
export async function submitCase({
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
}: SubmitCaseInput): Promise<{ caseId: Id<"cases"> }> {
	const uploaded = await uploadAll(personas);
	const personasPayload = personas.map((persona) =>
		buildPersonaPayload(persona, uploaded),
	);
	// referrals is already exactly ReferralEdge[] (= ReferralEdgePayload[], see types.ts) --
	// no File-valued fields to resolve the way personas above needs, so it needs no mapping,
	// unlike personasPayload.
	const scalars = {
		name: caseName.trim(),
		brief: initialBrief.trim(),
		commonInformation: commonInformation.trim(),
		duration: simulationDurationMinutes ?? undefined,
		accessCode: accessCode.trim(),
		personas: personasPayload,
		referrals,
		roots,
		// Plain strings on the wire in from CaseForm.svelte's collaborator picker (sourced from
		// api/admins:listAll's own real Id<"admins"> values, just widened to string the moment
		// they're read off admin._id in that picker's UI state) -- narrowed back here, at the
		// one point this actually becomes a mutation argument that has to be Id<"admins">.
		collaboratorAdminIds: collaboratorAdminIds as Id<"admins">[],
	};

	try {
		if (editCaseId !== null) {
			return await getConvexClient().mutation(api.api.cases.update, {
				caseId: editCaseId as Id<"cases">,
				...scalars,
			});
		}

		return await getConvexClient().mutation(api.api.cases.create, scalars);
	} catch (err) {
		// The uploads above already landed in Convex storage; the mutation that would have
		// claimed them (via `files` rows) never committed. Clean up what this attempt itself
		// uploaded before rethrowing, so a rejected save (e.g. a taken access code) doesn't
		// leave orphaned storage behind every time an admin fixes the field and resubmits.
		await discardNewUploads(uploaded);
		throw err;
	}
}
