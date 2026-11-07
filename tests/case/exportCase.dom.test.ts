import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHTMLForm, downloadForm } from "../../src/lib/case/exportCase.js";
import { makePersona, makeReferral } from "../support/factories.js";

// Parses exported form HTML into a Document.
function parseForm(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

describe("buildHTMLForm", () => {
	// Tests that an export with no personas scaffolds a root, a referred persona and one referral.
	it("scaffolds a root and a referred persona joined by one referral when no personas are given", () => {
		const doc = parseForm(
			buildHTMLForm({
				name: "",
				accessCode: "",
				duration: null,
				brief: "",
				commonInformation: "",
			}),
		);
		const cards = doc.querySelectorAll(".persona-card");
		expect(cards).toHaveLength(2);
		expect(doc.querySelectorAll(".referral-row")).toHaveLength(1);
	});

	// Tests that every persona card gets a remove button and none carries a root marker, since roots are worked out from the referrals.
	it("gives every persona a remove button and no root dropdown", () => {
		const root = makePersona();
		const referred = makePersona();
		const doc = parseForm(
			buildHTMLForm({
				name: "Case",
				accessCode: "ABC",
				duration: null,
				brief: "Brief",
				commonInformation: "",
				personas: [root, referred],
				referrals: [makeReferral(root.id, referred.id)],
			}),
		);

		for (const card of doc.querySelectorAll(".persona-card")) {
			expect(
				card.querySelector('[data-action="remove-persona"]'),
			).not.toBeNull();
			expect(card.hasAttribute("data-persona-root")).toBe(false);
		}
		expect(doc.querySelector('[data-role="persona-type"]')).toBeNull();
	});

	describe("HTML escaping", () => {
		const dangerous = `<script>alert("xss")</script> & Tom's "quote"`;

		// Tests that a dangerous value round-trips as text without injecting a script.
		it.each([
			{ label: "case name", field: "case_name", persona: null },
			{ label: "persona name", field: "name", persona: { name: dangerous } },
			{
				label: "known-facts value",
				field: "known_facts",
				persona: { knownFacts: dangerous },
			},
		])(
			"round-trips a dangerous $label as text, injecting no extra <script>",
			({ field, persona: personaOverrides }) => {
				const persona = makePersona(personaOverrides ?? {});
				const doc = parseForm(
					buildHTMLForm({
						name: personaOverrides ? "Case" : dangerous,
						accessCode: "ABC",
						duration: null,
						brief: "Brief",
						commonInformation: "",
						personas: [persona],
						referrals: [],
					}),
				);
				const selector = personaOverrides
					? `[data-persona-id="${persona.id}"] [data-field="${field}"]`
					: `[data-field="${field}"]`;
				const element = doc.querySelector(selector) as HTMLTextAreaElement;
				expect(element.value.trim()).toBe(dangerous);
				expect(doc.querySelectorAll("script")).toHaveLength(1);
			},
		);

		// Tests that a quote in a persona id cannot break out of the data-persona-id attribute.
		it("escapes a quote in a persona id so it can't break out of the data-persona-id attribute", () => {
			const dangerousId = `p1" onmouseover="alert(1)`;
			const persona = makePersona({ id: dangerousId });
			const doc = parseForm(
				buildHTMLForm({
					name: "Case",
					accessCode: "ABC",
					duration: null,
					brief: "Brief",
					commonInformation: "",
					personas: [persona],
					referrals: [],
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
	const frames: HTMLIFrameElement[] = [];

	afterEach(() => {
		for (const frame of frames.splice(0)) frame.remove();
	});

	// Opens the exported form the way a user would, as a page of its own whose scripts run, and waits for it to load. The sandbox keeps it from touching anything outside its frame.
	async function loadInteractive(
		html: string,
	): Promise<{ doc: Document; win: Window & { __pwned?: number } }> {
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
		frames.push(frame);
		const loaded = new Promise<void>((resolve) =>
			frame.addEventListener("load", () => resolve(), { once: true }),
		);
		frame.srcdoc = html;
		document.body.append(frame);
		await loaded;
		return {
			doc: frame.contentDocument as Document,
			win: frame.contentWindow as Window & { __pwned?: number },
		};
	}

	// Clicks like a user would, running the page's own handlers.
	function click(el: Element | null): void {
		(el as HTMLElement | null)?.click();
	}

	// Tests that a persona added in the exported form's script gets a UUID id.
	it("mints a UUID for a newly-added persona, not a sequential id", async () => {
		const { doc } = await loadInteractive(
			buildHTMLForm({
				name: "Case",
				accessCode: "ABC",
				duration: null,
				brief: "Brief",
				commonInformation: "",
			}),
		);
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
		expect(newId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

		click(doc.getElementById("add-persona-btn"));
		const ids = Array.from(doc.querySelectorAll("[data-persona-id]")).map(
			(el) => el.getAttribute("data-persona-id"),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// Tests that removing a persona in the exported form also removes its exclusive descendants.
	it("cascade-removes a persona's exclusive descendants, matching graph.svelte.ts's removeSubtree", async () => {
		const a = makePersona();
		const b = makePersona();
		const c = makePersona();
		const { doc } = await loadInteractive(
			buildHTMLForm({
				name: "Case",
				accessCode: "ABC",
				duration: null,
				brief: "Brief",
				commonInformation: "",
				personas: [a, b, c],
				referrals: [makeReferral(a.id, b.id), makeReferral(b.id, c.id)],
			}),
		);

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
	it("removing a referral cascade-removes the target only once it has no other path from a root", async () => {
		const a = makePersona();
		const d = makePersona();
		const c = makePersona();
		const { doc } = await loadInteractive(
			buildHTMLForm({
				name: "Case",
				accessCode: "ABC",
				duration: null,
				brief: "Brief",
				commonInformation: "",
				personas: [a, d, c],
				referrals: [makeReferral(a.id, c.id), makeReferral(d.id, c.id)],
			}),
		);
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
	it("keeps a dangerous fixed-root persona id inert as string data, not markup, in the inline script", async () => {
		const dangerousId = "</script><script>window.__pwned=1</script>";
		const persona = makePersona({ id: dangerousId });
		const { doc, win } = await loadInteractive(
			buildHTMLForm({
				name: "Case",
				accessCode: "ABC",
				duration: null,
				brief: "Brief",
				commonInformation: "",
				personas: [persona],
				referrals: [],
			}),
		);
		expect(win.__pwned).toBeUndefined();
		// Positive control: the page's own script did run, so the check above means something.
		click(doc.getElementById("add-persona-btn"));
		expect(doc.querySelectorAll(".persona-card")).toHaveLength(2);
	});

	// Tests that the referral dropdowns list the new persona after one is added.
	it("refreshes referral dropdown options after a persona is added", async () => {
		const { doc } = await loadInteractive(
			buildHTMLForm({
				name: "Case",
				accessCode: "ABC",
				duration: null,
				brief: "Brief",
				commonInformation: "",
			}),
		);

		click(doc.getElementById("add-persona-btn"));

		const fromSelect = doc.querySelector(
			'.referral-row select[data-role="from"]',
		) as HTMLSelectElement;
		const optionValues = Array.from(fromSelect.options).map((o) => o.value);
		const personaIds = Array.from(
			doc.querySelectorAll("[data-persona-id]"),
		).map((el) => el.getAttribute("data-persona-id"));
		// The scaffold has two personas, so a third proves the click ran the page's script.
		expect(personaIds).toHaveLength(3);
		expect(optionValues.sort()).toEqual([...personaIds].sort());
	});
});

describe("downloadForm", () => {
	beforeEach(() => {
		// A real click on the link would start a download in the test browser.
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
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
