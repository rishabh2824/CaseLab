// Node project: pure data-shaping helpers, no DOM required.
import { describe, expect, it } from "vitest";
import type { Api } from "../types.js";
import {
	getPersonaInitials,
	normalizeHistories,
	normalizeMessages,
} from "./contacts.js";

describe("normalizeMessages", () => {
	it("keeps user and assistant messages", () => {
		const messages: Api<"ChatMessage">[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];

		expect(normalizeMessages(messages)).toEqual(messages);
	});

	it("drops messages with a role other than user/assistant", () => {
		const messages = [
			{ role: "system", content: "you are a helpful bot" },
			{ role: "user", content: "hi" },
		] as Api<"ChatMessage">[];

		expect(normalizeMessages(messages)).toEqual([
			{ role: "user", content: "hi" },
		]);
	});

	it("drops messages whose content is not a string", () => {
		const messages = [
			{ role: "user", content: 42 },
			{ role: "assistant", content: null },
			{ role: "user", content: "kept" },
		] as unknown as Api<"ChatMessage">[];

		expect(normalizeMessages(messages)).toEqual([
			{ role: "user", content: "kept" },
		]);
	});

	it("tolerates undefined and null input, returning an empty array", () => {
		expect(normalizeMessages(undefined)).toEqual([]);
		// The default parameter only covers a truly omitted argument; an
		// explicit `null` still reaches the `?? []` inside the function body.
		expect(normalizeMessages(null as unknown as Api<"ChatMessage">[])).toEqual(
			[],
		);
	});
});

describe("normalizeHistories", () => {
	it("normalizes each persona's messages independently while preserving keys", () => {
		const histories = {
			mary: [
				{ role: "user", content: "hi" },
				{ role: "system", content: "dropped" },
			],
			// mary and bob are unrelated ids on purpose: this asserts the fix
			// doesn't leak state (e.g. a shared filtered array) between personas.
			bob: [{ role: "assistant", content: 7 }],
		} as unknown as Record<string, Api<"ChatMessage">[]>;

		expect(normalizeHistories(histories)).toEqual({
			mary: [{ role: "user", content: "hi" }],
			bob: [],
		});
	});

	it("returns an empty object for an empty object", () => {
		expect(normalizeHistories({})).toEqual({});
	});
});

describe("getPersonaInitials", () => {
	it("takes the first letter of a single word", () => {
		expect(getPersonaInitials("Mary")).toBe("M");
	});

	it("takes the first letter of each of two words", () => {
		expect(getPersonaInitials("Mary Smith")).toBe("MS");
	});

	it("takes only the first two words when there are three or more", () => {
		expect(getPersonaInitials("Mary Jane Smith")).toBe("MJ");
	});

	it.each([undefined, null, ""])("returns 'NA' for %j", (value) => {
		expect(getPersonaInitials(value)).toBe("NA");
	});

	it("collapses leading and repeated spaces instead of producing a blank initial", () => {
		// A naive split(" ") would produce a leading "" entry from the double
		// space and pick that as the "first" part.
		expect(getPersonaInitials("  Mary   Smith")).toBe("MS");
	});

	it("handles a single-character name", () => {
		expect(getPersonaInitials("X")).toBe("X");
	});

	it("handles a unicode/emoji name without throwing", () => {
		const name = "👩‍⚕️ Doctor";
		// `part[0]` indexes by UTF-16 code unit, not grapheme, so an astral
		// emoji (a surrogate pair) only contributes its leading half here —
		// documenting the real behavior rather than a hand-typed literal that's
		// easy to get subtly wrong.
		expect(getPersonaInitials(name)).toBe(`${name[0]?.toUpperCase()}D`);
		expect(getPersonaInitials(name)).toHaveLength(2);
	});
});
