import { describe, expect, it } from "vitest";
import { ReplyExtractor } from "./replyStream";

function feedAll(extractor: ReplyExtractor, chunks: string[]): string {
	return chunks.map((chunk) => extractor.feed(chunk)).join("");
}

describe("ReplyExtractor", () => {
	it("extracts reply text fed in one chunk", () => {
		const extractor = new ReplyExtractor();
		const envelope = '{"reply": "Hello there.", "introduce": [], "send_files": []}';
		expect(extractor.feed(envelope)).toBe("Hello there.");
		expect(extractor.done).toBe(true);
	});

	it("extracts reply text split across arbitrary chunk boundaries", () => {
		const extractor = new ReplyExtractor();
		const envelope = '{"reply": "Hello there.", "introduce": [], "send_files": []}';
		// One character per feed() call -- the most adversarial chunking possible, including
		// splitting mid-prefix and mid-value.
		expect(feedAll(extractor, envelope.split(""))).toBe("Hello there.");
	});

	it("stops emitting once the value closes, and never leaks the trailing JSON", () => {
		const extractor = new ReplyExtractor();
		const chunks = ['{"reply": "Hi.', '", "introduce": ["R1"]', ', "send_files": []}'];
		expect(feedAll(extractor, chunks)).toBe("Hi.");
		expect(extractor.feed("more text")).toBe("");
	});

	it("decodes simple escapes", () => {
		const extractor = new ReplyExtractor();
		const envelope = '{"reply": "Line one\\nLine \\"two\\" with a \\\\ backslash.", "introduce": [], "send_files": []}';
		expect(extractor.feed(envelope)).toBe('Line one\nLine "two" with a \\ backslash.');
	});

	it("decodes a unicode escape split mid-sequence", () => {
		const extractor = new ReplyExtractor();
		// é. Split right in the middle of the é escape sequence.
		const chunks = ['{"reply": "caf', "\\u00", "e9", '", "introduce": [], "send_files": []}'];
		expect(feedAll(extractor, chunks)).toBe("café");
	});

	it("decodes raw UTF-8 astral characters (emoji) without escaping", () => {
		const extractor = new ReplyExtractor();
		const envelope = '{"reply": "Great news 🎉", "introduce": [], "send_files": []}';
		expect(extractor.feed(envelope)).toBe("Great news 🎉");
	});

	it("carries a lone backslash at a chunk boundary over to the next feed", () => {
		const extractor = new ReplyExtractor();
		const chunks = ['{"reply": "a', "\\", "n", 'b", "introduce": [], "send_files": []}'];
		expect(feedAll(extractor, chunks)).toBe("a\nb");
	});

	it("stays not-done when the reply prefix never matches", () => {
		const extractor = new ReplyExtractor();
		expect(extractor.feed('{"introduce": [], "send_files": []}')).toBe("");
		expect(extractor.done).toBe(false);
	});

	it("treats an empty chunk and any feed after done as no-ops", () => {
		const extractor = new ReplyExtractor();
		expect(extractor.feed("")).toBe("");
		extractor.feed('{"reply": "Hi."');
		extractor.feed('"}');
		expect(extractor.done).toBe(true);
		expect(extractor.feed("ignored")).toBe("");
	});
});
