import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { Id } from "#convex/dataModel.js";
import { beforeNavigate, goto } from "$app/navigation";
import {
	createCase,
	field,
	fillValidCase,
	getTemplate,
	makeCaseDoc,
	navigationGuard,
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

beforeEach(() => {
	setRoster([]);
});

afterEach(() => {
	if (vi.isFakeTimers()) vi.useRealTimers();
});

describe("tabs", () => {
	// Tests that a new case starts on its details and an existing one on its personas.
	it("opens a new case on its details and an existing case on its personas", async () => {
		const fresh = await renderForm();
		await expect
			.element(page.getByRole("tab", { name: "Case Information" }))
			.toHaveAttribute("aria-selected", "true");
		await expect.element(field("Case name")).toBeVisible();
		fresh.unmount();

		const doc = makeCaseDoc();
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();
		await expect
			.element(page.getByRole("tab", { name: "AI Personas" }))
			.toHaveAttribute("aria-selected", "true");
		await expect.element(field("Case name")).not.toBeInTheDocument();
	});

	// Tests that what was typed on one tab is still there after visiting the other, and is what gets saved.
	it("keeps typed values when switching tabs", async () => {
		const { createRequests } = stubMutations();
		await renderForm();
		await fillValidCase();

		await openTab("Case Information");
		await expect.element(field("Case name")).toHaveValue("Sterling Industries");
		await openTab("AI Personas");
		await expect.element(field("Persona name")).toHaveValue("Mary");

		await saveButton().click();
		await vi.waitFor(() => expect(createRequests).toHaveLength(1));
	});

	// Tests that a problem on the closed tab is flagged on that tab, and that its link goes there.
	it("flags a closed tab's problems and switches to them", async () => {
		await renderForm();
		await fillValidCase();
		const infoTab = page.getByRole("tab", { name: "Case Information" });
		const personasTab = page.getByRole("tab", { name: "AI Personas" });
		await openTab("Case Information");
		await field("Case name").clear();
		await openTab("AI Personas");
		expect(infoTab.element().querySelector(".bg-brand")).toBeNull();

		await saveButton().click();

		await vi.waitFor(() =>
			expect(infoTab.element().querySelector(".bg-brand")).not.toBeNull(),
		);
		expect(personasTab.element().querySelector(".bg-brand")).toBeNull();
		await page
			.getByRole("button", { name: "Case name is required.", exact: true })
			.click();
		await expect.element(field("Case name")).toHaveFocus();
		await expect.element(infoTab).toHaveAttribute("aria-selected", "true");
	});

	// Tests that a view-only reader can still move between tabs.
	it("lets a view-only collaborator switch tabs", async () => {
		const doc = makeCaseDoc({ canEdit: false });
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();

		await openTab("Case Information");

		await expect.element(field("Case name")).toBeDisabled();
	});
});

describe("view-only case", () => {
	// Tests that a case shared for reading shows a banner, locks the fields and offers no save button.
	it("locks the form and hides the save button for a view-only collaborator", async () => {
		const doc = makeCaseDoc({ canEdit: false });
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });

		await expect.element(field("Persona name")).toHaveValue("Mary");
		await expect.element(field("Persona name")).toBeDisabled();
		await expect.element(page.getByText(/View only:/)).toBeVisible();
		await expect.element(saveButton()).not.toBeInTheDocument();
	});

	// Tests that an editable case shows none of that.
	it("shows no banner and keeps the save button for an editor", async () => {
		const doc = makeCaseDoc();
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });

		await expect.element(field("Persona name")).toHaveValue("Mary");
		await expect.element(field("Persona name")).toBeEnabled();
		await expect.element(page.getByText(/View only:/)).not.toBeInTheDocument();
		await expect.element(saveButton()).toBeVisible();
	});
});

