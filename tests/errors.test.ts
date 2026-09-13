// Node project: getErrorMessage is pure logic, no DOM needed.
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { getErrorMessage } from "../src/lib/errors.js";

describe("getErrorMessage", () => {
	it("prefers a ConvexError's .data over its noisy .message wrapper", () => {
		const err = new ConvexError("Access code is required.");
		expect(getErrorMessage(err, "fallback")).toBe("Access code is required.");
	});

	it("returns a plain Error's message when it isn't the redacted Convex wrapper", () => {
		const err = new Error("Failed to upload file.");
		expect(getErrorMessage(err, "fallback")).toBe("Failed to upload file.");
	});

	// A handler that throws a plain `Error` (not a ConvexError) reaches the client with its
	// message wrapped as `[CONVEX Q(api/x:y)] [Request ID: ...] <msg> Called by client` in dev,
	// or with that same wrapper around the literal text "Server Error" in production (Convex's
	// own redaction of an unlabeled error). Either way the message starts with "[CONVEX " and
	// is never fit to show an admin -- this is what getErrorMessage falls back on `fallback`
	// for, instead of surfacing raw Convex internals or an opaque "Server Error".
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

	it("falls back for a non-Error value or an empty message", () => {
		expect(getErrorMessage("just a string", "fallback")).toBe("fallback");
		expect(getErrorMessage(new Error(""), "fallback")).toBe("fallback");
	});
});
