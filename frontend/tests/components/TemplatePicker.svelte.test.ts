// Client project: TemplatePicker renders the admin case list and (in "edit"
// mode) a per-card delete flow gated behind DestructiveConfirmDialog. Focus
// here is that flow — open/cancel/confirm and the on-failure path — not the
// plain template-picking click-through.
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import * as sonner from "svelte-sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TemplatePicker from "../../src/lib/components/TemplatePicker.svelte";

const mockUseQuery = vi.fn();
const mockDeleteCase = vi.fn();

vi.mock("convex-svelte", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
	useMutation: () => mockDeleteCase,
}));

type CaseSummary = { _id: string; name: string; accessCode?: string };

function makeCaseSummary(overrides: Partial<CaseSummary> = {}): CaseSummary {
	return {
		_id: "case-1",
		name: "Sterling Industries",
		accessCode: "sterling",
		...overrides,
	};
}

function stubCaseList(items: CaseSummary[]) {
	mockUseQuery.mockReturnValue({ data: items, isLoading: false, error: undefined });
}

beforeEach(() => {
	mockUseQuery.mockReset();
	mockDeleteCase.mockReset();
});

describe("TemplatePicker delete-confirmation flow (edit mode)", () => {
	it("opens the confirm dialog with the case's name, without navigating away", async () => {
		stubCaseList([makeCaseSummary()]);
		const user = userEvent.setup();
		render(TemplatePicker, { props: { mode: "edit" } });
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
		// The delete button sits inside the same clickable card as the
		// open-for-edit button -- stopPropagation must keep this from also
		// firing openCase's goto.
		expect(nav.goto).not.toHaveBeenCalled();
	});

	it("Cancel closes the dialog without deleting the case", async () => {
		stubCaseList([makeCaseSummary()]);
		const user = userEvent.setup();
		render(TemplatePicker, { props: { mode: "edit" } });
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

	it("Delete calls the Convex mutation with the case id and closes the dialog", async () => {
		stubCaseList([makeCaseSummary({ _id: "case-1" })]);
		mockDeleteCase.mockResolvedValue(undefined);
		const user = userEvent.setup();
		render(TemplatePicker, { props: { mode: "edit" } });
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

	it("keeps the dialog open and shows a toast when the delete request fails", async () => {
		stubCaseList([makeCaseSummary()]);
		mockDeleteCase.mockRejectedValue(new Error("Case not found."));
		const user = userEvent.setup();
		render(TemplatePicker, { props: { mode: "edit" } });
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		const dialog = await screen.findByText('Delete "Sterling Industries"?');
		await user.click(screen.getByRole("button", { name: "Delete" }));

		// The failure path (confirmDelete's catch) never clears pendingDelete,
		// so the dialog stays open and the case is never removed from view.
		await waitFor(() =>
			expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith("Case not found."),
		);
		expect(dialog).toBeInTheDocument();
		expect(screen.getByText("Sterling Industries")).toBeInTheDocument();
	});

	it("does not offer a delete button in template (create) mode", async () => {
		stubCaseList([makeCaseSummary()]);
		render(TemplatePicker, { props: { mode: "template" } });
		await screen.findByText("Sterling Industries");

		expect(
			screen.queryByRole("button", { name: "Delete case" }),
		).not.toBeInTheDocument();
	});
});
