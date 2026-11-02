import { v } from "convex/values";
import { adminMutation } from "./model/functions";
import { appError, ERROR_CODE } from "./shared/errors";

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
			throw appError(
				ERROR_CODE.INVALID_UPLOAD,
				`Upload count must be a whole number between 0 and ${MAX_UPLOAD_BATCH}.`,
			);
		}
		return await Promise.all(
			Array.from({ length: args.count }, () => ctx.storage.generateUploadUrl()),
		);
	},
});
