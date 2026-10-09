import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { storageHasReferences } from "../services/files";

// Deletes a stored file once no case references it any more.
export const cleanupOrphanedFile = internalMutation({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		if (await storageHasReferences(ctx, args.storageId)) return;
		if (await ctx.db.system.get("_storage", args.storageId))
			await ctx.storage.delete(args.storageId);
	},
});
