// Client project: buildChatPdfBlob just needs a Blob constructor, which jsdom
// provides — it doesn't touch the DOM directly, but jsPDF's internals expect
// a browser-ish environment (Blob/canvas shims) that node lacks.
import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Api } from "../types.js";
import { buildChatPdfBlob, slugifyFileName } from "./pdf.js";

type PrintablePersona = Pick<
	Api<"ExportPersonaOut">,
	"name" | "role" | "messages"
>;

const persona = (
	overrides: Partial<PrintablePersona> = {},
): PrintablePersona => ({
	name: "Mary",
	role: "CFO",
	messages: [],
	...overrides,
});

// buildChatPdfBlob only exposes a Blob, not the jsPDF document instance
// itself. Object dictionaries (including each page's `/Type /Page` entry)
// are never Flate-compressed even with `compress: true`, only the content
// streams are — so page count can be read straight off the raw bytes. The
// `\b` boundary is what keeps this from also matching the single `/Type
// /Pages` tree node ("Page" immediately followed by "s" fails a boundary).
async function pageCountOf(blob: Blob): Promise<number> {
	const raw = Buffer.from(await blob.arrayBuffer()).toString("latin1");
	return (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

// Every literal string buildChatPdfBlob writes (titles, "No notes.", chat
// lines, ...) ends up inside a Flate-compressed content stream, so it can't
// be grepped off the raw PDF bytes directly. This walks each `stream ...
// endstream` block, inflates it, and checks the decompressed PDF text-show
// operators (e.g. `(No chat history.) Tj`) for the literal substring.
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
		} catch {
			// Not a Flate-compressed stream (e.g. an embedded font) — skip it.
		}
	}
	return false;
}

describe("slugifyFileName", () => {
	it("slugifies a normal title", () => {
		expect(slugifyFileName("Sterling Industries Chat")).toBe(
			"sterling-industries-chat",
		);
	});

	it("falls back to case-lab-chat-export for a blank string", () => {
		expect(slugifyFileName("   ")).toBe("case-lab-chat-export");
	});

	it("falls back to case-lab-chat-export for null", () => {
		expect(slugifyFileName(null)).toBe("case-lab-chat-export");
	});

	it("falls back to case-lab-chat-export for punctuation-only input", () => {
		expect(slugifyFileName("!!!???")).toBe("case-lab-chat-export");
	});
});

describe("buildChatPdfBlob", () => {
	it("returns a non-empty application/pdf blob", () => {
		const blob = buildChatPdfBlob([persona()], "Some notes");

		expect(blob.type).toBe("application/pdf");
		expect(blob.size).toBeGreaterThan(0);
	});

	it("produces one page per persona plus the leading notes page", async () => {
		const personas = [persona({ name: "Mary" }), persona({ name: "Tom" })];

		const blob = buildChatPdfBlob(personas, "notes");

		expect(await pageCountOf(blob)).toBe(personas.length + 1);
	});

	it("falls back to a 'No unlocked personas' page for an empty array, without throwing", async () => {
		expect(() => buildChatPdfBlob([], "notes")).not.toThrow();

		const blob = buildChatPdfBlob([], "notes");

		// Notes page + exactly one fallback persona page.
		expect(await pageCountOf(blob)).toBe(2);
		expect(await pdfContainsText(blob, "No unlocked personas")).toBe(true);
	});

	it("renders 'No chat history.' for a persona with no messages", async () => {
		const blob = buildChatPdfBlob([persona({ messages: [] })], "notes");

		expect(await pdfContainsText(blob, "No chat history.")).toBe(true);
	});

	it("renders 'No notes.' for blank notes", async () => {
		const blob = buildChatPdfBlob([persona()], "   ");

		expect(await pdfContainsText(blob, "No notes.")).toBe(true);
	});

	it("forces at least one extra page for a very long single message", async () => {
		const shortBlob = buildChatPdfBlob(
			[persona({ messages: [{ role: "user", content: "hi" }] })],
			"notes",
		);
		// Long enough to overflow the page well past writeSection's wrap +
		// page-break loop — the only real logic in this file.
		const longMessage = "This is a very long message. ".repeat(400);
		const longBlob = buildChatPdfBlob(
			[persona({ messages: [{ role: "user", content: longMessage }] })],
			"notes",
		);

		const [shortPages, longPages] = await Promise.all([
			pageCountOf(shortBlob),
			pageCountOf(longBlob),
		]);
		expect(shortPages).toBe(2); // notes page + 1 persona page, no wrapping
		expect(longPages).toBeGreaterThan(shortPages);
	});
});
