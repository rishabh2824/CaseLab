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

// Backstop for the leak this table shape allows in principle: a `_storage` object with no
// `files` row ever pointing at it. The primary path against this is api/uploads.ts's
// discardUploads, called by submitCase.ts the moment a create/update it just uploaded for
// fails -- this sweep is for what that can't reach (a browser closed or a connection dropped
// between the upload finishing and the save being attempted at all, or any future bug with
// the same shape), same "backstop for a primary cleanup path that should normally find
// nothing to do" role as crons.ts's `reconcile expired simulation runs`.
//
// `ORPHAN_MIN_AGE_MS` exists so this can never race a save that's still in flight -- storage
// upload and the mutation that claims it via a `files` row are two separate requests
// (submitCase.ts uploads first, then calls create/update), so a storage object can
// legitimately sit unclaimed for the short gap between them.
//
// Driven only by crons.ts's weekly interval -- no self-rescheduling here. A prior version
// took a fixed-size batch and rescheduled itself (via ctx.scheduler.runAfter) whenever that
// batch came back full, meaning to walk a `_storage` table bigger than one batch across
// several immediate runs. But a claimed object is never removed from `_storage` -- it sits
// there forever -- so once the table held at least one batch's worth of ordinary, permanently-
// claimed files, the oldest batch was full on *every* run and never changed, and the reschedule
// fired again immediately every time: an unbroken loop of scheduled function calls that never
// converged and never found anything left to clean up. `for await` instead walks the whole
// table in one run, oldest first, stopping (not rescheduling) the moment it reaches an object
// younger than the cutoff -- so this sweep's cost tracks how many *stale, unclaimed* objects
// exist right now, not the total size of `_storage`, and it runs exactly as often as
// crons.ts schedules it and no more.
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const sweepOrphanedStorage = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
		// Ascending (the default order over the built-in by_creation_time index), so this can
		// stop as soon as it reaches an object younger than the cutoff instead of reading the
		// rest of the table.
		for await (const object of ctx.db.system.query("_storage")) {
			if (object._creationTime > cutoff) break; // ascending -- everything after this is too new
			const claimed = await ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", object._id))
				.first();
			if (!claimed) await ctx.storage.delete(object._id);
		}
	},
});
