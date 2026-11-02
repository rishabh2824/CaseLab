import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError, ERROR_CODE } from "../shared/errors";
import type { FileRefPayload } from "../shared/validators";

// Returns the storage ids of the given references, throwing if any upload is gone.
export async function requireStoredFiles(
	ctx: QueryCtx,
	refs: (FileRefPayload | undefined)[],
): Promise<Set<Id<"_storage">>> {
	const ids = new Set(refs.flatMap((ref) => (ref ? [ref.storageId] : [])));
	const found = await Promise.all(
		[...ids].map((id) => ctx.db.system.get("_storage", id)),
	);
	if (found.includes(null)) {
		throw appError(
			ERROR_CODE.FILE_MISSING,
			"An attached file is no longer available. Remove it and upload it again.",
		);
	}
	return ids;
}

// Returns whether any case still references the stored file.
export async function storageHasReferences(
	ctx: QueryCtx,
	storageId: Id<"_storage">,
): Promise<boolean> {
	const referencing = await ctx.db
		.query("caseFiles")
		.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
		.first();
	return referencing !== null;
}

// Syncs a case's file links to the desired set. A file no case links to any more is deleted later by the weekly sweep.
export async function syncCaseFiles(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	desiredStorageIds: Set<Id<"_storage">>,
): Promise<void> {
	const existingRows = await ctx.db
		.query("caseFiles")
		.withIndex("by_case", (q) => q.eq("caseId", caseId))
		.collect();
	const linkedStorageIds = new Set(existingRows.map((row) => row.storageId));

	for (const storageId of desiredStorageIds) {
		if (!linkedStorageIds.has(storageId)) {
			await ctx.db.insert("caseFiles", { caseId, storageId });
		}
	}

	for (const row of existingRows) {
		if (!desiredStorageIds.has(row.storageId)) {
			await ctx.db.delete("caseFiles", row._id);
		}
	}
}
