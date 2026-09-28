import { describe, expect, it } from "vitest";
import { ReplyExtractor } from "./replyStream";

// Feeds each chunk to the extractor and returns all the text it emitted, joined.
function feedAll(extractor: ReplyExtractor, chunks: string[]): string {
	return chunks.map((chunk) => extractor.feed(chunk)).join("");
}

describe("ReplyExtractor", () => {
	// Tests that reply text fed in a single chunk is extracted.
	it("extracts reply text fed in one chunk", () => {
		const extractor = new ReplyExtractor();
		const envelope =
			'{"reply": "Hello there.", "introduce": [], "send_files": []}';
		expect(extractor.feed(envelope)).toBe("Hello there.");
		expect(extractor.done).toBe(true);
	});

	// Tests that reply text split across arbitrary chunk boundaries is extracted.
	it("extracts reply text split across arbitrary chunk boundaries", () => {
		const extractor = new ReplyExtractor();
		const envelope =
			'{"reply": "Hello there.", "introduce": [], "send_files": []}';
		expect(feedAll(extractor, envelope.split(""))).toBe("Hello there.");
	});

	// Tests that extraction stops once the value closes and never leaks the trailing JSON.
	it("stops emitting once the value closes, and never leaks the trailing JSON", () => {
		const extractor = new ReplyExtractor();
		const chunks = [
			'{"reply": "Hi.',
			'", "introduce": ["R1"]',
			', "send_files": []}',
		];
		expect(feedAll(extractor, chunks)).toBe("Hi.");
		expect(extractor.feed("more text")).toBe("");
	});

	// Tests that simple JSON escapes are decoded.
	it("decodes simple escapes", () => {
		const extractor = new ReplyExtractor();
		const envelope =
			'{"reply": "Line one\\nLine \\"two\\" with a \\\\ backslash.", "introduce": [], "send_files": []}';
		expect(extractor.feed(envelope)).toBe(
			'Line one\nLine "two" with a \\ backslash.',
		);
	});

	// Tests that a unicode escape split mid-sequence is decoded.
	it("decodes a unicode escape split mid-sequence", () => {
		const extractor = new ReplyExtractor();
		const chunks = [
			'{"reply": "caf',
			"\\u00",
			"e9",
			'", "introduce": [], "send_files": []}',
		];
		expect(feedAll(extractor, chunks)).toBe("café");
	});

	// Tests that raw UTF-8 astral characters such as emoji are decoded without escaping.
	it("decodes raw UTF-8 astral characters (emoji) without escaping", () => {
		const extractor = new ReplyExtractor();
		const envelope =
			'{"reply": "Great news 🎉", "introduce": [], "send_files": []}';
		expect(extractor.feed(envelope)).toBe("Great news 🎉");
	});

	// Tests that a lone backslash at a chunk boundary carries over to the next feed.
	it("carries a lone backslash at a chunk boundary over to the next feed", () => {
		const extractor = new ReplyExtractor();
		const chunks = [
			'{"reply": "a',
			"\\",
			"n",
			'b", "introduce": [], "send_files": []}',
		];
		expect(feedAll(extractor, chunks)).toBe("a\nb");
	});

	// Tests that the extractor stays not-done when the reply prefix never matches.
	it("stays not-done when the reply prefix never matches", () => {
		const extractor = new ReplyExtractor();
		expect(extractor.feed('{"introduce": [], "send_files": []}')).toBe("");
		expect(extractor.done).toBe(false);
	});

	// Tests that an empty chunk, and any feed after done, are no-ops.
	it("treats an empty chunk and any feed after done as no-ops", () => {
		const extractor = new ReplyExtractor();
		expect(extractor.feed("")).toBe("");
		extractor.feed('{"reply": "Hi."');
		extractor.feed('"}');
		expect(extractor.done).toBe(true);
		expect(extractor.feed("ignored")).toBe("");
	});
});
