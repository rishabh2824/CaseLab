import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { buildObjectKey } from "../lib/uploads";
import { presignPutUrl } from "../lib/spaces";

// Mirrors backend/infra/settings.py's spaces_upload_expiry default.
const UPLOAD_EXPIRY_SECONDS = 900;

const presignItemValidator = v.object({
	fileName: v.string(),
	contentType: v.optional(v.string()),
	prefix: v.optional(v.string()),
});

type PresignItem = Infer<typeof presignItemValidator>;

type PresignResult = {
	uploadUrl: string;
	objectKey: string;
	fileName: string;
	contentType: string | undefined;
	expiresIn: number;
};

async function presignOne(item: PresignItem): Promise<PresignResult> {
	const objectKey = buildObjectKey(item.fileName, item.prefix);
	const uploadUrl = await presignPutUrl(objectKey, item.contentType, UPLOAD_EXPIRY_SECONDS);
	return {
		uploadUrl,
		objectKey,
		fileName: item.fileName,
		contentType: item.contentType,
		expiresIn: UPLOAD_EXPIRY_SECONDS,
	};
}

// Mirrors backend/api/uploads.py's POST /uploads/presign. An action, not a mutation or
// query: presigning depends on the current time (X-Amz-Date/X-Amz-Expires), so it isn't
// deterministic/cacheable the way a query needs to be, and it needs admin auth, so it isn't
// a bare pure function either -- gated the same way every mutation/query gates itself,
// via an internal query since actions have no direct db access.
export const presignUpload = action({
	args: presignItemValidator,
	handler: async (ctx, args) => {
		await ctx.runQuery(internal.api.admins.requireCurrentAdminInternal, {});
		return await presignOne(args);
	},
});

// Mirrors backend/api/uploads.py's POST /uploads/presign/batch. Each item is independently
// cheap (local URL signing, no network I/O) -- the batching win is paying for the admin
// auth check once per case save instead of once per file.
export const presignUploadBatch = action({
	args: { files: v.array(presignItemValidator) },
	handler: async (ctx, args) => {
		await ctx.runQuery(internal.api.admins.requireCurrentAdminInternal, {});
		return await Promise.all(args.files.map(presignOne));
	},
});
