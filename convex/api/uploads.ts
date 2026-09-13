import { ConvexError, v } from "convex/values";
import { adminMutation } from "../lib/adminFunctions";

// The largest batch a real case save can need. A case's files are one profile photo plus a
// handful of attachments per persona, so 200 is far above any legitimate save while still
// bounding what a single request can allocate.
const MAX_UPLOAD_BATCH = 200;

// Generates count short-lived upload URLs backed by Convex's own file storage. Convex hands
// back no notion of file name/content type/prefix -- just the URL and an `Id<"_storage">` once
// the client POSTs to it -- so the client keeps each file's name/content type itself and pairs
// it back up with the returned `storageId` (see src/lib/case/submitCase.ts). Each URL is
// independently cheap to generate (no network I/O) -- the batching win is paying for the
// admin auth check once per case save instead of once per file.
export const generateUploadUrls = adminMutation({
	args: { count: v.number() },
	handler: async (ctx, args) => {
		// `v.number()` accepts any float, including NaN, Infinity and negatives, and
		// `Array.from({ length })` silently coerces all of those to an empty or wrong-length
		// array rather than failing. The client (submitCase.ts) pairs the returned urls to its
		// pending files POSITIONALLY, so a short batch doesn't error -- it uploads a file to
		// `undefined`, or drops it. Bounding it also stops one authenticated request from
		// allocating an unbounded batch.
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

// generateUploadUrls's undo: submitCase.ts uploads every new File before calling create/
// update, so an upload that succeeds followed by a create/update that fails (e.g. a taken
// access code) leaves a real, storage-billed `_storage` object nothing will ever reference --
// silently, since nothing surfaces that failure to an admin as "also, clean up your files."
// Called on that exact catch, with exactly the storage ids that attempt just uploaded, so the
// common leak closes the moment it happens rather than waiting on the weekly backstop sweep
// (api/files.ts's sweepOrphanedStorage, crons.ts) that exists for the harder-to-reach cases
// (a closed tab, a dropped connection, mid-flight before the mutation was even attempted).
// Re-checks `files` itself rather than trusting the caller's word that a ref is unclaimed --
// a storage id createCase/updateCase's own resolveFileRefs did end up claiming (this same
// batch's case save actually succeeded on a *retry* that raced ahead of this cleanup call)
// must not be deleted out from under it.
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
