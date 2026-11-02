import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { appErrorData, ERROR_CODE } from "#shared/errors.js";
import { getErrorMessage, UserError } from "../src/lib/errors.js";
import {
	clientAppError,
	clientServerError,
} from "./support/convexClientErrors.js";

describe("getErrorMessage", () => {
	// Tests that a browser-raised UserError shows its own message.
	it("shows a UserError's message", () => {
		expect(
			getErrorMessage(new UserError("Failed to upload file."), "fallback"),
		).toBe("Failed to upload file.");
	});

	// Tests that a ConvexError with a plain string is not shown, since the server only throws { code, message } errors.
	it("falls back for a ConvexError carrying a plain string", () => {
		expect(
			getErrorMessage(new ConvexError("Case not found."), "fallback"),
		).toBe("fallback");
	});

	// Tests that a plain Error never reaches the user, since only errors written for them carry a message to show.
	it("falls back for a plain Error rather than showing its message", () => {
		expect(getErrorMessage(new Error("Failed to fetch"), "fallback")).toBe(
			"fallback",
		);
	});

	// Tests that Convex-wrapped messages, redacted or not, fall back to the default message.
	it("falls back instead of surfacing a Convex-wrapped message, redacted or not", () => {
		const devWrapped = new Error(
			"[CONVEX Q(cases:getForEdit)] [Request ID: abc] Case not found. Called by client",
		);
		expect(getErrorMessage(devWrapped, "fallback")).toBe("fallback");

		const prodRedacted = new Error(
			"[CONVEX Q(cases:getForEdit)] [Request ID: abc] Server Error Called by client",
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
		const err = clientAppError(
			"runs:start",
			ERROR_CODE.REPLY_IN_PROGRESS,
			"Please wait for the current reply.",
		);
		expect(err.message).toContain("[CONVEX M(runs:start)]");
		expect(getErrorMessage(err, "fallback")).toBe(
			"Please wait for the current reply.",
		);
		expect(appErrorData(err)).toEqual({
			code: ERROR_CODE.REPLY_IN_PROGRESS,
			message: "Please wait for the current reply.",
		});
	});

	// Tests that redacted server errors, plain string ConvexErrors and unknown codes are not student errors.
	it("treats a redacted server error, an admin string ConvexError, and unknown codes as not student errors", () => {
		expect(appErrorData(clientServerError("runs:start"))).toBeNull();
		expect(appErrorData(new ConvexError("Not signed in."))).toBeNull();
		expect(
			appErrorData(new ConvexError({ code: "MADE_UP", message: "x" })),
		).toBeNull();
		expect(appErrorData("nope")).toBeNull();
	});
});
