import { describe, expect, it } from "vitest";
import { FLAG_LIMIT, flagReply, isChatEnded } from "./flags";

describe("isChatEnded", () => {
	// Tests that a chat ends exactly when the flag count reaches the limit.
	it("ends the chat at FLAG_LIMIT flags and not before", () => {
		expect(isChatEnded(0)).toBe(false);
		expect(isChatEnded(FLAG_LIMIT - 1)).toBe(false);
		expect(isChatEnded(FLAG_LIMIT)).toBe(true);
		expect(isChatEnded(FLAG_LIMIT + 1)).toBe(true);
	});
});

describe("flagReply", () => {
	// Tests that flagReply names the persona when ending the conversation.
	it("names the persona when ending the conversation", () => {
		expect(flagReply("Mary", true)).toMatch(
			/^Mary is ending this conversation/,
		);
	});

	// Tests that flagReply gives a fixed warning regardless of name when not ending.
	it("is a fixed warning regardless of name when not ending", () => {
		expect(flagReply("Mary", false)).toBe(
			"I am not able to follow that. Please send a clear, respectful, case-related " +
				"question if you want to continue.",
		);
	});
});
