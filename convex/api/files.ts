import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { requireCurrentAdmin } from "../services/admins";
import {
	fileHasReferences,
	resolveFileRefs as resolveFileRefsService,
} from "../services/files";

const fileRefValidator = v.union(
	v.null(),
	v.object({
		storageId: v.id("_storage"),
		fileName: v.string(),
		contentType: v.optional(v.string()),
	}),
);

// Mirrors backend/services/cases.py's resolveFileRefs: batched get-or-create by storageId.
// Not currently called by anything -- case save (services/cases.ts's createCase/updateCase)
// ended up resolving refs internally via the resolveFileRefs service function directly,
// rather than through this public mutation. Left in place as a building block (e.g. for an
// upload flow that wants refs resolved ahead of save), not as a Phase 3 stub.
export const resolveFileRefs = mutation({
	args: { fileRefs: v.array(fileRefValidator) },
	handler: async (ctx, args) => {
		await requireCurrentAdmin(ctx);
		return await resolveFileRefsService(ctx, args.fileRefs);
	},
});

// Scheduled by services/files.ts's syncCaseFiles whenever a caseFiles row is removed and no
// other case references that file anymore. A single mutation (not the action+mutation split
// the old Spaces-backed version needed) because ctx.storage.delete has no network call --
// it's a normal transactional Convex operation, so there's nothing here that can't run
// inside one mutation. Re-checks orphan status (not just trusted from when this was
// scheduled) since another mutation could have re-referenced the file in the meantime.
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
