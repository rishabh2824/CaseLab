import { ConvexError } from "convex/values";

// Every error the backend shows to a person is a ConvexError carrying { code, message }. The code is for the client to branch on, the message is for the user.
export const ERROR_CODE = {
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
	NOT_SIGNED_IN: "NOT_SIGNED_IN",
	NOT_AUTHORIZED: "NOT_AUTHORIZED",
	SUPER_ADMIN_ONLY: "SUPER_ADMIN_ONLY",
	NO_CASE_ACCESS: "NO_CASE_ACCESS",
	VIEW_ONLY: "VIEW_ONLY",
	INVALID_CASE: "INVALID_CASE",
	ACCESS_CODE_TAKEN: "ACCESS_CODE_TAKEN",
	FILE_MISSING: "FILE_MISSING",
	INVALID_UPLOAD: "INVALID_UPLOAD",
	INVALID_ADMIN: "INVALID_ADMIN",
	ADMIN_NOT_FOUND: "ADMIN_NOT_FOUND",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
export type AppErrorData = { code: ErrorCode; message: string };

// Builds a ConvexError carrying an error code and a user-facing message.
export function appError(
	code: ErrorCode,
	message: string,
): ConvexError<AppErrorData> {
	return new ConvexError({ code, message });
}

// Extracts an app error's code and message from a thrown value, or returns null if it isn't one.
export function appErrorData(err: unknown): AppErrorData | null {
	if (!(err instanceof ConvexError)) return null;
	const data: unknown = err.data;
	if (typeof data !== "object" || data === null) return null;
	const { code, message } = data as Record<string, unknown>;
	const known = Object.values<unknown>(ERROR_CODE).includes(code);
	return known && typeof message === "string"
		? { code: code as ErrorCode, message }
		: null;
}
