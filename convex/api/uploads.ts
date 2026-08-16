import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";

// Mirrors backend/api/uploads.py's POST /uploads/presign, now backed by Convex's own file
// storage instead of a Spaces presigned PUT. Unlike the old Spaces flow, generating the URL
// has no notion of file name/content type/prefix -- Convex just hands back a short-lived
// upload URL and allocates an `Id<"_storage">` when the client POSTs to it -- so the client
// keeps the file's name/content type itself and pairs it back up with the returned
// `storageId` (see frontend/src/lib/case/submitCase.ts).
export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		await ctx.runQuery(internal.api.admins.requireCurrentAdminInternal, {});
		return await ctx.storage.generateUploadUrl();
	},
});

// The largest batch a real case save can need. A case's files are one profile photo plus a
// handful of attachments per persona, so 200 is far above any legitimate save while still
// bounding what a single request can allocate.
const MAX_UPLOAD_BATCH = 200;

// Mirrors backend/api/uploads.py's POST /uploads/presign/batch. Each URL is independently
// cheap to generate (no network I/O) -- the batching win is paying for the admin auth check
// once per case save instead of once per file.
export const generateUploadUrls = mutation({
	args: { count: v.number() },
	handler: async (ctx, args) => {
		await ctx.runQuery(internal.api.admins.requireCurrentAdminInternal, {});
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
			throw new Error(
				`Upload count must be a whole number between 0 and ${MAX_UPLOAD_BATCH}.`,
			);
		}
		return await Promise.all(
			Array.from({ length: args.count }, () => ctx.storage.generateUploadUrl()),
		);
	},
});
