import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import * as sonner from "svelte-sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIEWER_CONTEXT_KEY } from "../../src/lib/adminViewer.js";
import TemplatePicker from "../../src/lib/components/TemplatePicker.svelte";

const mockUseQuery = vi.fn();
const mockDeleteCase = vi.fn();
const mockSetDemo = vi.fn();

vi.mock("convex-svelte", async () => {
	const { getFunctionName } = await import("convex/server");
	return {
		useQuery: (...args: unknown[]) => mockUseQuery(...args),
		useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
			getFunctionName(ref) === "api/cases:setDemo"
				? mockSetDemo
				: mockDeleteCase,
	};
});

type CaseSummary = {
	_id: string;
	name: string;
	accessCode?: string;
	isDemo?: boolean;
};

// Renders the picker in a mode, signed in with the given admin role.
function renderPicker(
	mode: "template" | "edit" | "demo",
	role: "admin" | "super" = "admin",
) {
	return render(TemplatePicker, {
		props: { mode },
		context: new Map([[VIEWER_CONTEXT_KEY, { data: { role } }]]),
	});
}

// Builds a case summary with defaults and optional overrides.
function makeCaseSummary(overrides: Partial<CaseSummary> = {}): CaseSummary {
	return {
		_id: "case-1",
		name: "Sterling Industries",
		accessCode: "sterling",
		isDemo: false,
		...overrides,
	};
}

// Stubs the case list query to return the given cases.
function stubCaseList(items: CaseSummary[]) {
	mockUseQuery.mockReturnValue({
		data: items,
		isLoading: false,
		error: undefined,
	});
}

beforeEach(() => {
	mockUseQuery.mockReset();
	mockDeleteCase.mockReset();
	mockSetDemo.mockReset();
});

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
		expect(mockDeleteCase).not.toHaveBeenCalled();
		expect(screen.getByText("Sterling Industries")).toBeInTheDocument();
	});

	// Tests that confirming delete calls the mutation with the case id and closes the dialog.
	it("Delete calls the Convex mutation with the case id and closes the dialog", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1" })]);
		mockDeleteCase.mockResolvedValue(undefined);
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
		expect(mockDeleteCase).toHaveBeenCalledWith({ caseId: "case-1" });
	});

	// Tests that a failed delete keeps the dialog open and shows a toast.
	it("keeps the dialog open and shows a toast when the delete request fails", async () => {
		stubCaseList([makeCaseSummary()]);
		mockDeleteCase.mockRejectedValue(new Error("Case not found."));
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
		mockDeleteCase.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveDelete = resolve;
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

describe("TemplatePicker demo toggle (edit mode)", () => {
	// Tests that a super admin sees one switch per case, reflecting whether the case is a demo.
	it("shows a super admin a switch per case that reflects the demo flag", async () => {
		stubCaseList([
			makeCaseSummary({ _id: "case-1", name: "Alpha", isDemo: true }),
			makeCaseSummary({ _id: "case-2", name: "Beta" }),
		]);
		renderPicker("edit", "super");
		await screen.findByText("Alpha");

		const switches = screen.getAllByRole("switch", {
			name: "Show as a demo case",
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
			"every admin can view this case read-only",
		);
		expect(screen.getByRole("switch")).toHaveAccessibleDescription(
			/every admin can view this case read-only/,
		);
	});

	// Tests that clicking the switch asks the server to flip the demo flag.
	it("sends the flipped value when the switch is clicked", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1", isDemo: false })]);
		mockSetDemo.mockResolvedValue(undefined);
		const user = userEvent.setup();
		renderPicker("edit", "super");
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("switch"));

		expect(mockSetDemo).toHaveBeenCalledWith({
			caseId: "case-1",
			isDemo: true,
		});
	});

	// Tests that a failed update shows a toast.
	it("shows a toast when the update fails", async () => {
		stubCaseList([makeCaseSummary()]);
		mockSetDemo.mockRejectedValue(new Error("Only a super admin can do this."));
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

describe("TemplatePicker demo mode", () => {
	// Tests that demo mode links each case to its demo page and shows no access code, delete or switch.
	it("links to the demo page without access codes, delete or switch", async () => {
		stubCaseList([{ _id: "case-1", name: "Sterling Industries" }]);
		renderPicker("demo", "super");
		await screen.findByText("Sterling Industries");

		expect(
			screen.getByRole("link", { name: /Sterling Industries/ }),
		).toHaveAttribute("href", "/admin/new/demo/case-1");
		expect(screen.queryByText(/Access code/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Delete case" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});

	// Tests that demo mode has its own heading and empty state.
	it("has its own heading and empty message", async () => {
		stubCaseList([]);
		renderPicker("demo");
		expect(
			await screen.findByText("No demo cases are available yet."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Browse example cases" }),
		).toBeInTheDocument();
	});
});
