import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { fileHasReferences } from "../services/files";

// Deletes a file row and its stored blob once nothing references it any more.
export const cleanupOrphanedFile = internalMutation({
	args: { fileId: v.id("files") },
	handler: async (ctx, args) => {
		if (await fileHasReferences(ctx, args.fileId)) return;
		const file = await ctx.db.get("files", args.fileId);
		if (!file) return;
		await ctx.storage.delete(file.storageId);
		await ctx.db.delete(args.fileId);
	},
});
