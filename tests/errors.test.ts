import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
	STUDENT_ERROR,
	studentErrorData,
} from "../convex/lib/studentErrors.js";
import { getErrorMessage } from "../src/lib/errors.js";
import {
	clientServerError,
	clientStudentError,
} from "./support/convexClientErrors.js";

describe("getErrorMessage", () => {
	// Tests that a ConvexError's data is used as the message instead of its wrapper text.
	it("prefers a ConvexError's .data over its noisy .message wrapper", () => {
		const err = new ConvexError("Access code is required.");
		expect(getErrorMessage(err, "fallback")).toBe("Access code is required.");
	});

	// Tests that a plain Error's own message is returned when it is not a Convex wrapper.
	it("returns a plain Error's message when it isn't the redacted Convex wrapper", () => {
		const err = new Error("Failed to upload file.");
		expect(getErrorMessage(err, "fallback")).toBe("Failed to upload file.");
	});

	// Tests that Convex-wrapped messages, redacted or not, fall back to the default message.
	it("falls back instead of surfacing a Convex-wrapped message, redacted or not", () => {
		const devWrapped = new Error(
			"[CONVEX Q(api/cases:getForEdit)] [Request ID: abc] Case not found. Called by client",
		);
		expect(getErrorMessage(devWrapped, "fallback")).toBe("fallback");

		const prodRedacted = new Error(
			"[CONVEX Q(api/cases:getForEdit)] [Request ID: abc] Server Error Called by client",
		);
		expect(getErrorMessage(prodRedacted, "fallback")).toBe("fallback");
	});

	// Tests that a non-Error value or an empty message falls back to the default message.
	it("falls back for a non-Error value or an empty message", () => {
		expect(getErrorMessage("just a string", "fallback")).toBe("fallback");
		expect(getErrorMessage(new Error(""), "fallback")).toBe("fallback");
	});
});

describe("student-facing errors", () => {
	// Tests that the student error message and code are read from the ConvexError data.
	it("reads the message and code from .data, whatever the wrapper says", () => {
		const err = clientStudentError(
			"api/turn:start",
			STUDENT_ERROR.MESSAGE_RATE_LIMITED,
			"Rate limit exceeded.",
		);
		expect(err.message).toContain("[CONVEX M(api/turn:start)]");
		expect(getErrorMessage(err, "fallback")).toBe("Rate limit exceeded.");
		expect(studentErrorData(err)).toEqual({
			code: STUDENT_ERROR.MESSAGE_RATE_LIMITED,
			message: "Rate limit exceeded.",
		});
	});

	// Tests that redacted server errors, plain string ConvexErrors and unknown codes are not student errors.
	it("treats a redacted server error, an admin string ConvexError, and unknown codes as not student errors", () => {
		expect(studentErrorData(clientServerError("api/turn:start"))).toBeNull();
		expect(studentErrorData(new ConvexError("Not signed in."))).toBeNull();
		expect(
			studentErrorData(new ConvexError({ code: "MADE_UP", message: "x" })),
		).toBeNull();
		expect(studentErrorData("nope")).toBeNull();
	});
});
