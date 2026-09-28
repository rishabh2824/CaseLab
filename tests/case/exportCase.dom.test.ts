import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHTMLForm, downloadForm } from "../../src/lib/case/exportCase.js";
import { makePersona, makeReferral } from "../support/fixtures.js";

// Parses exported form HTML into a Document.
function parseForm(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

describe("buildHTMLForm", () => {
	// Tests that an export with no personas scaffolds a root, a referred persona and one referral.
	it("scaffolds a root and a referred persona joined by one referral when no personas are given", () => {
		const doc = parseForm(
			buildHTMLForm({
				caseName: "",
				accessCode: "",
				simulationDurationMinutes: null,
				initialBrief: "",
				commonInformation: "",
			}),
		);
		const cards = doc.querySelectorAll(".persona-card");
		expect(cards).toHaveLength(2);
		expect(cards[0]?.getAttribute("data-persona-root")).toBe("true");
		expect(cards[1]?.getAttribute("data-persona-root")).toBe("false");
		expect(doc.querySelectorAll(".referral-row")).toHaveLength(1);
	});

	// Tests that the first root is marked fixed with no remove button while other personas get one.
	it("marks the first root data-fixed-root and hides its remove button; other personas get one", () => {
		const root = makePersona();
		const referred = makePersona();
		const doc = parseForm(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
				personas: [root, referred],
				referrals: [makeReferral(root.id, referred.id)],
				roots: [root.id],
			}),
		);
		const rootCard = doc.querySelector(
			`[data-persona-id="${root.id}"]`,
		) as Element;
		const referredCard = doc.querySelector(
			`[data-persona-id="${referred.id}"]`,
		) as Element;

		expect(rootCard.getAttribute("data-fixed-root")).toBe("true");
		expect(rootCard.querySelector('[data-action="remove-persona"]')).toBeNull();

		expect(referredCard.getAttribute("data-fixed-root")).toBe("false");
		expect(
			referredCard.querySelector('[data-action="remove-persona"]'),
		).not.toBeNull();
	});

	// Tests that each persona's data-persona-root reflects the roots list.
	it("sets data-persona-root per persona according to the roots list", () => {
		const a = makePersona();
		const b = makePersona();
		const c = makePersona();
		const doc = parseForm(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
				personas: [a, b, c],
				referrals: [makeReferral(a.id, b.id), makeReferral(a.id, c.id)],
				roots: [a.id, c.id],
			}),
		);
		const rootOf = (id: string) =>
			doc
				.querySelector(`[data-persona-id="${id}"]`)
				?.getAttribute("data-persona-root");
		expect(rootOf(a.id)).toBe("true");
		expect(rootOf(b.id)).toBe("false");
		expect(rootOf(c.id)).toBe("true");
	});

	describe("HTML escaping", () => {
		const dangerous = `<script>alert("xss")</script> & Tom's "quote"`;

		// Tests that a dangerous case name round-trips as text without injecting a script.
		it("round-trips a dangerous case name as text, injecting no extra <script>", () => {
			const doc = parseForm(
				buildHTMLForm({
					caseName: dangerous,
					accessCode: "ABC",
					simulationDurationMinutes: null,
					initialBrief: "Brief",
					commonInformation: "",
				}),
			);
			const field = doc.querySelector(
				'[data-field="case_name"]',
			) as HTMLTextAreaElement;
			expect(field.value.trim()).toBe(dangerous);
			expect(doc.querySelectorAll("script")).toHaveLength(1);
		});

		// Tests that a dangerous persona name round-trips as text without injecting a script.
		it("round-trips a dangerous persona name as text, injecting no extra <script>", () => {
			const persona = makePersona({ name: dangerous });
			const doc = parseForm(
				buildHTMLForm({
					caseName: "Case",
					accessCode: "ABC",
					simulationDurationMinutes: null,
					initialBrief: "Brief",
					commonInformation: "",
					personas: [persona],
					referrals: [],
					roots: [persona.id],
				}),
			);
			const field = doc.querySelector(
				`[data-persona-id="${persona.id}"] [data-field="name"]`,
			) as HTMLTextAreaElement;
			expect(field.value.trim()).toBe(dangerous);
			expect(doc.querySelectorAll("script")).toHaveLength(1);
		});

		// Tests that a dangerous known-facts value round-trips as text without injecting a script.
		it("round-trips a dangerous known-facts value as text, injecting no extra <script>", () => {
			const persona = makePersona({ known_facts: dangerous });
			const doc = parseForm(
				buildHTMLForm({
					caseName: "Case",
					accessCode: "ABC",
					simulationDurationMinutes: null,
					initialBrief: "Brief",
					commonInformation: "",
					personas: [persona],
					referrals: [],
					roots: [persona.id],
				}),
			);
			const field = doc.querySelector(
				`[data-persona-id="${persona.id}"] [data-field="known_facts"]`,
			) as HTMLTextAreaElement;
			expect(field.value.trim()).toBe(dangerous);
			expect(doc.querySelectorAll("script")).toHaveLength(1);
		});

		// Tests that a quote in a persona id cannot break out of the data-persona-id attribute.
		it("escapes a quote in a persona id so it can't break out of the data-persona-id attribute", () => {
			const dangerousId = `p1" onmouseover="alert(1)`;
			const persona = makePersona({ id: dangerousId });
			const doc = parseForm(
				buildHTMLForm({
					caseName: "Case",
					accessCode: "ABC",
					simulationDurationMinutes: null,
					initialBrief: "Brief",
					commonInformation: "",
					personas: [persona],
					referrals: [],
					roots: [persona.id],
				}),
			);
			const card = doc.querySelector(".persona-card") as Element;
			expect(card.getAttribute("data-persona-id")).toBe(dangerousId);
			expect(card.hasAttribute("onmouseover")).toBe(false);
			expect(doc.querySelectorAll("script")).toHaveLength(1);
		});
	});
});

