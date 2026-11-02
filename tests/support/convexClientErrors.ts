import { ConvexError } from "convex/values";
import { type AppErrorData, appError, type ErrorCode } from "#shared/errors.js";

type Source = "M" | "Q" | "A";

// Builds the wrapper message a Convex client puts on a server error.
const wrapped = (source: Source, udfPath: string) =>
	`[CONVEX ${source}(${udfPath})] [Request ID: test] Server Error\n  Called by client`;

// Builds the error a Convex client sees for an app error, with the details on its data.
export function clientAppError(
	udfPath: string,
	code: ErrorCode,
	message: string,
	source: Source = "M",
): ConvexError<string | AppErrorData> {
	const error = new ConvexError<string | AppErrorData>(
		wrapped(source, udfPath),
	);
	error.data = appError(code, message).data;
	return error;
}

// Builds the error a Convex client sees for a redacted server error.
export function clientServerError(
	udfPath: string,
	source: Source = "M",
): Error {
	return new Error(wrapped(source, udfPath));
}
