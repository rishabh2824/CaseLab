import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { buildHTMLForm } from "../../../../src/lib/case/exportCase.js";
import { makePersona, makeReferral } from "../../../support/factories.js";
import {
	field,
	fillValidCase,
	makeAdminRow,
	makeCaseDoc,
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

// The form's import file chooser, the first file input on the page.
const importInput = () =>
	page.elementLocator(document.querySelector('input[type="file"]')!);

const importButton = () =>
	page.getByRole("button", { name: "Import template" });
const replaceTitle = () => page.getByText("Replace everything in this form?");

// An export with a case name and no personas, as a file to import.
function exportFile(name = "Imported Case") {
	const html = buildHTMLForm({
		name,
		accessCode: "CODE1",
		duration: 30,
		brief: "Imported brief",
		commonInformation: "Imported background",
		personas: [],
		referrals: [],
	});
	return new File([html], "export.html", { type: "text/html" });
}

describe("import", () => {
	// Tests that import is offered in create mode.
	it("is offered in create mode (no source case)", async () => {
		await renderForm();
		await expect.element(importButton()).toBeVisible();
	});

	// Tests that import is not offered in edit mode.
	it("is not offered in edit mode", async () => {
		const doc = makeCaseDoc();
		stubLoadCase(doc);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();
		await expect.element(importButton()).not.toBeInTheDocument();
	});

	// Tests that importing a hand-edited export is rejected without touching the form.
	it("rejects a hand-edited export file and leaves the form untouched", async () => {
		const root = makePersona({
			id: "root1",
			name: "Original Root",
			role: "Lead",
			availabilityMinutes: 45,
		});
		const referred = makePersona({
			id: "ref1",
			name: "Original Referred",
			role: "Assistant",
		});
		const html = buildHTMLForm({
			name: "Original Case",
			accessCode: "CODE1",
			duration: 30,
			brief: "Original brief",
			commonInformation: "Original background",
			personas: [root, referred],
			referrals: [makeReferral("root1", "ref1", "always")],
		});
		const tweaked = html
			.replaceAll("Original Case", "Tweaked Case")
			.replace(">45</textarea>", ">not-a-number</textarea>");
		const file = new File([tweaked], "export.html", { type: "text/html" });
		await renderForm();

		await importInput().upload(file);

		await expect.element(page.getByText(/Time limit/)).toBeVisible();
		await expect.element(field("Case name")).toHaveValue("");
	});

	// Tests that importing over existing content asks for confirmation and only imports once confirmed.
	it("confirms before replacing existing form content, and only imports after confirming", async () => {
		await renderForm();

		await field("Case name").fill("Existing Case");
		await importInput().upload(exportFile());

		await expect.element(replaceTitle()).toBeVisible();
		await expect.element(field("Case name")).toHaveValue("Existing Case");

		await page.getByRole("button", { name: "Import", exact: true }).click();

		await expect.element(field("Case name")).toHaveValue("Imported Case");
		await expect.element(replaceTitle()).not.toBeInTheDocument();
	});

	// Tests that cancelling the replace confirmation leaves the existing form content untouched.
	it("cancelling the replace-confirm leaves the existing form content untouched", async () => {
		await renderForm();

		await field("Case name").fill("Existing Case");
		await importInput().upload(exportFile());
		await expect.element(replaceTitle()).toBeVisible();

		await page.getByRole("button", { name: "Cancel" }).click();

		await expect.element(replaceTitle()).not.toBeInTheDocument();
		await expect.element(field("Case name")).toHaveValue("Existing Case");
	});

	// Tests that importing an unrelated HTML file shows the import error as a toast.
	it("surfaces the import error as a toast for an unrelated HTML file", async () => {
		const file = new File(
			["<html><body><p>hello</p></body></html>"],
			"random.html",
			{ type: "text/html" },
		);
		await renderForm();

		await importInput().upload(file);

		await vi.waitFor(() =>
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
				"This doesn't look like a Case Lab import file.",
			),
		);
	});
});

describe("collaborator picker", () => {
	async function openPicker() {
		await openTab("Case Information");
		await page.getByRole("button", { name: /Add collaborators/ }).click();
	}

	// Tests that the collaborator picker lists the admin roster from the live subscription.
	it("shows the admin roster from the live Convex subscription in the picker", async () => {
		setRoster([makeAdminRow({ _id: "9", name: "Nina" })]);
		await renderForm();

		await openPicker();

		await expect.element(page.getByText("Nina")).toBeVisible();
	});

	// Tests that the case owner is excluded from the picker in edit mode, while super admins stay selectable so they can be credited.
	it("excludes the case's owner but offers super admins in edit mode", async () => {
		const doc = makeCaseDoc({ ownerAdminId: "5" });
		stubLoadCase(doc);
		setRoster([
			makeAdminRow({ _id: "5", name: "Owner Olivia", role: "admin" }),
			makeAdminRow({ _id: "6", name: "Super Sam", role: "super" }),
			makeAdminRow({ _id: "7", name: "Rank Rita", role: "admin" }),
		]);
		await renderForm({ editCaseId: doc._id });
		await waitForLoadedCase();

		await openPicker();

		await expect.element(page.getByText("Rank Rita")).toBeVisible();
		await expect
			.element(page.getByText("Owner Olivia"))
			.not.toBeInTheDocument();
		await expect.element(page.getByText("Super Sam")).toBeVisible();
	});

	// Tests that the signed-in admin is excluded from the picker as the effective owner in create mode.
	it("excludes the signed-in admin (admins:viewer) as the effective owner in create mode", async () => {
		setRoster([
			makeAdminRow({ _id: "1", name: "Me", email: "me@wisc.edu" }),
			makeAdminRow({
				_id: "2",
				name: "Rank Rita",
				email: "rita@wisc.edu",
			}),
		]);
		await renderForm({
			viewer: makeAdminRow({ _id: "1", name: "Me", email: "me@wisc.edu" }),
		});

		await openPicker();

		await expect.element(page.getByText("Rank Rita")).toBeVisible();
		await expect
			.element(page.getByText("Me", { exact: true }))
			.not.toBeInTheDocument();
	});

	// Tests that toggling a collaborator updates the selected-count badge and the submit payload.
	it("toggling a collaborator updates the selected-count badge and is included in the submit payload", async () => {
		const { createRequests } = stubMutations();
		setRoster([makeAdminRow({ _id: "9", name: "Nina" })]);
		await renderForm();

		await fillValidCase();

		await openPicker();
		const checkbox = field("Nina");
		await checkbox.click();

		await expect.element(page.getByText("1 selected")).toBeVisible();
		await expect.element(checkbox).toBeChecked();
		await field("Access for Nina").selectOptions("view");

		await saveButton().click();
		await vi.waitFor(() => {
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
				"Case saved successfully.",
			);
		});

		expect(createRequests[0]?.collaborators).toEqual([
			{ adminId: "9", access: "view" },
		]);

		// Clicking Save closed the picker, so open it again to take the collaborator back off.
		await openPicker();
		await expect.element(checkbox).toBeChecked();
		await checkbox.click();
		await expect.element(checkbox).not.toBeChecked();
		await expect.element(page.getByText("1 selected")).not.toBeInTheDocument();
	});
});
