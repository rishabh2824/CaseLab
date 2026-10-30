import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { storageHasReferences } from "./services/files";

const SWEEP_BATCH_SIZE = 100;

// Uploads younger than this may still be waiting on a save, so the sweep leaves them alone.
const UPLOAD_GRACE_MS = 24 * 60 * 60_000;

// Deletes a stored file once no case references it any more.
export const cleanupOrphanedFile = internalMutation({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		if (await storageHasReferences(ctx, args.storageId)) return;
		if (await ctx.db.system.get("_storage", args.storageId))
			await ctx.storage.delete(args.storageId);
	},
});

// Deletes uploads no case ever claimed, e.g. when the tab closed before a save finished. Walks storage oldest-first in batches.
export const sweepAbandonedUploads = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args) => {
		const cutoff = Date.now() - UPLOAD_GRACE_MS;
		const page = await ctx.db.system
			.query("_storage")
			.order("asc")
			.paginate({ numItems: SWEEP_BATCH_SIZE, cursor: args.cursor ?? null });

		let reachedRecent = false;
		for (const file of page.page) {
			if (file._creationTime >= cutoff) {
				reachedRecent = true;
				break;
			}
			if (!(await storageHasReferences(ctx, file._id)))
				await ctx.storage.delete(file._id);
		}

		if (!reachedRecent && !page.isDone)
			await ctx.scheduler.runAfter(0, internal.files.sweepAbandonedUploads, {
				cursor: page.continueCursor,
			});
	},
});
