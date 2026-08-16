import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type FileRefInput = {
	storageId: Id<"_storage">;
	fileName: string;
	contentType?: string;
};

// Mirrors backend/services/cases.py's _shapeFileRow, in Convex's own camelCase rather than
// the old backend's snake_case -- this shape isn't constrained by any preserved-as-is old
// data (unlike `cases.structure`), so there's no reason to carry the old naming forward.
export type ResolvedFileRef = {
	fileId: Id<"files">;
	storageId: Id<"_storage">;
	fileName: string;
	contentType: string | undefined;
};

function shapeFileRow(file: Doc<"files">): ResolvedFileRef {
	return {
		fileId: file._id,
		storageId: file.storageId,
		fileName: file.name,
		contentType: file.contentType,
	};
}

// Mirrors backend/services/cases.py's resolveFileRefs: batched get-or-create by storageId.
// One query per distinct id in the batch, then one insert per still-missing id (deduped, so
// two refs new to the DB sharing a storageId -- e.g. two personas given the same brand-new
// photo in one save -- insert a single row instead of racing). Convex mutations are
// serializable, so two concurrent saves resolving the same new storageId simply run one
// after the other -- there's no IntegrityError/violation()/uq_files_object_key dance to port.
export async function resolveFileRefs(
	ctx: MutationCtx,
	fileRefs: (FileRefInput | null)[],
): Promise<(ResolvedFileRef | null)[]> {
	const storageIds = new Set(
		fileRefs
			.filter((ref): ref is FileRefInput => ref !== null)
			.map((ref) => ref.storageId),
	);
	if (storageIds.size === 0) return fileRefs.map(() => null);

	const byId = new Map<Id<"_storage">, ResolvedFileRef>();
	for (const storageId of storageIds) {
		const existing = await ctx.db
			.query("files")
			.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
			.first();
		if (existing) byId.set(storageId, shapeFileRow(existing));
	}

	for (const ref of fileRefs) {
		if (ref === null || byId.has(ref.storageId)) continue;
		const fileId = await ctx.db.insert("files", {
			storageId: ref.storageId,
			name: ref.fileName,
			contentType: ref.contentType,
		});
		byId.set(ref.storageId, {
			fileId,
			storageId: ref.storageId,
			fileName: ref.fileName,
			contentType: ref.contentType,
		});
	}

	return fileRefs.map((ref) =>
		ref === null ? null : byId.get(ref.storageId)!,
	);
}

// Whether any case still references this file. Shared by syncCaseFiles' pre-check (cheap,
// avoids scheduling a cleanup action at all for a still-referenced file) and
// api/files.ts's cleanup action, which re-checks right before actually deleting anything.
export async function fileHasReferences(
	ctx: QueryCtx | MutationCtx,
	fileId: Id<"files">,
): Promise<boolean> {
	const referencing = await ctx.db
		.query("caseFiles")
		.withIndex("by_file", (q) => q.eq("fileId", fileId))
		.first();
	return referencing !== null;
}

// Replaces backend/services/cases.py's referencedFileIds JSONB-text scan: reconciles a
// case's `caseFiles` rows to exactly `desiredFileIds` (the file ids its just-saved
// structure references), instead of scanning every case's serialized structure for a
// needle. Call this from both case create and case update with the freshly-extracted file
// id set, and from case delete with an empty set (which removes every row for that case).
export async function syncCaseFiles(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	desiredFileIds: Set<Id<"files">>,
): Promise<void> {
	const existingRows = await ctx.db
		.query("caseFiles")
		.withIndex("by_case", (q) => q.eq("caseId", caseId))
		.collect();
	const existingFileIds = new Set(existingRows.map((row) => row.fileId));

	for (const fileId of desiredFileIds) {
		if (!existingFileIds.has(fileId)) {
			await ctx.db.insert("caseFiles", { caseId, fileId });
		}
	}

	const removedFileIds: Id<"files">[] = [];
	for (const row of existingRows) {
		if (!desiredFileIds.has(row.fileId)) {
			await ctx.db.delete(row._id);
			removedFileIds.push(row.fileId);
		}
	}

	// Scheduled rather than deleted inline: another mutation could re-reference this file
	// before the scheduled cleanup (api/files.ts's cleanupOrphanedFile) actually runs, so it
	// re-checks orphan status itself rather than this call site trusting its own snapshot.
	for (const fileId of removedFileIds) {
		if (!(await fileHasReferences(ctx, fileId))) {
			await ctx.scheduler.runAfter(0, internal.api.files.cleanupOrphanedFile, {
				fileId,
			});
		}
	}
}
