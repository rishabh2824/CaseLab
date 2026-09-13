import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FileRefPayload } from "../models/cases";

// The wire shape (fileRefValidator, models/cases.ts) plus the one thing it doesn't carry --
// which `files` row this storage id resolved to. Callers that need to persist a ref back into
// `cases.structure` strip `fileId` back off (see services/cases.ts's toFileRefPayload); the
// rest of this shape is exactly FileRefPayload, not a separately-named camelCase mirror of it
// that every caller had to convert into and back out of for no benefit.
export type ResolvedFileRef = Exclude<FileRefPayload, null> & {
	fileId: Id<"files">;
};

function toResolvedFileRef(file: Doc<"files">): ResolvedFileRef {
	return {
		fileId: file._id,
		storage_id: file.storageId,
		file_name: file.name,
		content_type: file.contentType,
	};
}

// Batched get-or-create by storageId, returned as a map so a caller with several refs that
// might share a storageId (e.g. buildStructure's photo + per-file refs across every persona
// in a case) looks each one up directly instead of threading a parallel cursor through its
// own reassembly. One query per distinct id in the batch -- run concurrently, not
// serialized, since none of these reads depend on each other -- then one insert per
// still-missing id (deduped, so two refs new to the DB sharing a storageId -- e.g. two
// personas given the same brand-new photo in one save -- insert a single row instead of
// racing). Convex mutations are serializable, so two concurrent saves resolving the same new
// storageId simply run one after the other.
export async function resolveFileRefs(
	ctx: MutationCtx,
	fileRefs: (FileRefPayload | undefined)[],
): Promise<Map<Id<"_storage">, ResolvedFileRef>> {
	const distinctRefs = new Map<Id<"_storage">, Exclude<FileRefPayload, null>>();
	for (const ref of fileRefs) {
		if (ref && !distinctRefs.has(ref.storage_id)) {
			distinctRefs.set(ref.storage_id, ref);
		}
	}
	if (distinctRefs.size === 0) return new Map();

	const existingRows = await Promise.all(
		[...distinctRefs.keys()].map((storageId) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.first(),
		),
	);

	const resolved = new Map<Id<"_storage">, ResolvedFileRef>();
	const toInsert: Exclude<FileRefPayload, null>[] = [];
	[...distinctRefs.entries()].forEach(([storageId, ref], i) => {
		const existing = existingRows[i];
		if (existing) resolved.set(storageId, toResolvedFileRef(existing));
		else toInsert.push(ref);
	});

	for (const ref of toInsert) {
		// A storage id with no `files` row yet still has to actually exist in `_storage` before
		// claiming one -- e.g. a template load carried over a photo ref whose object was deleted
		// (by cleanupOrphanedFile or the sweep) between when the admin loaded the source case and
		// when they saved this one. Silently dropping the ref here (never entering it into
		// `resolved`, so buildStructure's lookup treats it as unset) mirrors buildStructure's own
		// documented tradeoff for a file entry with no attachment: the alternative -- rejecting
		// the whole save over one stale reference the admin never directly touched -- was judged
		// worse than losing that one photo/attachment.
		if (!(await ctx.db.system.get("_storage", ref.storage_id))) continue;
		const fileId = await ctx.db.insert("files", {
			storageId: ref.storage_id,
			name: ref.file_name,
			contentType: ref.content_type ?? undefined,
		});
		resolved.set(ref.storage_id, { fileId, ...ref });
	}

	return resolved;
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
