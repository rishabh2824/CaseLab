import { ConvexError, v } from "convex/values";
import { adminMutation } from "../lib/adminFunctions";

const MAX_UPLOAD_BATCH = 200;

// Returns the requested number of one-time storage upload URLs.
export const generateUploadUrls = adminMutation({
	args: { count: v.number() },
	handler: async (ctx, args) => {
		if (
			!Number.isInteger(args.count) ||
			args.count < 0 ||
			args.count > MAX_UPLOAD_BATCH
		) {
			throw new ConvexError(
				`Upload count must be a whole number between 0 and ${MAX_UPLOAD_BATCH}.`,
			);
		}
		return await Promise.all(
			Array.from({ length: args.count }, () => ctx.storage.generateUploadUrl()),
		);
	},
});

// Deletes uploaded blobs that no files row has claimed.
export const discardUploads = adminMutation({
	args: { storageIds: v.array(v.id("_storage")) },
	handler: async (ctx, args) => {
		if (args.storageIds.length > MAX_UPLOAD_BATCH) {
			throw new ConvexError(
				`Cannot discard more than ${MAX_UPLOAD_BATCH} uploads at once.`,
			);
		}
		for (const storageId of args.storageIds) {
			const claimed = await ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.first();
			if (!claimed) await ctx.storage.delete(storageId);
		}
	},
});
