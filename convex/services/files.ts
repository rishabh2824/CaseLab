import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FileRefPayload } from "../models/cases";

// Returns the storage ids among the given references whose uploads still exist.
export async function existingStorageIds(
	ctx: QueryCtx,
	refs: FileRefPayload[],
): Promise<Set<Id<"_storage">>> {
	const ids = new Set(refs.flatMap((ref) => (ref ? [ref.storageId] : [])));
	const found = await Promise.all(
		[...ids].map(async (id) =>
			(await ctx.db.system.get("_storage", id)) ? id : null,
		),
	);
	return new Set(found.filter((id): id is Id<"_storage"> => id !== null));
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

// Syncs a case's file links to the desired set and schedules cleanup for files it no longer uses.
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
			await ctx.db.delete(row._id);
			await ctx.scheduler.runAfter(0, internal.files.cleanupOrphanedFile, {
				storageId: row.storageId,
			});
		}
	}
}
