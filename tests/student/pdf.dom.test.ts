import { describe, expect, it } from "vitest";
import { buildChatPdfBlob } from "../../src/lib/student/pdf.js";
import type { ExportPersonaOut } from "../../src/lib/types.js";

type PrintablePersona = Pick<ExportPersonaOut, "name" | "role" | "messages">;

// Builds a printable persona with defaults and optional overrides.
const persona = (
	overrides: Partial<PrintablePersona> = {},
): PrintablePersona => ({
	name: "Mary",
	role: "CFO",
	messages: [],
	...overrides,
});

// Reads a blob as one character per byte, so binary PDF streams survive being searched as text. (TextDecoder's "latin1" is really windows-1252 and would change some bytes.)
async function byteString(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return text;
}

// Inflates a zlib-compressed PDF stream given as one character per byte, or returns null if it is not compressed that way.
async function inflate(stream: string): Promise<string | null> {
	const bytes = Uint8Array.from(stream, (char) => char.charCodeAt(0));
	try {
		const inflated = new Blob([bytes])
			.stream()
			.pipeThrough(new DecompressionStream("deflate"));
		return await new Response(inflated).text();
	} catch {
		return null;
	}
}

// Counts the pages in a PDF blob.
async function pageCountOf(blob: Blob): Promise<number> {
	const raw = await byteString(blob);
	return (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

// Returns whether any of the PDF's compressed streams contains the given text.
async function pdfContainsText(blob: Blob, needle: string): Promise<boolean> {
	const raw = await byteString(blob);
	for (const [, stream] of raw.matchAll(
		/stream\r?\n([\s\S]*?)\r?\nendstream/g,
	)) {
		const inflated = stream === undefined ? null : await inflate(stream);
		if (inflated?.includes(`(${needle})`)) return true;
	}
	return false;
}

describe("buildChatPdfBlob", () => {
	// Tests that buildChatPdfBlob returns a non-empty application/pdf blob.
	it("returns a non-empty application/pdf blob", () => {
		const blob = buildChatPdfBlob([persona()], "Some notes");

		expect(blob.type).toBe("application/pdf");
		expect(blob.size).toBeGreaterThan(0);
	});

	// Tests that the PDF has one page per persona plus the leading notes page.
	it("produces one page per persona plus the leading notes page", async () => {
		const personas = [persona({ name: "Mary" }), persona({ name: "Tom" })];

		const blob = buildChatPdfBlob(personas, "notes");

		expect(await pageCountOf(blob)).toBe(personas.length + 1);
	});

	// Tests that an empty persona list produces a 'No unlocked personas' page without throwing.
	it("falls back to a 'No unlocked personas' page for an empty array, without throwing", async () => {
		expect(() => buildChatPdfBlob([], "notes")).not.toThrow();

		const blob = buildChatPdfBlob([], "notes");

		expect(await pageCountOf(blob)).toBe(2);
		expect(await pdfContainsText(blob, "No unlocked personas")).toBe(true);
	});

	// Tests that a persona with no messages renders 'No chat history.'.
	it("renders 'No chat history.' for a persona with no messages", async () => {
		const blob = buildChatPdfBlob([persona({ messages: [] })], "notes");

		expect(await pdfContainsText(blob, "No chat history.")).toBe(true);
	});

	// Tests that blank notes render 'No notes.'.
	it("renders 'No notes.' for blank notes", async () => {
		const blob = buildChatPdfBlob([persona()], "   ");

		expect(await pdfContainsText(blob, "No notes.")).toBe(true);
	});

	// Tests that a very long single message adds at least one extra page.
	it("forces at least one extra page for a very long single message", async () => {
		const shortBlob = buildChatPdfBlob(
			[persona({ messages: [{ role: "user", content: "hi" }] })],
			"notes",
		);
		const longMessage = "This is a very long message. ".repeat(400);
		const longBlob = buildChatPdfBlob(
			[persona({ messages: [{ role: "user", content: longMessage }] })],
			"notes",
		);

		const [shortPages, longPages] = await Promise.all([
			pageCountOf(shortBlob),
			pageCountOf(longBlob),
		]);
		expect(shortPages).toBe(2);
		expect(longPages).toBeGreaterThan(shortPages);
	});
});
