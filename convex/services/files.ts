import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FileRefPayload } from "../models/cases";

export type ResolvedFileRef = Exclude<FileRefPayload, null> & {
	fileId: Id<"files">;
};

// Converts a files row into a resolved file reference.
function toResolvedFileRef(file: Doc<"files">): ResolvedFileRef {
	return {
		fileId: file._id,
		storage_id: file.storageId,
		file_name: file.name,
		content_type: file.contentType,
	};
}

// Maps each distinct storage id to its files row, reusing existing rows and creating missing ones.
export async function resolveFileRefs(
	ctx: MutationCtx,
	fileRefs: FileRefPayload[],
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
		if (!(await ctx.db.system.get("_storage", ref.storage_id))) continue;
		const fileId = await ctx.db.insert("files", {
			storageId: ref.storage_id,
			name: ref.file_name,
			contentType: ref.content_type,
		});
		resolved.set(ref.storage_id, { fileId, ...ref });
	}

	return resolved;
}

// Returns whether any case still references the file.
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

// Syncs a case's file links to the desired set and schedules cleanup for files it no longer uses.
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

	for (const row of existingRows) {
		if (!desiredFileIds.has(row.fileId)) {
			await ctx.db.delete(row._id);
			await ctx.scheduler.runAfter(0, internal.api.files.cleanupOrphanedFile, {
				fileId: row.fileId,
			});
		}
	}
}
