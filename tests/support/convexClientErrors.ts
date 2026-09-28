import { ConvexError } from "convex/values";
import {
	type StudentErrorCode,
	type StudentErrorData,
	studentError,
} from "../../convex/lib/studentErrors.js";

type Source = "M" | "Q" | "A";

// Builds the wrapper message a Convex client puts on a server error.
const wrapped = (source: Source, udfPath: string) =>
	`[CONVEX ${source}(${udfPath})] [Request ID: test] Server Error\n  Called by client`;

// Builds the error a Convex client sees for a student error, with the details on its data.
export function clientStudentError(
	udfPath: string,
	code: StudentErrorCode,
	message: string,
	source: Source = "M",
): ConvexError<string | StudentErrorData> {
	const error = new ConvexError<string | StudentErrorData>(
		wrapped(source, udfPath),
	);
	error.data = studentError(code, message).data;
	return error;
}

// Builds the error a Convex client sees for a redacted server error.
export function clientServerError(
	udfPath: string,
	source: Source = "M",
): Error {
	return new Error(wrapped(source, udfPath));
}