describe("template mode", () => {
	// Tests that a template loads through getTemplate and seeds a new case with no access code.
	it("seeds the form from the template without an access code", async () => {
		const {
			accessCode: _accessCode,
			ownerAdminId: _owner,
			...template
		} = makeCaseDoc();
		getTemplate.mockResolvedValue(template);
		const { createRequests } = stubMutations();
		await renderForm({ templateId: template._id });

		await expect.element(field("Case name")).toHaveValue("Sterling Industries");
		await expect.element(field("Access code")).toHaveValue("");
		await expect
			.element(field("Access code"))
			.not.toHaveAttribute("aria-invalid");
		expect(getTemplate).toHaveBeenCalledWith({ caseId: template._id });

		await field("Access code").fill("fresh");
		await saveButton().click();
		await vi.waitFor(() => expect(createRequests).toHaveLength(1));
		expect(createRequests[0]?.accessCode).toBe("fresh");
	});
});

describe("concurrent saves", () => {
	// Tests that a second submit during an in-flight save reuses it instead of calling the mutation again.
	it("reuses the in-flight save instead of issuing a second mutation call", async () => {
		let resolveMutation: ((value: { caseId: Id<"cases"> }) => void) | undefined;
		createCase.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		await renderForm();

		await fillValidCase();

		await saveButton().click();
		navigationGuard(vi.mocked(beforeNavigate))();
		await page.getByRole("button", { name: "Save changes" }).click();

		resolveMutation?.({ caseId: "convex-case-1" as Id<"cases"> });
		await vi.waitFor(() =>
			expect(goto).toHaveBeenCalledWith(new URL("http://localhost/admin")),
		);

		expect(createCase).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => {
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
				"Case saved successfully.",
			);
		});
	});

	// Tests that every field, not just the save button, is disabled while a save is in flight.
	it("disables every field, not just the save button, while a save is in flight", async () => {
		let resolveMutation: ((value: { caseId: Id<"cases"> }) => void) | undefined;
		createCase.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		await renderForm();

		await fillValidCase();

		await saveButton().click();

		await expect.element(field("Persona name")).toBeDisabled();
		await expect
			.element(page.getByRole("button", { name: "Export template" }))
			.toBeDisabled();

		resolveMutation?.({ caseId: "convex-case-1" as Id<"cases"> });
		await vi.waitFor(() => {
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
				"Case saved successfully.",
			);
		});

		await expect.element(field("Persona name")).toBeEnabled();
	});
});

describe("unsaved-changes navigation guard", () => {
	const target = new URL("http://localhost/admin");
	const dialogTitle = () => page.getByText("You have unsaved changes");

	// Tests that a clean form lets navigation through and a dirty one holds it behind the dialog.
	it("lets a clean navigation through and holds a dirty one behind the dialog", async () => {
		await renderForm();
		const navigate = navigationGuard(vi.mocked(beforeNavigate));

		expect(navigate()).toBe(false);

		await field("Case name").fill("Sterling Industries");
		expect(navigate()).toBe(true);
		await expect.element(dialogTitle()).toBeVisible();
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that cancelling the dialog stays on the page and keeps the guard active.
	it("stays put when the dialog is cancelled", async () => {
		await renderForm();
		const navigate = navigationGuard(vi.mocked(beforeNavigate));
		await field("Case name").fill("Sterling");
		navigate();

		await page.getByRole("button", { name: "Cancel" }).click();

		await expect.element(dialogTitle()).not.toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
		expect(navigate()).toBe(true);
	});

	// Tests that discarding continues the held navigation and stops re-blocking.
	it("continues the navigation after Discard changes, without re-blocking it", async () => {
		await renderForm();
		const navigate = navigationGuard(vi.mocked(beforeNavigate));
		await field("Case name").fill("Sterling");
		navigate();

		await page.getByRole("button", { name: "Discard changes" }).click();

		expect(goto).toHaveBeenCalledWith(target);
		expect(navigate()).toBe(false);
	});

	// Tests that a failed save keeps the user on the page with the error shown.
	it("shows the error and stays when the save fails", async () => {
		await renderForm();
		const navigate = navigationGuard(vi.mocked(beforeNavigate));
		await field("Case name").fill("Sterling");
		navigate();

		await page.getByRole("button", { name: "Save changes" }).click();

		const dialog = page.getByRole("alertdialog");
		await expect.element(dialog.getByRole("alert")).toBeVisible();
		expect(goto).not.toHaveBeenCalled();
	});
});
