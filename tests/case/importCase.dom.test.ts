import { describe, expect, it } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import {
	CaseImportError,
	parseHTMLForm,
} from "../../src/lib/case/importCase.js";
import { makePersona, makeReferral } from "../support/fixtures.js";

// Serializes a Document back into an HTML string.
function serialize(doc: Document): string {
	return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

// Finds the form field with the given data-field name within a scope.
function fieldIn(scope: ParentNode, field: string): HTMLTextAreaElement {
	return scope.querySelector(`[data-field="${field}"]`) as HTMLTextAreaElement;
}

// Sets the text of a form field in the document.
function setField(scope: ParentNode, field: string, value: string): void {
	fieldIn(scope, field).textContent = value;
}

// Marks only the option with the given value as selected.
function selectOnly(select: HTMLSelectElement, matchValue: string): void {
	for (const option of Array.from(select.querySelectorAll("option"))) {
		option.removeAttribute("selected");
	}
	const target = select.querySelector(`option[value="${matchValue}"]`);
	if (target) target.setAttribute("selected", "");
}

// Selects an option pointing at a persona id that doesn't exist.
function selectGhostOption(select: HTMLSelectElement, ghostId: string): void {
	for (const option of Array.from(select.querySelectorAll("option"))) {
		option.removeAttribute("selected");
	}
	const option = select.ownerDocument.createElement("option");
	option.setAttribute("value", ghostId);
	option.setAttribute("selected", "");
	option.textContent = "Ghost";
	select.appendChild(option);
}

// Builds the export HTML for the input and parses it into a Document.
function buildDoc(input: Parameters<typeof buildHTMLForm>[0]): Document {
	return new DOMParser().parseFromString(buildHTMLForm(input), "text/html");
}

// Returns a lookup from persona name to persona id.
function idsByName(
	personas: { id: string; name: string }[],
): (name: string) => string {
	const byName = new Map(personas.map((p) => [p.name, p.id]));
	return (name: string) => byName.get(name) as string;
}

const baseCaseFields = {
	caseName: "Case",
	accessCode: "ABC123",
	simulationDurationMinutes: null as number | null,
	initialBrief: "Brief",
	commonInformation: "Shared context",
};

describe("parseHTMLForm — file shape", () => {
	// Tests that a file that is not a Case Lab export is rejected with CaseImportError.
	it("throws CaseImportError for a file that isn't a Case Lab export", () => {
		const html =
			"<!DOCTYPE html><html><body><p>Not a case file.</p></body></html>";
		expect(() => parseHTMLForm(html)).toThrow(CaseImportError);
	});

	// Tests that a file with no persona cards is rejected with CaseImportError.
	it("throws CaseImportError for a file with no persona cards", () => {
		const html = `<!DOCTYPE html><html><body>
			<div id="personas-list"></div>
			<div id="referrals-list"></div>
		</body></html>`;
		expect(() => parseHTMLForm(html)).toThrow(CaseImportError);
	});

	// Tests that a file where every persona is marked referred (no roots) is rejected.
	it("throws CaseImportError when every persona is marked referred (no roots)", () => {
		const a = makePersona();
		const b = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id)],
			roots: [],
		});
		expect(() => parseHTMLForm(html)).toThrow(CaseImportError);
	});
});

