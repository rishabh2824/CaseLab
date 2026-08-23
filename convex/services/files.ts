import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type FileRefInput = {
	storageId: Id<"_storage">;
	fileName: string;
	contentType?: string;
};

// Convex's own camelCase -- unlike `cases.structure`, this shape isn't constrained by any
// preserved-as-is data, so there's no reason for it to be anything but camelCase.
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

// Batched get-or-create by storageId. One query per distinct id in the batch, then one
// insert per still-missing id (deduped, so two refs new to the DB sharing a storageId -- e.g.
// two personas given the same brand-new photo in one save -- insert a single row instead of
// racing). Convex mutations are serializable, so two concurrent saves resolving the same new
// storageId simply run one after the other.
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

// Whether any case still references this file -- e.g. a template and a case cloned from it
// both hold a `caseFiles` row for the same file. api/files.ts's cleanup action checks this
// right before actually deleting anything, so a file dropped from one case is never deleted
// out from under another case that still legitimately references it.
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

// Reconciles a case's `caseFiles` rows to exactly `desiredFileIds` (the file ids its
// just-saved structure references), instead of scanning every case's serialized structure
// for a needle. Call this from both case create and case update with the freshly-extracted
// file id set, and from case delete with an empty set (which removes every row for that
// case).
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

	// Scheduled rather than deleted inline: cleanupOrphanedFile re-checks orphan status
	// itself right before deleting anything, since another case (e.g. a template's clone)
	// may still hold a `caseFiles` row for this file even though this one just dropped its
	// own.
	for (const row of existingRows) {
		if (!desiredFileIds.has(row.fileId)) {
			await ctx.db.delete(row._id);
			await ctx.scheduler.runAfter(0, internal.api.files.cleanupOrphanedFile, {
				fileId: row.fileId,
			});
		}
	}
}
