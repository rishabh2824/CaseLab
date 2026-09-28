import { ConvexError } from "convex/values";
import { studentErrorData } from "../../convex/lib/studentErrors.js";

// Returns a user-safe message for an error, falling back when it is only Convex wrapper text.
export function getErrorMessage(err: unknown, fallback: string): string {
	const student = studentErrorData(err);
	if (student) return student.message;
	if (err instanceof ConvexError && typeof err.data === "string" && err.data) {
		return err.data;
	}
	if (
		err instanceof Error &&
		err.message &&
		!err.message.startsWith("[CONVEX ")
	) {
		return err.message;
	}
	return fallback;
}
