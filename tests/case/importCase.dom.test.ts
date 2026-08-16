// Client project: parseHTMLForm is a DOMParser-based parser, needs jsdom.
import { describe, expect, it } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import {
	CaseImportError,
	parseHTMLForm,
} from "../../src/lib/case/importCase.js";
import { makePersona, makeReferral } from "../support/fixtures.js";

// Serializes a mutated Document back into the string parseHTMLForm expects.
// Mutating the parsed Document (rather than string-splicing the template) is
// what keeps these tests immune to unrelated markup/whitespace changes in
// exportCase.ts.
function serialize(doc: Document): string {
	return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

function fieldIn(scope: ParentNode, field: string): HTMLTextAreaElement {
	return scope.querySelector(`[data-field="${field}"]`) as HTMLTextAreaElement;
}

// Sets a <textarea data-field> value by rewriting its child text node rather
// than its `.value` property: jsdom (like real browsers) only serializes a
// textarea's original text content via outerHTML, so a bare `.value = ...`
// assignment would be silently lost the moment we re-parse the string.
function setField(scope: ParentNode, field: string, value: string): void {
	fieldIn(scope, field).textContent = value;
}

// Same story for <select>: the "selected" HTML attribute is what survives
// serialization, not the live `.value` property (verified empirically —
// setting `.value` alone reverts to the first option on re-parse).
function selectOnly(select: HTMLSelectElement, matchValue: string): void {
	for (const option of Array.from(select.querySelectorAll("option"))) {
		option.removeAttribute("selected");
	}
	const target = select.querySelector(`option[value="${matchValue}"]`);
	if (target) target.setAttribute("selected", "");
}

// Appends a brand-new <option> (representing an id that doesn't correspond
// to any persona) and selects it — the only way to simulate a referral
// dangling at an id the graph has never heard of, since buildHTMLForm's own
// personaOptions() only ever emits options for real personas.
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

function buildDoc(input: Parameters<typeof buildHTMLForm>[0]): Document {
	return new DOMParser().parseFromString(buildHTMLForm(input), "text/html");
}

const baseCaseFields = {
	caseName: "Case",
	accessCode: "ABC123",
	simulationDurationMinutes: null as number | null,
	initialBrief: "Brief",
	commonInformation: "Shared context",
};

describe("parseHTMLForm — file shape", () => {
	it("throws CaseImportError for a file that isn't a Case Lab export", () => {
		const html =
			"<!DOCTYPE html><html><body><p>Not a case file.</p></body></html>";
		expect(() => parseHTMLForm(html)).toThrow(CaseImportError);
	});

	it("throws CaseImportError for a file with no persona cards", () => {
		// Hand-rolled: buildHTMLForm can't itself produce an empty persona
		// list (it always scaffolds at least one persona), so this shape is
		// only reachable via a hand-edited/corrupted export.
		const html = `<!DOCTYPE html><html><body>
			<div id="personas-list"></div>
			<div id="referrals-list"></div>
		</body></html>`;
		expect(() => parseHTMLForm(html)).toThrow(CaseImportError);
	});

	it("throws CaseImportError when every persona is marked referred (no roots)", () => {
		const a = makePersona();
		const b = makePersona();
		// roots: [] means neither card gets data-persona-root="true".
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
		expect(data.referrals).toEqual([
			{ from_id: a.id, to_id: b.id, conditions: "" },
		]);
		expect(warnings.some((w) => w.includes("wasn't found"))).toBe(true);
	});

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
		expect(data.referrals).toEqual([
			{ from_id: a.id, to_id: b.id, conditions: "" },
		]);
		expect(warnings.some((w) => w.includes("refers to itself"))).toBe(true);
	});

	it("breaks a cycle disconnected from any root, dropping the back edge and removing the whole unreachable cluster", () => {
		// p1 is the only root, reaching only p2. p3 <-> p4 form a 2-cycle with
		// no connection to p1 at all. The code's own comment insists cycle
		// detection (pass 1: walks every persona, not just roots) and root
		// reachability (pass 2) are separate passes — this is the case that
		// proves it: p3's *only* inbound edge is the one the cycle pass drops
		// (p4 -> p3), so p3 has zero accepted inbound edges even before
		// reachability is considered, and p4 is unreachable transitively
		// through it. Conflating the two passes would either keep this cycle
		// (never walked, since neither p3 nor p4 is root-reachable) or drop
		// personas the cycle pass didn't actually touch.
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

		expect(data.personas.map((p) => p.id)).toEqual([p1.id, p2.id]);
		expect(data.referrals).toEqual([
			{ from_id: p1.id, to_id: p2.id, conditions: "" },
		]);
		expect(warnings.some((w) => w.includes("Cycle detected"))).toBe(true);
		expect(warnings.some((w) => w.includes(p3.id))).toBe(true);
		expect(warnings.some((w) => w.includes(p4.id))).toBe(true);
	});

	it("removes a persona marked referred that nothing points at, with a warning naming it", () => {
		const root = makePersona();
		const orphan = makePersona({ name: "Orphan" });
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [root, orphan],
			referrals: [], // nothing refers to `orphan`
			roots: [root.id],
		});
		const { data, warnings } = parseHTMLForm(html);
		expect(data.personas.map((p) => p.id)).toEqual([root.id]);
		expect(
			warnings.some((w) => w.includes(orphan.id) && w.includes("Orphan")),
		).toBe(true);
	});

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
		expect(data.personas.map((p) => p.id).sort()).toEqual(
			[parentA.id, parentB.id, shared.id].sort(),
		);
		expect(data.referrals).toHaveLength(2);
		expect(data.referrals).toEqual(
			expect.arrayContaining([
				{ from_id: parentA.id, to_id: shared.id, conditions: "" },
				{ from_id: parentB.id, to_id: shared.id, conditions: "" },
			]),
		);
		expect(warnings).toEqual([]);
	});
});

describe("parseHTMLForm — file sharing", () => {
	it("produces one placeholder file entry when can_share_files is yes", () => {
		// Only files.length > 0 drives the exported "yes"/"no" toggle (see
		// fileShare() in exportCase.ts) — the entry's own content never makes
		// it into the export, so a minimal DraftFileEntry is enough here.
		const persona = makePersona({
			files: [{ share_conditions: "Ask first." }],
		});
		const html = buildHTMLForm({
			...baseCaseFields,
			personas: [persona],
			referrals: [],
			roots: [persona.id],
		});
		const { data } = parseHTMLForm(html);
		expect(data.personas[0]?.files).toEqual([
			{ file: null, share_conditions: "", perceived_contents: "" },
		]);
	});

	it("produces no files when can_share_files is no", () => {
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
