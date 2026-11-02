import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { storageHasReferences } from "./model/files";

const SWEEP_BATCH_SIZE = 100;

// Deletes stored files no case references: uploads whose save never finished (a closed tab, a failed save) and files removed from a case. Runs in the small hours when nobody is saving a case, and walks storage in batches.
export const sweepAbandonedUploads = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args) => {
		const page = await ctx.db.system
			.query("_storage")
			.paginate({ numItems: SWEEP_BATCH_SIZE, cursor: args.cursor ?? null });

		for (const file of page.page) {
			if (!(await storageHasReferences(ctx, file._id)))
				await ctx.storage.delete(file._id);
		}

		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.files.sweepAbandonedUploads, {
				cursor: page.continueCursor,
			});
	},
});
