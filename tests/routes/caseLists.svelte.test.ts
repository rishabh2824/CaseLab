import type { FunctionReturnType } from "convex/server";
import * as sonner from "svelte-sonner";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { appError, ERROR_CODE } from "#shared/errors.js";
import { goto } from "$app/navigation";
import EditCases from "../../src/routes/(app)/admin/cases/+page.svelte";
import ChooseTemplate from "../../src/routes/(app)/admin/cases/new/template/+page.svelte";
import { convexFake } from "../support/convexFake.svelte.js";

let viewerRole: "admin" | "super" = "admin";

vi.mock("#lib/adminViewer.js", () => ({
	getViewerContext: () => ({ data: { role: viewerRole } }),
}));

const deleteCase = convexFake.mutation(api.cases.deleteCase);
const setTemplate = convexFake.mutation(api.cases.setTemplate);

type CaseSummary = FunctionReturnType<typeof api.cases.listAll>[number];

const DIALOG_TITLE = 'Delete "Sterling Industries"?';

const deleteCaseButton = () =>
	page.getByRole("button", { name: "Delete case" });
// The dialog's confirm button; the row's own button is named "Delete case".
const confirmDelete = () =>
	page.getByRole("button", { name: "Delete", exact: true });
const templateSwitch = () => page.getByRole("switch");

// Renders the edit or the choose-a-template page, signed in with the given admin role.
function renderPicker(
	mode: "template" | "edit",
	role: "admin" | "super" = "admin",
) {
	viewerRole = role;
	return mode === "edit" ? render(EditCases) : render(ChooseTemplate);
}

// Builds a case summary with defaults and optional overrides.
function makeCaseSummary(
	overrides: Partial<Omit<CaseSummary, "_id">> & { _id?: string } = {},
): CaseSummary {
	return {
		name: "Sterling Industries",
		accessCode: "sterling",
		isTemplate: false,
		canEdit: true,
		...overrides,
		_id: (overrides._id ?? "case-1") as Id<"cases">,
	};
}

// Stubs the case list queries to return the given cases.
function stubCaseList(items: CaseSummary[]) {
	convexFake.setQueryData(api.cases.listAll, items);
	convexFake.setQueryData(
		api.cases.listTemplates,
		items.map(({ _id, name }) => ({ _id, name })),
	);
}

describe("Case list delete-confirmation flow (edit mode)", () => {
	// Tests that clicking delete opens the confirm dialog with the case name and stays on the page.
	it("opens the confirm dialog with the case's name, without navigating away", async () => {
		stubCaseList([makeCaseSummary()]);
		await renderPicker("edit");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();

		await deleteCaseButton().click();

		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();
		await expect
			.element(
				page.getByText(
					"This also frees its access code for reuse. This cannot be undone.",
				),
			)
			.toBeVisible();
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that Cancel closes the confirm dialog without deleting the case.
	it("Cancel closes the dialog without deleting the case", async () => {
		stubCaseList([makeCaseSummary()]);
		await renderPicker("edit");

		await deleteCaseButton().click();
		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();
		await page.getByRole("button", { name: "Cancel" }).click();

		await expect.element(page.getByText(DIALOG_TITLE)).not.toBeInTheDocument();
		expect(deleteCase).not.toHaveBeenCalled();
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();
	});

	// Tests that confirming delete calls the mutation with the case id and closes the dialog.
	it("Delete calls the Convex mutation with the case id and closes the dialog", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1" })]);
		deleteCase.mockResolvedValue(null);
		await renderPicker("edit");

		await deleteCaseButton().click();
		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();
		await confirmDelete().click();

		await expect.element(page.getByText(DIALOG_TITLE)).not.toBeInTheDocument();
		expect(deleteCase).toHaveBeenCalledWith({ caseId: "case-1" });
	});

	// Tests that a failed delete keeps the dialog open and shows a toast.
	it("keeps the dialog open and shows a toast when the delete request fails", async () => {
		stubCaseList([makeCaseSummary()]);
		deleteCase.mockRejectedValue(
			appError(ERROR_CODE.CASE_NOT_FOUND, "Case not found."),
		);
		await renderPicker("edit");

		await deleteCaseButton().click();
		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();
		await confirmDelete().click();

		await vi.waitFor(() =>
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith("Case not found."),
		);
		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();
	});

	// Tests that Escape is ignored while a delete is in flight but closes the dialog once idle.
	it("ignores Escape while a delete is in flight, but honors it once idle", async () => {
		stubCaseList([makeCaseSummary()]);
		let resolveDelete: (() => void) | undefined;
		deleteCase.mockImplementation(
			() =>
				new Promise<null>((resolve) => {
					resolveDelete = () => resolve(null);
				}),
		);
		await renderPicker("edit");

		await deleteCaseButton().click();
		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();
		await confirmDelete().click();
		await vi.waitFor(() => expect(deleteCase).toHaveBeenCalledOnce());

		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByText(DIALOG_TITLE)).toBeVisible();

		resolveDelete?.();
		await expect.element(page.getByText(DIALOG_TITLE)).not.toBeInTheDocument();
	});

	// Tests that a case shared for viewing only offers no delete button.
	it("does not offer a delete button for a case the viewer cannot edit", async () => {
		stubCaseList([makeCaseSummary({ canEdit: false })]);
		await renderPicker("edit");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();

		await expect.element(deleteCaseButton()).not.toBeInTheDocument();
	});

	// Tests that template (create) mode offers no delete button.
	it("does not offer a delete button in template (create) mode", async () => {
		stubCaseList([makeCaseSummary()]);
		await renderPicker("template");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();

		await expect.element(deleteCaseButton()).not.toBeInTheDocument();
	});
});

