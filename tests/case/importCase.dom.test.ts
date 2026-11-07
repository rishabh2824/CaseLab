import { describe, expect, it } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import {
	CaseImportError,
	parseHTMLForm,
} from "../../src/lib/case/importCase.js";
import { makePersona, makeReferral } from "../support/factories.js";

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
	name: "Case",
	accessCode: "ABC123",
	duration: null as number | null,
	brief: "Brief",
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

	// Tests that a file where every persona is referred by another, so none can start, is rejected.
	it("throws CaseImportError when every persona is referred by another (no roots)", () => {
		const a = makePersona();
		const b = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id), makeReferral(b.id, a.id)],
		});
		expect(() => parseHTMLForm(html)).toThrow(CaseImportError);
	});
});

describe("parseHTMLForm — field extraction", () => {
	// Tests that case name, access code, brief, common information and duration are read and trimmed.
	it("reads and trims case name, access code, brief, common information, and duration", () => {
		const persona = makePersona();
		const html = buildHTMLForm({
			name: "  Acme Corp  ",
			accessCode: "  ABC-123  ",
			duration: 45,
			brief: "  Read this first.  ",
			commonInformation: "  Shared budget context.  ",
			personas: [persona],
			referrals: [],
		});
		const data = parseHTMLForm(html);
		expect(data.name).toBe("Acme Corp");
		expect(data.accessCode).toBe("ABC-123");
		expect(data.brief).toBe("Read this first.");
		expect(data.commonInformation).toBe("Shared budget context.");
		expect(data.duration).toBe(45);
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
		});
		setField(doc, "simulation_duration_minutes", "not-a-number");
		expect(() => parseHTMLForm(serialize(doc))).toThrow(/Time limit/);
	});

	// Tests that a decimal duration is rounded.
	it("rounds a decimal value", () => {
		const persona = makePersona();
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
		});
		setField(doc, "simulation_duration_minutes", "12.6");
		expect(parseHTMLForm(serialize(doc)).duration).toBe(13);
	});

	// Tests that a blank duration becomes null.
	it("returns null for a blank value", () => {
		const persona = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			duration: null,
			personas: [persona],
			referrals: [],
		});
		expect(parseHTMLForm(html).duration).toBeNull();
	});
});

describe("parseHTMLForm — persona graph validation", () => {
	// Tests that a cycle is rejected.
	it("throws CaseImportError for a referral cycle", () => {
		const p1 = makePersona();
		const p2 = makePersona();
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [p1, p2],
			referrals: [makeReferral(p1.id, p2.id), makeReferral(p2.id, p1.id)],
		});
		expect(() => parseHTMLForm(html)).toThrow(/cycle/i);
	});

	// Tests that a persona nothing refers to is imported as another starting persona, not rejected.
	it("imports a persona nothing refers to as a starting persona", () => {
		const root = makePersona();
		const other = makePersona({ name: "Standalone" });
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [root, other],
			referrals: [],
		});
		expect(parseHTMLForm(html).personas).toHaveLength(2);
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
					conditions: "the student asks",
				},
				{
					fromId: byName(parentB.name),
					toId: byName(shared.name),
					conditions: "the student asks",
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
		});
		const data = parseHTMLForm(html);
		expect(data.personas[0]?.files).toEqual([]);
	});
});

describe("parseHTMLForm — persona number fields", () => {
	// Tests that a persona's response delay and availability are read and rounded like the time limit.
	it("reads and rounds a persona's response delay and availability", () => {
		const persona = makePersona({ name: "Mary" });
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
		});
		setField(doc, "response_delay_seconds", "29.6");
		setField(doc, "availability_minutes", " 15 ");

		const [imported] = parseHTMLForm(serialize(doc)).personas;
		expect(imported).toMatchObject({
			name: "Mary",
			responseDelaySeconds: 30,
			availabilityMinutes: 15,
		});
	});

	// Tests that a non-numeric response delay is refused with an error naming the persona's delay.
	it("throws CaseImportError naming the response delay for a non-numeric value", () => {
		const persona = makePersona({ id: "mary-id" });
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
		});
		setField(doc, "response_delay_seconds", "a while");

		expect(() => parseHTMLForm(serialize(doc))).toThrow(CaseImportError);
		expect(() => parseHTMLForm(serialize(doc))).toThrow(
			'Couldn\'t read "mary-id response delay" as a number (was "a while").',
		);
	});

	// Tests that a non-numeric availability is refused with an error naming the persona's availability.
	it("throws CaseImportError naming the availability for a non-numeric value", () => {
		const persona = makePersona({ id: "mary-id" });
		const doc = buildDoc({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
		});
		setField(doc, "availability_minutes", "forever");

		expect(() => parseHTMLForm(serialize(doc))).toThrow(
			'Couldn\'t read "mary-id availability" as a number (was "forever").',
		);
	});
});

describe("parseHTMLForm — damaged rows", () => {
	// Tests that a referral row with one end missing is dropped, leaving its target as a starting persona.
	it("drops a referral row that is missing one end", () => {
		const a = makePersona({ name: "Mary" });
		const b = makePersona({ name: "Bob" });
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [makeReferral(a.id, b.id)],
		});
		doc.querySelector('select[data-role="to"]')!.replaceChildren();

		const imported = parseHTMLForm(serialize(doc));
		expect(imported.referrals).toEqual([]);
		expect(imported.personas.map((p) => p.name)).toEqual(["Mary", "Bob"]);
	});

	// Tests that a persona card whose id was blanked out is skipped rather than imported without an id.
	it("skips a persona card with a blank id", () => {
		const a = makePersona({ name: "Mary" });
		const b = makePersona({ name: "Bob" });
		const doc = buildDoc({
			...baseCaseFields,
			personas: [a, b],
			referrals: [],
		});
		doc
			.querySelectorAll(".persona-card")[1]!
			.setAttribute("data-persona-id", "");

		const imported = parseHTMLForm(serialize(doc));
		expect(imported.personas.map((p) => p.name)).toEqual(["Mary"]);
	});
});
