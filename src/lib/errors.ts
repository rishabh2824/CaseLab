import { ConvexError } from "convex/values";
import { studentErrorData } from "#shared/studentErrors.js";

// Returns the message of an error written for the user (a student error or a ConvexError with a string), or the fallback for anything else, such as a redacted server error or a network failure.
export function getErrorMessage(err: unknown, fallback: string): string {
	const student = studentErrorData(err);
	if (student) return student.message;
	if (err instanceof ConvexError && typeof err.data === "string" && err.data) {
		return err.data;
	}
	return fallback;
}
