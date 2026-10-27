import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import type { FunctionReturnType } from "convex/server";
import * as sonner from "svelte-sonner";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import TemplatePicker from "../../src/lib/components/TemplatePicker.svelte";
import { convexFake } from "../support/convexFake.svelte.js";

let viewerRole: "admin" | "super" = "admin";

vi.mock("#lib/adminViewer.js", () => ({
	getViewerContext: () => ({ data: { role: viewerRole } }),
}));

const deleteCase = convexFake.mutation(api.cases.deleteCase);
const setTemplate = convexFake.mutation(api.cases.setTemplate);

type CaseSummary = FunctionReturnType<typeof api.cases.listAll>[number];

// Renders the picker in a mode, signed in with the given admin role.
function renderPicker(
	mode: "template" | "edit",
	role: "admin" | "super" = "admin",
) {
	viewerRole = role;
	return render(TemplatePicker, { props: { mode } });
}

// Builds a case summary with defaults and optional overrides.
function makeCaseSummary(
	overrides: Partial<Omit<CaseSummary, "_id">> & { _id?: string } = {},
): CaseSummary {
	return {
		name: "Sterling Industries",
		accessCode: "sterling",
		isTemplate: false,
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

describe("TemplatePicker delete-confirmation flow (edit mode)", () => {
	// Tests that clicking delete opens the confirm dialog with the case name and stays on the page.
	it("opens the confirm dialog with the case's name, without navigating away", async () => {
		stubCaseList([makeCaseSummary()]);
		const user = userEvent.setup();
		renderPicker("edit");
		await screen.findByText("Sterling Industries");
		const nav = await import("$app/navigation");

		await user.click(screen.getByRole("button", { name: "Delete case" }));

		expect(
			await screen.findByText('Delete "Sterling Industries"?'),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"This also frees its access code for reuse. This cannot be undone.",
			),
		).toBeInTheDocument();
		expect(nav.goto).not.toHaveBeenCalled();
	});

	// Tests that Cancel closes the confirm dialog without deleting the case.
	it("Cancel closes the dialog without deleting the case", async () => {
		stubCaseList([makeCaseSummary()]);
		const user = userEvent.setup();
		renderPicker("edit");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		await screen.findByText('Delete "Sterling Industries"?');
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(
			screen.queryByText('Delete "Sterling Industries"?'),
		).not.toBeInTheDocument();
		expect(deleteCase).not.toHaveBeenCalled();
		expect(screen.getByText("Sterling Industries")).toBeInTheDocument();
	});

	// Tests that confirming delete calls the mutation with the case id and closes the dialog.
	it("Delete calls the Convex mutation with the case id and closes the dialog", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1" })]);
		deleteCase.mockResolvedValue(null);
		const user = userEvent.setup();
		renderPicker("edit");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		await screen.findByText('Delete "Sterling Industries"?');
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(
				screen.queryByText('Delete "Sterling Industries"?'),
			).not.toBeInTheDocument(),
		);
		expect(deleteCase).toHaveBeenCalledWith({ caseId: "case-1" });
	});

	// Tests that a failed delete keeps the dialog open and shows a toast.
	it("keeps the dialog open and shows a toast when the delete request fails", async () => {
		stubCaseList([makeCaseSummary()]);
		deleteCase.mockRejectedValue(new Error("Case not found."));
		const user = userEvent.setup();
		renderPicker("edit");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		const dialog = await screen.findByText('Delete "Sterling Industries"?');
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith("Case not found."),
		);
		expect(dialog).toBeInTheDocument();
		expect(screen.getByText("Sterling Industries")).toBeInTheDocument();
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
		const user = userEvent.setup();
		renderPicker("edit");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		const dialogTitle = await screen.findByText(
			'Delete "Sterling Industries"?',
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await user.keyboard("{Escape}");
		expect(dialogTitle).toBeInTheDocument();

		resolveDelete?.();
		await waitFor(() => expect(dialogTitle).not.toBeInTheDocument());
	});

	// Tests that template (create) mode offers no delete button.
	it("does not offer a delete button in template (create) mode", async () => {
		stubCaseList([makeCaseSummary()]);
		renderPicker("template");
		await screen.findByText("Sterling Industries");

		expect(
			screen.queryByRole("button", { name: "Delete case" }),
		).not.toBeInTheDocument();
	});
});

describe("TemplatePicker template toggle (edit mode)", () => {
	// Tests that a super admin sees one switch per case, reflecting whether the case is a template.
	it("shows a super admin a switch per case that reflects the template flag", async () => {
		stubCaseList([
			makeCaseSummary({ _id: "case-1", name: "Alpha", isTemplate: true }),
			makeCaseSummary({ _id: "case-2", name: "Beta" }),
		]);
		renderPicker("edit", "super");
		await screen.findByText("Alpha");

		const switches = screen.getAllByRole("switch", {
			name: "Offer as a template",
		});
		expect(switches.map((el) => el.getAttribute("aria-checked"))).toEqual([
			"true",
			"false",
		]);
	});

	// Tests that a regular admin gets no switch.
	it("hides the switch from a regular admin", async () => {
		stubCaseList([makeCaseSummary()]);
		renderPicker("edit", "admin");
		await screen.findByText("Sterling Industries");
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});

	// Tests that the switch explains itself in a tooltip linked to it.
	it("describes the switch with a tooltip", async () => {
		stubCaseList([makeCaseSummary()]);
		renderPicker("edit", "super");
		await screen.findByText("Sterling Industries");

		const tooltip = screen.getByRole("tooltip");
		expect(tooltip).toHaveTextContent(
			"Template: lets every admin copy this case as the starting point for a new one. Access code stays hidden.",
		);
		expect(screen.getByRole("switch")).toHaveAccessibleDescription(
			/lets every admin copy this case/,
		);
	});

	// Tests that clicking the switch asks the server to flip the template flag.
	it("sends the flipped value when the switch is clicked", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1", isTemplate: false })]);
		setTemplate.mockResolvedValue(null);
		const user = userEvent.setup();
		renderPicker("edit", "super");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("switch"));

		expect(setTemplate).toHaveBeenCalledWith({
			caseId: "case-1",
			isTemplate: true,
		});
	});

	// Tests that a failed update shows a toast.
	it("shows a toast when the update fails", async () => {
		stubCaseList([makeCaseSummary()]);
		setTemplate.mockRejectedValue(new Error("Only a super admin can do this."));
		const user = userEvent.setup();
		renderPicker("edit", "super");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("switch"));

		await waitFor(() => expect(sonner.toast).toHaveBeenCalled());
	});

	// Tests that template mode offers no switch even to a super admin.
	it("does not offer the switch in template mode", async () => {
		stubCaseList([makeCaseSummary()]);
		renderPicker("template", "super");
		await screen.findByText("Sterling Industries");
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});
});
