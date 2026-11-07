import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { makeReferral } from "../../../support/factories.js";
import {
	clickArrow,
	diagramNode,
	diagramNodeCount,
	field,
	fillValidCase,
	makeCaseDoc,
	makePersonaPayload,
	openTab,
	renderForm,
	saveButton,
	setRoster,
	stubLoadCase,
	stubMutations,
	waitForLoadedCase,
} from "./support.js";

vi.mock(
	"#lib/adminViewer.js",
	async () => (await import("./viewerMock.js")).adminViewerModule,
);

const addStartingPersona = () =>
	page.getByRole("button", { name: "+ Add starting persona" });
const addReferral = () => page.getByRole("button", { name: "+ Add referral" });
const conditionField = (referrer: string) =>
	field(`When should ${referrer} refer the student to this persona?`);

beforeEach(() => {
	setRoster([]);
});

afterEach(() => {
	if (vi.isFakeTimers()) vi.useRealTimers();
});

describe("persona editor", () => {
	// Tests that a decimal in a number field is rejected with the whole-number error instead of being rounded down and saved.
	it("shows the whole-number error for a decimal availability instead of truncating it", async () => {
		await renderForm();
		await openTab("AI Personas");
		await addStartingPersona().click();

		const availability = field("Available for (minutes)");
		await availability.fill("1.5");
		// Field errors show once the admin tries to save.
		await saveButton().click();

		const message =
			"Persona 1: availability must be a whole number of minutes, at least 1.";
		await expect.element(availability).toHaveAccessibleDescription(message);
		await availability.clear();
		await expect.element(page.getByText(message)).not.toBeInTheDocument();
	});

	// Tests that editing the open persona reaches the form's own persona through a real binding, and that Svelte raises no ownership warning about it.
	it("edits the open persona through a genuine binding without ownership warnings", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await renderForm();
			await openTab("AI Personas");
			await addStartingPersona().click();
			await field("Persona name").fill("Mary");
			await field("Title/Role").fill("CFO");

			// The diagram draws personas from the form's graph, so a name it shows came through the binding.
			await expect.element(diagramNode("Mary")).toBeVisible();
			const ownershipWarnings = warn.mock.calls.filter(([message]) =>
				String(message).includes("ownership"),
			);
			expect(ownershipWarnings).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	// Tests that adding starting personas puts each in the diagram and opens the newest.
	it("lists each added starting persona and opens the newest", async () => {
		await renderForm();
		await openTab("AI Personas");

		await expect.element(field("Persona name")).not.toBeInTheDocument();
		await addStartingPersona().click();
		await field("Persona name").fill("Mary");
		await addStartingPersona().click();

		await expect.poll(diagramNodeCount).toBe(2);
		await expect.element(field("Persona name")).toHaveValue("");
		await diagramNode("Mary").click();
		await expect.element(field("Persona name")).toHaveValue("Mary");
	});

	// Tests that a referral's condition is edited on the referred persona and saved with the case.
	it("edits a referral's condition on the referred persona and saves it", async () => {
		const { createRequests } = stubMutations();
		await renderForm();
		await fillValidCase();

		await addReferral().click();
		await expect
			.element(page.getByText("Referred by Mary", { exact: true }))
			.toBeVisible();
		await field("Persona name").fill("Bob");
		await field("Title/Role").fill("Analyst");
		await field("Persona instructions").fill("Runs the numbers.");
		await conditionField("Mary").fill("asked about the budget");

		await saveButton().click();
		await vi.waitFor(() => expect(createRequests).toHaveLength(1));
		const structure = createRequests[0]?.structure as {
			referrals: { conditions: string }[];
		};
		expect(structure.referrals).toEqual([
			expect.objectContaining({ conditions: "asked about the budget" }),
		]);
	});

	// Tests that a case with a referral that has no condition can't be saved.
	it("refuses to save a referral with no condition", async () => {
		const { createRequests } = stubMutations();
		await renderForm();
		await fillValidCase();

		await addReferral().click();
		await field("Persona name").fill("Bob");
		await field("Title/Role").fill("Analyst");
		await field("Persona instructions").fill("Runs the numbers.");
		await saveButton().click();

		await expect
			.element(
				page.getByRole("list", { name: "Things to fix" }).getByRole("button", {
					name: "Add when Mary should refer the student to Bob. Until then, students can't reach Bob.",
					exact: true,
				}),
			)
			.toBeVisible();
		expect(createRequests).toHaveLength(0);
	});

	// Tests that clicking a problem opens the persona it belongs to and focuses the field.
	it("goes to a problem on a persona that isn't open", async () => {
		const doc = makeCaseDoc({
			structure: {
				personas: [
					makePersonaPayload(),
					makePersonaPayload({ id: "p2", name: "Bob", knownFacts: "" }),
				],
				referrals: [makeReferral("p1", "p2", "asked")],
			},
		});
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();
		await expect.element(saveButton()).toBeEnabled();

		await saveButton().click();
		await page
			.getByRole("button", { name: /Add instructions for Bob/ })
			.click();

		await expect.element(field("Persona name")).toHaveValue("Bob");
		await expect.element(field("Persona instructions")).toHaveFocus();
	});

	// Tests that a new file row opens with its upload field focused, and that leaving it empty blocks the save.
	it("opens a new file row and requires an upload", async () => {
		const { createRequests } = stubMutations();
		await renderForm();
		await fillValidCase();

		await page.getByRole("button", { name: "+ Add file" }).click();
		await expect.element(field("File")).toHaveFocus();

		await saveButton().click();

		await expect
			.element(
				page.getByRole("button", {
					name: "Mary, File 1: upload the file or remove this row.",
					exact: true,
				}),
			)
			.toBeVisible();
		expect(createRequests).toHaveLength(0);
	});

	// Tests that removing a persona with referrals asks first, then removes the whole branch.
	it("confirms before removing a persona along with the personas only it refers to", async () => {
		await renderForm();
		await fillValidCase();
		await addReferral().click();
		await diagramNode("Mary").click();

		await page.getByRole("button", { name: "Remove", exact: true }).click();
		await expect.element(page.getByText("Remove Mary?")).toBeVisible();
		expect(diagramNodeCount()).toBe(2);

		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Remove", exact: true })
			.click();

		await expect.element(field("Persona name")).not.toBeInTheDocument();
		await expect.poll(diagramNodeCount).toBe(0);
	});

	// Tests that clicking a referral opens the referred persona with that referral's condition focused.
	it("focuses a referral's condition when its arrow is clicked", async () => {
		const doc = makeCaseDoc({
			structure: {
				personas: [
					makePersonaPayload(),
					makePersonaPayload({ id: "p2", name: "Bob" }),
				],
				referrals: [makeReferral("p1", "p2", "asked")],
			},
		});
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();
		await expect
			.poll(() => document.querySelectorAll(".svelte-flow__edge").length)
			.toBe(1);

		clickArrow("p1", "p2");

		await expect.element(field("Persona name")).toHaveValue("Bob");
		await expect.element(conditionField("Mary")).toHaveFocus();
	});

	// Tests that one of two referrals into a persona can be removed, keeping the persona.
	it("removes one of two referrals into a persona, keeping the persona", async () => {
		const doc = makeCaseDoc({
			structure: {
				personas: [
					makePersonaPayload(),
					makePersonaPayload({ id: "p2", name: "Raj" }),
					makePersonaPayload({ id: "p3", name: "Bob" }),
				],
				referrals: [makeReferral("p1", "p3"), makeReferral("p2", "p3")],
			},
		});
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();
		await diagramNode("Bob").click();

		await page
			.getByRole("button", { name: "Remove referral from Raj" })
			.click();

		await expect
			.element(page.getByText("Referred by Mary", { exact: true }))
			.toBeVisible();
		await expect
			.element(page.getByRole("button", { name: /Remove referral/ }))
			.not.toBeInTheDocument();
		await expect.poll(diagramNodeCount).toBe(3);
	});

	// Tests that a view-only collaborator can still move between personas, with their fields locked.
	it("lets a view-only collaborator browse personas", async () => {
		const doc = makeCaseDoc({
			canEdit: false,
			structure: {
				personas: [
					makePersonaPayload(),
					makePersonaPayload({ id: "p2", name: "Bob" }),
				],
				referrals: [makeReferral("p1", "p2")],
			},
		});
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();

		await diagramNode("Bob").click();

		await expect.element(field("Persona name")).toHaveValue("Bob");
		await expect.element(field("Persona name")).toBeDisabled();
	});
});
