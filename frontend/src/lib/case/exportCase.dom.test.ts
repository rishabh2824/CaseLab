// Client project: buildHTMLForm/downloadForm produce and manipulate real DOM
// (DOMParser output, download anchors), so this needs jsdom.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePersona, makeReferral } from "../../testing/fixtures.js";
import { buildHTMLForm, downloadForm } from "./exportCase.js";

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

describe("downloadForm", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("names the file from a slugified case name", () => {
		const appendSpy = vi.spyOn(document.body, "appendChild");
		downloadForm("<html></html>", "My Great Case!");
		const link = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
		expect(link.tagName).toBe("A");
		expect(link.download).toBe("my-great-case.html");
	});

	it("falls back to new-case.html when the case name is blank", () => {
		const appendSpy = vi.spyOn(document.body, "appendChild");
		downloadForm("<html></html>", "   ");
		const link = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
		expect(link.download).toBe("new-case.html");
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
		downloadForm("<html></html>", "Case");
		const url = createSpy.mock.results[0]?.value;
		expect(revokeSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(revokeSpy).toHaveBeenCalledWith(url);
	});
});
