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
		const { data, warnings } = parseHTMLForm(html);
		expect(data.caseName).toBe("Acme Corp");
		expect(data.accessCode).toBe("ABC-123");
		expect(data.initialBrief).toBe("Read this first.");
		expect(data.commonInformation).toBe("Shared budget context.");
		expect(data.simulationDurationMinutes).toBe(45);
		expect(warnings).toEqual([]);
	});
});

describe("parseHTMLForm — parseNumberField (via simulation duration)", () => {
	// Tests that a non-numeric duration becomes null with a warning naming the field.
	it("returns null plus a warning naming the field for a non-numeric value", () => {
		const persona = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		setField(doc, "simulation_duration_minutes", "not-a-number");
		const { data, warnings } = parseHTMLForm(serialize(doc));
		expect(data.simulationDurationMinutes).toBeNull();
		expect(warnings.some((w) => w.includes("Simulation duration"))).toBe(true);
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
		const { data } = parseHTMLForm(serialize(doc));
		expect(data.simulationDurationMinutes).toBe(13);
	});

	// Tests that a blank duration becomes null without a warning.
	it("returns null with no warning for a blank value", () => {
		const persona = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			simulationDurationMinutes: null,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		const { data, warnings } = parseHTMLForm(html);
		expect(data.simulationDurationMinutes).toBeNull();
		expect(warnings).toEqual([]);
	});
});

describe("parseHTMLForm — persona graph validation", () => {
	// Tests that a duplicate persona id keeps the first card and warns.
	it("keeps the first card and drops the rest on a duplicate data-persona-id, with a warning", () => {
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
		const duplicateCard = originalCard.cloneNode(true) as Element;
		setField(duplicateCard, "name", "Duplicate");
		doc.getElementById("personas-list")?.appendChild(duplicateCard);

		const { data, warnings } = parseHTMLForm(serialize(doc));
		expect(data.personas).toHaveLength(1);
		expect(data.personas[0]?.name).toBe("Original");
		expect(warnings.some((w) => w.includes("Duplicate persona id"))).toBe(true);
	});

	// Tests that a referral to a missing persona is skipped with a warning.
	it("skips a referral pointing at a persona id that doesn't exist, with a warning", () => {
		const a = makePersona();
		const b = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id)],
			roots: [a.id],
		});
		const validRow = doc.querySelector(".referral-row") as Element;
		const danglingRow = validRow.cloneNode(true) as Element;
		const toSelect = danglingRow.querySelector(
			'select[data-role="to"]',
		) as HTMLSelectElement;
		selectGhostOption(toSelect, "ghost-id");
		doc.getElementById("referrals-list")?.appendChild(danglingRow);

		const { data, warnings } = parseHTMLForm(serialize(doc));
		const byName = idsByName(data.personas);
		expect(data.referrals).toEqual([
			{ fromId: byName(a.name), toId: byName(b.name), conditions: "" },
		]);
		expect(warnings.some((w) => w.includes("wasn't found"))).toBe(true);
	});

	// Tests that a duplicate referral is skipped, keeping only the first.
	it("skips a duplicate referral (same from/to pair twice), keeping only the first", () => {
		const a = makePersona();
		const b = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id, "first")],
			roots: [a.id],
		});
		const validRow = doc.querySelector(".referral-row") as Element;
		const duplicateRow = validRow.cloneNode(true) as Element;
		setField(duplicateRow, "conditions", "second");
		doc.getElementById("referrals-list")?.appendChild(duplicateRow);

		const { data, warnings } = parseHTMLForm(serialize(doc));
		const byName = idsByName(data.personas);
		expect(data.referrals).toEqual([
			{ fromId: byName(a.name), toId: byName(b.name), conditions: "first" },
		]);
		expect(warnings.some((w) => w.includes("duplicate referral"))).toBe(true);
	});

	// Tests that a self-referral is skipped with a warning.
	it("skips a self-referral (from === to), with a warning", () => {
		const a = makePersona();
		const b = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id)],
			roots: [a.id],
		});
		const validRow = doc.querySelector(".referral-row") as Element;
		const selfRow = validRow.cloneNode(true) as Element;
		const fromSelect = selfRow.querySelector(
			'select[data-role="from"]',
		) as HTMLSelectElement;
		const toSelect = selfRow.querySelector(
			'select[data-role="to"]',
		) as HTMLSelectElement;
		selectOnly(fromSelect, a.id);
		selectOnly(toSelect, a.id);
		doc.getElementById("referrals-list")?.appendChild(selfRow);

		const { data, warnings } = parseHTMLForm(serialize(doc));
		const byName = idsByName(data.personas);
		expect(data.referrals).toEqual([
			{ fromId: byName(a.name), toId: byName(b.name), conditions: "" },
		]);
		expect(warnings.some((w) => w.includes("refers to itself"))).toBe(true);
	});

	// Tests that a cycle unreachable from any root is broken and its cluster removed.
	it("breaks a cycle disconnected from any root, dropping the back edge and removing the whole unreachable cluster", () => {
		const p1 = makePersona();
		const p2 = makePersona();
		const p3 = makePersona();
		const p4 = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [p1, p2, p3, p4],
			referrals: [
				makeReferral(p1.id, p2.id),
				makeReferral(p3.id, p4.id),
				makeReferral(p4.id, p3.id),
			],
			roots: [p1.id],
		});
		const { data, warnings } = parseHTMLForm(html);

		expect(data.personas.map((p) => p.name)).toEqual([p1.name, p2.name]);
		const byName = idsByName(data.personas);
		expect(data.referrals).toEqual([
			{ fromId: byName(p1.name), toId: byName(p2.name), conditions: "" },
		]);
		expect(warnings.some((w) => w.includes("Cycle detected"))).toBe(true);
		expect(warnings.some((w) => w.includes(p3.id))).toBe(true);
		expect(warnings.some((w) => w.includes(p4.id))).toBe(true);
	});

	// Tests that a referred persona nothing points at is removed with a warning.
	it("removes a persona marked referred that nothing points at, with a warning naming it", () => {
		const root = makePersona();
		const orphan = makePersona({ name: "Orphan" });
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [root, orphan],
			referrals: [],
			roots: [root.id],
		});
		const { data, warnings } = parseHTMLForm(html);
		expect(data.personas.map((p) => p.name)).toEqual([root.name]);
		expect(
			warnings.some((w) => w.includes(orphan.id) && w.includes("Orphan")),
		).toBe(true);
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
		const { data, warnings } = parseHTMLForm(html);
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
		expect(warnings).toEqual([]);
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
		const { data } = parseHTMLForm(html);
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
		const { data } = parseHTMLForm(html);
		expect(data.personas[0]?.files).toEqual([]);
	});
});

describe("parseHTMLForm — clean file", () => {
	// Tests that a well-formed export parses with no warnings.
	it("returns no warnings for a well-formed export", () => {
		const root = makePersona();
		const referred = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [root, referred],
			referrals: [makeReferral(root.id, referred.id)],
			roots: [root.id],
		});
		const { warnings } = parseHTMLForm(html);
		expect(warnings).toEqual([]);
	});
});
