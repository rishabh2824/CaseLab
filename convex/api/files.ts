import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { fileHasReferences } from "../services/files";

// Scheduled by services/files.ts's syncCaseFiles whenever a caseFiles row is removed and no
// other case references that file anymore. A single mutation because ctx.storage.delete has
// no network call -- it's a normal transactional Convex operation, so there's nothing here
// that can't run inside one mutation. Re-checks orphan status (not just trusted from when
// this was scheduled) since another mutation could have re-referenced the file in the
// meantime.
export const cleanupOrphanedFile = internalMutation({
	args: { fileId: v.id("files") },
	handler: async (ctx, args) => {
		if (await fileHasReferences(ctx, args.fileId)) return;
		const file = await ctx.db.get(args.fileId);
		if (!file) return; // already cleaned up
		await ctx.storage.delete(file.storageId);
		await ctx.db.delete(args.fileId);
	},
});
