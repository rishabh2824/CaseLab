import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";
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

// Counts the pages in a PDF blob.
async function pageCountOf(blob: Blob): Promise<number> {
	const raw = Buffer.from(await blob.arrayBuffer()).toString("latin1");
	return (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

// Returns whether any of the PDF's compressed streams contains the given text.
async function pdfContainsText(blob: Blob, needle: string): Promise<boolean> {
	const raw = Buffer.from(await blob.arrayBuffer()).toString("latin1");
	const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec loop idiom
	while ((match = streamRe.exec(raw))) {
		const streamContent = match[1];
		if (streamContent === undefined) continue;
		try {
			const inflated = inflateSync(
				Buffer.from(streamContent, "latin1"),
			).toString("latin1");
			if (inflated.includes(`(${needle})`)) return true;
		} catch {}
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
