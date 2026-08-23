// Client project: buildHTMLForm/downloadForm produce and manipulate real DOM
// (DOMParser output, download anchors), so this needs jsdom.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHTMLForm, downloadForm } from "../../src/lib/case/exportCase.js";
import { makePersona, makeReferral } from "../support/fixtures.js";

// Parses buildHTMLForm's output the same way a browser (or parseHTMLForm)
// would, so assertions inspect real elements rather than the raw template
// string.
function parseForm(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

describe("buildHTMLForm", () => {
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
		// Case name, persona name, and known-facts are admin/AI-authored free
		// text that ends up inside a generated HTML document; a value like
		// `<script>` must render as inert text, not markup, or the exported
		// form becomes an XSS vector the moment it's reopened in a browser.
		const dangerous = `<script>alert("xss")</script> & Tom's "quote"`;

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
			// Only the form's own inline <script>...</script> (see buildHTMLForm's
			// trailing <script> block) may exist — none injected from data.
			expect(doc.querySelectorAll("script")).toHaveLength(1);
		});

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
	});
});

// The generated form's embedded <script> (add/remove persona, add/remove referral,
// dropdown sync) is real, executable JS that a browser runs when an admin opens the
// downloaded file -- DOMParser (used above) never executes it, so these drive it in an
// actual JSDOM window with script execution enabled, the same way opening the file would.
describe("buildHTMLForm's embedded script", () => {
	function loadInteractive(html: string): JSDOM {
		const dom = new JSDOM(html, { runScripts: "dangerously" });
		// jsdom implements no WebCrypto randomUUID (see tests/support/setup.client.ts's
		// same polyfill for the main app's own jsdom environment) -- this is a separate,
		// freshly constructed window, so it needs its own copy.
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

		// C is still reachable via D -> C, so removing A -> C alone must not remove it.
		click(rows()[0]?.querySelector('[data-action="remove-referral"]') ?? null);
		expect(doc.querySelector(`[data-persona-id="${c.id}"]`)).not.toBeNull();
		expect(rows()).toHaveLength(1);

		// Now C's only remaining path (D -> C) is gone too.
		click(rows()[0]?.querySelector('[data-action="remove-referral"]') ?? null);
		expect(doc.querySelector(`[data-persona-id="${c.id}"]`)).toBeNull();
		expect(doc.querySelector(`[data-persona-id="${a.id}"]`)).not.toBeNull();
		expect(doc.querySelector(`[data-persona-id="${d.id}"]`)).not.toBeNull();
	});

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

	it("always names the file export case.html", () => {
		const appendSpy = vi.spyOn(document.body, "appendChild");
		downloadForm("<html></html>");
		const link = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
		expect(link.tagName).toBe("A");
		expect(link.download).toBe("export case.html");
	});

	it("revokes the object URL after the scheduled delay", () => {
		// Wrap whatever createObjectURL/revokeObjectURL currently are (jsdom
		// has neither; some Node versions register real ones on the global
		// URL) rather than asserting against the setup file's stub directly —
		// what matters here is the *pairing*, not which implementation runs.
		const createSpy = vi.spyOn(URL, "createObjectURL");
		const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
		// Fake timers keep this deterministic instead of waiting a real second
		// for the trailing window.setTimeout cleanup to fire.
		vi.useFakeTimers();
		downloadForm("<html></html>");
		const url = createSpy.mock.results[0]?.value;
		expect(revokeSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(revokeSpy).toHaveBeenCalledWith(url);
	});
});