describe("parseHTMLForm — field extraction", () => {
	// Tests that case name, access code, brief, common information and duration are read and trimmed.
	it("reads and trims case name, access code, brief, common information, and duration", () => {
		const persona = makePersona();
		const html = buildHTMLForm({
			caseName: "  Acme Corp  ",
			accessCode: "  ABC-123  ",
			simulationDurationMinutes: 45,
			initialBrief: "  Read this first.  ",
			commonInformation: "  Shared budget context.  ",
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		const data = parseHTMLForm(html);
		expect(data.caseName).toBe("Acme Corp");
		expect(data.accessCode).toBe("ABC-123");
		expect(data.initialBrief).toBe("Read this first.");
		expect(data.commonInformation).toBe("Shared budget context.");
		expect(data.simulationDurationMinutes).toBe(45);
	});
});

describe("parseHTMLForm — parseNumberField (via simulation duration)", () => {
	// Tests that a non-numeric duration is rejected with an error naming the field.
	it("throws CaseImportError naming the field for a non-numeric value", () => {
		const persona = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		setField(doc, "simulation_duration_minutes", "not-a-number");
		expect(() => parseHTMLForm(serialize(doc))).toThrow(/Simulation duration/);
	});

	// Tests that a decimal duration is rounded.
	it("rounds a decimal value", () => {
		const persona = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		setField(doc, "simulation_duration_minutes", "12.6");
		expect(parseHTMLForm(serialize(doc)).simulationDurationMinutes).toBe(13);
	});

	// Tests that a blank duration becomes null.
	it("returns null for a blank value", () => {
		const persona = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			simulationDurationMinutes: null,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		expect(parseHTMLForm(html).simulationDurationMinutes).toBeNull();
	});
});

describe("parseHTMLForm — persona graph validation", () => {
	// Tests that a duplicate persona id is rejected.
	it("throws CaseImportError on a duplicate data-persona-id", () => {
		const persona = makePersona({ name: "Original" });
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		const originalCard = doc.querySelector(
			`[data-persona-id="${persona.id}"]`,
		) as Element;
		doc
			.getElementById("personas-list")
			?.appendChild(originalCard.cloneNode(true));

		expect(() => parseHTMLForm(serialize(doc))).toThrow(/Duplicate persona id/);
	});

	// Tests that a referral to a missing persona is rejected.
	it("throws CaseImportError for a referral pointing at a persona id that doesn't exist", () => {
		const a = makePersona();
		const b = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id)],
			roots: [a.id],
		});
		const danglingRow = (
			doc.querySelector(".referral-row") as Element
		).cloneNode(true) as Element;
		selectGhostOption(
			danglingRow.querySelector('select[data-role="to"]') as HTMLSelectElement,
			"ghost-id",
		);
		doc.getElementById("referrals-list")?.appendChild(danglingRow);

		expect(() => parseHTMLForm(serialize(doc))).toThrow(CaseImportError);
	});

	// Tests that a duplicate referral is rejected.
	it("throws CaseImportError for a duplicate referral (same from/to pair twice)", () => {
		const a = makePersona();
		const b = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id, "first")],
			roots: [a.id],
		});
		const duplicateRow = (
			doc.querySelector(".referral-row") as Element
		).cloneNode(true) as Element;
		setField(duplicateRow, "conditions", "second");
		doc.getElementById("referrals-list")?.appendChild(duplicateRow);

		expect(() => parseHTMLForm(serialize(doc))).toThrow(/Duplicate referral/);
	});

	// Tests that a self-referral is rejected.
	it("throws CaseImportError for a self-referral (from === to), which is a one-node cycle", () => {
		const a = makePersona();
		const b = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id)],
			roots: [a.id],
		});
		const selfRow = (doc.querySelector(".referral-row") as Element).cloneNode(
			true,
		) as Element;
		selectOnly(
			selfRow.querySelector('select[data-role="from"]') as HTMLSelectElement,
			a.id,
		);
		selectOnly(
			selfRow.querySelector('select[data-role="to"]') as HTMLSelectElement,
			a.id,
		);
		doc.getElementById("referrals-list")?.appendChild(selfRow);

		expect(() => parseHTMLForm(serialize(doc))).toThrow(/cycle detected/i);
	});

	// Tests that a cycle is rejected.
	it("throws CaseImportError for a referral cycle", () => {
		const p1 = makePersona();
		const p2 = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [p1, p2],
			referrals: [makeReferral(p1.id, p2.id), makeReferral(p2.id, p1.id)],
			roots: [p1.id],
		});
		expect(() => parseHTMLForm(html)).toThrow(/cycle detected/i);
	});

	// Tests that a persona nothing points at is rejected.
	it("throws CaseImportError naming a persona that isn't reachable from a root", () => {
		const root = makePersona();
		const orphan = makePersona({ name: "Orphan" });
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [root, orphan],
			referrals: [],
			roots: [root.id],
		});
		expect(() => parseHTMLForm(html)).toThrow(/Orphan/);
	});

	// Tests that two personas referring to the same third persona are both kept.
	it("keeps both parents when two personas refer to the same third persona (multi-parent)", () => {
		const parentA = makePersona();
		const parentB = makePersona();
		const shared = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [parentA, parentB, shared],
			referrals: [
				makeReferral(parentA.id, shared.id),
				makeReferral(parentB.id, shared.id),
			],
			roots: [parentA.id, parentB.id],
		});
		const data = parseHTMLForm(html);
		expect(data.personas.map((p) => p.name).sort()).toEqual(
			[parentA.name, parentB.name, shared.name].sort(),
		);
		expect(data.referrals).toHaveLength(2);
		const byName = idsByName(data.personas);
		expect(data.referrals).toEqual(
			expect.arrayContaining([
				{
					fromId: byName(parentA.name),
					toId: byName(shared.name),
					conditions: "",
				},
				{
					fromId: byName(parentB.name),
					toId: byName(shared.name),
					conditions: "",
				},
			]),
		);
	});
});

describe("parseHTMLForm — file sharing", () => {
	// Tests that each file's share conditions and perceived contents are read back, with the file left null.
	it("round-trips each file's shareConditions and perceivedContents, with file left null", () => {
		const persona = makePersona({
			files: [
				{ shareConditions: "Ask first.", perceivedContents: "A memo." },
				{ shareConditions: "Only if pressed.", perceivedContents: "Photos." },
			],
		});
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		const data = parseHTMLForm(html);
		expect(data.personas[0]?.files).toEqual([
			{
				file: null,
				shareConditions: "Ask first.",
				perceivedContents: "A memo.",
			},
			{
				file: null,
				shareConditions: "Only if pressed.",
				perceivedContents: "Photos.",
			},
		]);
	});

	// Tests that a persona with no files parses to an empty file list.
	it("produces no files when the persona has none", () => {
		const persona = makePersona({ files: [] });
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		const data = parseHTMLForm(html);
		expect(data.personas[0]?.files).toEqual([]);
	});
});