describe("Case list template toggle (edit mode)", () => {
	// Tests that a super admin sees one switch per case, reflecting whether the case is a template.
	it("shows a super admin a switch per case that reflects the template flag", async () => {
		stubCaseList([
			makeCaseSummary({ _id: "case-1", name: "Alpha", isTemplate: true }),
			makeCaseSummary({ _id: "case-2", name: "Beta" }),
		]);
		await renderPicker("edit", "super");
		await expect.element(page.getByText("Alpha")).toBeVisible();

		const switches = page.getByRole("switch", { name: "Offer as a template" });
		await expect
			.element(switches.nth(0))
			.toHaveAttribute("aria-checked", "true");
		await expect
			.element(switches.nth(1))
			.toHaveAttribute("aria-checked", "false");
		expect(switches.elements()).toHaveLength(2);
	});

	// Tests that a regular admin gets no switch.
	it("hides the switch from a regular admin", async () => {
		stubCaseList([makeCaseSummary()]);
		await renderPicker("edit", "admin");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();
		await expect.element(templateSwitch()).not.toBeInTheDocument();
	});

	// Tests that the switch explains itself in a tooltip linked to it.
	it("explains the switch in a tooltip", async () => {
		stubCaseList([makeCaseSummary()]);
		await renderPicker("edit", "super");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();

		await templateSwitch().hover();

		await expect
			.element(page.getByText(/lets every admin copy this case/).first())
			.toBeVisible();
	});

	// Tests that clicking the switch asks the server to flip the template flag.
	it("sends the flipped value when the switch is clicked", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1", isTemplate: false })]);
		setTemplate.mockResolvedValue(null);
		await renderPicker("edit", "super");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();

		await templateSwitch().click();

		await vi.waitFor(() =>
			expect(setTemplate).toHaveBeenCalledWith({
				caseId: "case-1",
				isTemplate: true,
			}),
		);
	});

	// Tests that a failed update shows a toast.
	it("shows a toast when the update fails", async () => {
		stubCaseList([makeCaseSummary()]);
		setTemplate.mockRejectedValue(new Error("Only a super admin can do this."));
		await renderPicker("edit", "super");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();

		await templateSwitch().click();

		await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalled());
	});

	// Tests that template mode offers no switch even to a super admin.
	it("does not offer the switch in template mode", async () => {
		stubCaseList([makeCaseSummary()]);
		await renderPicker("template", "super");
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();
		await expect.element(templateSwitch()).not.toBeInTheDocument();
	});
});
