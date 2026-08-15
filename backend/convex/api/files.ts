import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery, mutation } from "../_generated/server";
import { deleteObject } from "../lib/spaces";
import { requireCurrentAdmin } from "../services/admins";
import { fileHasReferences, resolveFileRefs as resolveFileRefsService } from "../services/files";

const fileRefValidator = v.union(
	v.null(),
	v.object({
		objectKey: v.string(),
		fileName: v.string(),
		contentType: v.optional(v.string()),
	}),
);

// Mirrors backend/services/cases.py's resolveFileRefs: batched get-or-create by objectKey.
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

// --- orphan cleanup -- scheduled by services/files.ts's syncCaseFiles whenever a
// caseFiles row is removed and no other case references that file anymore.

// Not client-callable. Returns the file doc only if it's still unreferenced right now --
// re-checked here (not just trusted from when the cleanup was scheduled) because another
// mutation could have re-referenced the same file in the meantime.
export const getFileIfOrphaned = internalQuery({
	args: { fileId: v.id("files") },
	handler: async (ctx, args) => {
		if (await fileHasReferences(ctx, args.fileId)) return null;
		return await ctx.db.get(args.fileId);
	},
});

// Not client-callable. Re-checks orphan status once more (the Spaces DELETE this runs
// after is a real network call, wide enough for another mutation to have re-referenced the
// file during it) before removing the `files` row.
export const deleteFileRowIfOrphaned = internalMutation({
	args: { fileId: v.id("files") },
	handler: async (ctx, args) => {
		if (await fileHasReferences(ctx, args.fileId)) return;
		await ctx.db.delete(args.fileId);
	},
});

// Mirrors backend/services/cases.py's deleteOrphanedFiles, split across the mutation/action
// boundary Convex requires: the actual Spaces DELETE is a real network call, which can't
// run inside the mutation that removed the caseFiles row. Deletes the Spaces object BEFORE
// the `files` row, same order as the old code and for the same reason -- if the network
// call fails, the row survives so a later save/delete touching this file gets another
// chance, instead of deleting the row first and permanently losing the objectKey needed to
// ever clean up the orphaned object. Best-effort: a failed delete here is left for that
// next opportunistic pass, not retried automatically.
export const cleanupOrphanedFile = internalAction({
	args: { fileId: v.id("files") },
	handler: async (ctx, args) => {
		const file = await ctx.runQuery(internal.api.files.getFileIfOrphaned, { fileId: args.fileId });
		if (!file) return; // already cleaned up, or re-referenced since scheduling
		try {
			await deleteObject(file.objectKey);
		} catch (err) {
			// Logged, not rethrown: this is best-effort cleanup, not the primary operation
			// that scheduled it. Without this log, a persistently misconfigured Spaces
			// client (bad credentials, wrong bucket) would fail silently forever.
			console.error(`Failed to delete orphaned Spaces object for file ${args.fileId}:`, err);
			return;
		}
		await ctx.runMutation(internal.api.files.deleteFileRowIfOrphaned, { fileId: args.fileId });
	},
});
