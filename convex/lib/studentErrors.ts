import { ConvexError } from "convex/values";

export const STUDENT_ERROR = {
	ACCESS_CODE_REQUIRED: "ACCESS_CODE_REQUIRED",
	INVALID_ACCESS_CODE: "INVALID_ACCESS_CODE",
	RUN_NOT_FOUND: "RUN_NOT_FOUND",
	RUN_EXPIRED: "RUN_EXPIRED",
	CASE_NOT_FOUND: "CASE_NOT_FOUND",
	MESSAGE_REQUIRED: "MESSAGE_REQUIRED",
	MESSAGE_TOO_LONG: "MESSAGE_TOO_LONG",
	CONVERSATION_ENDED: "CONVERSATION_ENDED",
	SIMULATION_ENDED: "SIMULATION_ENDED",
	PERSONA_NOT_FOUND: "PERSONA_NOT_FOUND",
	PERSONA_UNAVAILABLE: "PERSONA_UNAVAILABLE",
	REPLY_IN_PROGRESS: "REPLY_IN_PROGRESS",
} as const;

export type StudentErrorCode =
	(typeof STUDENT_ERROR)[keyof typeof STUDENT_ERROR];
export type StudentErrorData = { code: StudentErrorCode; message: string };

// Builds a ConvexError carrying a student-facing error code and message.
export function studentError(
	code: StudentErrorCode,
	message: string,
): ConvexError<StudentErrorData> {
	return new ConvexError({ code, message });
}

// Extracts a student error's code and message from a thrown value, or returns null if it isn't one.
export function studentErrorData(err: unknown): StudentErrorData | null {
	if (!(err instanceof ConvexError)) return null;
	const data: unknown = err.data;
	if (typeof data !== "object" || data === null) return null;
	const { code, message } = data as Record<string, unknown>;
	const known = Object.values<unknown>(STUDENT_ERROR).includes(code);
	return known && typeof message === "string"
		? { code: code as StudentErrorCode, message }
		: null;
}
