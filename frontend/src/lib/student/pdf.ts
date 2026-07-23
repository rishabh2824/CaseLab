// PDF export of a student's chat transcript, built with jsPDF.

import jsPDF from "jspdf";
import type { ExportPersonaOut } from "../types.js";
import { slugify } from "./Helpers.js";

const PAGE_MARGIN = 54;
const BODY_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 14;
const LINE_HEIGHT = 15;
const TITLE_GAP = LINE_HEIGHT * 1.5;

export const slugifyFileName = (value: unknown): string =>
	slugify(value) || "case-lab-chat-export";

// Writes a titled section starting at the current page, adding real page breaks whenever content overflows.
const writeSection = (doc: jsPDF, title: string, bodyLines: string[]): void => {
	const pageWidth = doc.internal.pageSize.getWidth();
	const pageHeight = doc.internal.pageSize.getHeight();
	const maxWidth = pageWidth - PAGE_MARGIN * 2;
	let y = PAGE_MARGIN;

	doc.setFont("helvetica", "bold");
	doc.setFontSize(TITLE_FONT_SIZE);
	doc.text(title, PAGE_MARGIN, y);
	y += TITLE_GAP;

	doc.setFont("helvetica", "normal");
	doc.setFontSize(BODY_FONT_SIZE);

	for (const rawLine of bodyLines) {
		const wrapped: string[] = rawLine
			? doc.splitTextToSize(rawLine, maxWidth)
			: [""];
		for (const line of wrapped) {
			if (y > pageHeight - PAGE_MARGIN) {
				doc.addPage();
				y = PAGE_MARGIN;
			}
			doc.text(line, PAGE_MARGIN, y);
			y += LINE_HEIGHT;
		}
	}
};

// Only name/role/messages are read here — accepting this narrower shape
// (rather than the full ExportPersonaOut, which also carries an id nothing
// in this file needs) is also what lets the "no unlocked personas" fallback
// below satisfy the type without inventing a placeholder id.
type PrintablePersona = Pick<ExportPersonaOut, "name" | "role" | "messages">;

export const buildChatPdfBlob = (
	personas: PrintablePersona[],
	notes = "",
): Blob => {
	const printablePersonas: PrintablePersona[] =
		personas.length > 0
			? personas
			: [{ name: "No unlocked personas", role: "", messages: [] }];
	const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });

	const trimmedNotes = notes.trim();
	writeSection(
		doc,
		"My Notes",
		trimmedNotes ? trimmedNotes.split(/\r?\n/) : ["No notes."],
	);

	printablePersonas.forEach((persona) => {
		doc.addPage();
		const speakerName = persona.name || "Persona";
		const title = persona.role
			? `${speakerName} - ${persona.role}`
			: speakerName;
		const messages = persona.messages ?? [];
		const lines =
			messages.length === 0
				? ["No chat history."]
				: messages.flatMap((message) => {
						const label = message.role === "user" ? "You" : speakerName;
						const messageLines = `${label}: ${message.content ?? ""}`.split(
							/\r?\n/,
						);
						return [...messageLines, ""];
					});
		writeSection(doc, title, lines);
	});

	return doc.output("blob");
};
