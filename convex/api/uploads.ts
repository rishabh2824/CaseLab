import { v } from "convex/values";
import { adminMutation } from "../lib/adminFunctions";

// Generates a short-lived upload URL backed by Convex's own file storage. Convex hands back
// no notion of file name/content type/prefix -- just the URL and an `Id<"_storage">` once the
// client POSTs to it -- so the client keeps the file's name/content type itself and pairs it
// back up with the returned `storageId` (see frontend/src/lib/case/submitCase.ts).
export const generateUploadUrl = adminMutation({
	args: {},
	handler: async (ctx) => {
		return await ctx.storage.generateUploadUrl();
	},
});

// The largest batch a real case save can need. A case's files are one profile photo plus a
// handful of attachments per persona, so 200 is far above any legitimate save while still
// bounding what a single request can allocate.
const MAX_UPLOAD_BATCH = 200;

// Each URL is independently cheap to generate (no network I/O) -- the batching win is paying
// for the admin auth check once per case save instead of once per file.
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
			throw new Error(
				`Upload count must be a whole number between 0 and ${MAX_UPLOAD_BATCH}.`,
			);
		}
		return await Promise.all(
			Array.from({ length: args.count }, () => ctx.storage.generateUploadUrl()),
		);
	},
});