describe("buildHTMLForm's embedded script", () => {
	function loadInteractive(html: string): JSDOM {
		const dom = new JSDOM(html, { runScripts: "dangerously" });
		let counter = 0;
		Object.defineProperty(dom.window.crypto, "randomUUID", {
			configurable: true,
			value: () =>
				`00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
		});
		return dom;
	}

	function click(el: Element | null): void {
		el?.dispatchEvent(
			new (el.ownerDocument.defaultView as typeof window).MouseEvent("click", {
				bubbles: true,
			}),
		);
	}

	// Tests that a persona added in the exported form's script gets a UUID id.
	it("mints a UUID for a newly-added persona, not a sequential id", () => {
		const dom = loadInteractive(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
			}),
		);
		const doc = dom.window.document;
		const before = new Set(
			Array.from(doc.querySelectorAll("[data-persona-id]")).map((el) =>
				el.getAttribute("data-persona-id"),
			),
		);

		click(doc.getElementById("add-persona-btn"));

		const after = Array.from(doc.querySelectorAll("[data-persona-id]")).map(
			(el) => el.getAttribute("data-persona-id"),
		);
		expect(after).toHaveLength(before.size + 1);
		const newId = after.find((id) => id && !before.has(id));
		expect(newId).toMatch(/^[0-9a-f-]{36}$/i);
	});

	// Tests that removing a persona in the exported form also removes its exclusive descendants.
	it("cascade-removes a persona's exclusive descendants, matching graph.svelte.ts's removeSubtree", () => {
		const a = makePersona();
		const b = makePersona();
		const c = makePersona();
		const dom = loadInteractive(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
				personas: [a, b, c],
				referrals: [makeReferral(a.id, b.id), makeReferral(b.id, c.id)],
				roots: [a.id],
			}),
		);
		const doc = dom.window.document;

		click(
			doc.querySelector(
				`[data-persona-id="${b.id}"] [data-action="remove-persona"]`,
			),
		);

		expect(doc.querySelector(`[data-persona-id="${a.id}"]`)).not.toBeNull();
		expect(doc.querySelector(`[data-persona-id="${b.id}"]`)).toBeNull();
		expect(doc.querySelector(`[data-persona-id="${c.id}"]`)).toBeNull();
		expect(doc.querySelectorAll(".referral-row")).toHaveLength(0);
	});

	// Tests that removing a referral removes the target persona only once no other path reaches it.
	it("removing a referral cascade-removes the target only once it has no other path from a root", () => {
		const a = makePersona();
		const d = makePersona();
		const c = makePersona();
		const dom = loadInteractive(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
				personas: [a, d, c],
				referrals: [makeReferral(a.id, c.id), makeReferral(d.id, c.id)],
				roots: [a.id, d.id],
			}),
		);
		const doc = dom.window.document;
		const rows = () => doc.querySelectorAll(".referral-row");

		click(rows()[0]?.querySelector('[data-action="remove-referral"]') ?? null);
		expect(doc.querySelector(`[data-persona-id="${c.id}"]`)).not.toBeNull();
		expect(rows()).toHaveLength(1);

		click(rows()[0]?.querySelector('[data-action="remove-referral"]') ?? null);
		expect(doc.querySelector(`[data-persona-id="${c.id}"]`)).toBeNull();
		expect(doc.querySelector(`[data-persona-id="${a.id}"]`)).not.toBeNull();
		expect(doc.querySelector(`[data-persona-id="${d.id}"]`)).not.toBeNull();
	});

	// Tests that a malicious fixed-root persona id stays inert data inside the inline script.
	it("keeps a dangerous fixed-root persona id inert as string data, not markup, in the inline script", () => {
		const dangerousId = "</script><script>window.__pwned=1</script>";
		const persona = makePersona({ id: dangerousId });
		const dom = loadInteractive(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
				personas: [persona],
				referrals: [],
				roots: [persona.id],
			}),
		);
		expect(
			(dom.window as unknown as { __pwned?: number }).__pwned,
		).toBeUndefined();
	});

	// Tests that the referral dropdowns list the new persona after one is added.
	it("refreshes referral dropdown options after a persona is added", () => {
		const dom = loadInteractive(
			buildHTMLForm({
				caseName: "Case",
				accessCode: "ABC",
				simulationDurationMinutes: null,
				initialBrief: "Brief",
				commonInformation: "",
			}),
		);
		const doc = dom.window.document;

		click(doc.getElementById("add-persona-btn"));

		const fromSelect = doc.querySelector(
			'.referral-row select[data-role="from"]',
		) as HTMLSelectElement;
		const optionValues = Array.from(fromSelect.options).map((o) => o.value);
		const personaIds = Array.from(
			doc.querySelectorAll("[data-persona-id]"),
		).map((el) => el.getAttribute("data-persona-id"));
		expect(optionValues.sort()).toEqual([...personaIds].sort());
	});
});

describe("downloadForm", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// Tests that downloadForm always names the file 'export case.html'.
	it("always names the file export case.html", () => {
		const appendSpy = vi.spyOn(document.body, "appendChild");
		downloadForm("<html></html>");
		const link = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
		expect(link.tagName).toBe("A");
		expect(link.download).toBe("export case.html");
	});

	// Tests that downloadForm revokes its object URL after the scheduled delay.
	it("revokes the object URL after the scheduled delay", () => {
		const createSpy = vi.spyOn(URL, "createObjectURL");
		const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
		vi.useFakeTimers();
		downloadForm("<html></html>");
		const url = createSpy.mock.results[0]?.value;
		expect(revokeSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(revokeSpy).toHaveBeenCalledWith(url);
	});
});
