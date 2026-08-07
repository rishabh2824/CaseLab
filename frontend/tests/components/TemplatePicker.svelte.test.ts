// Client project: TemplatePicker renders the admin case list and (in "edit"
// mode) a per-card delete flow gated behind DestructiveConfirmDialog. Focus
// here is that flow — open/cancel/confirm and the on-failure path — not the
// plain template-picking click-through.
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { cases } from "../../src/lib/case/cases.svelte.js";
import TemplatePicker from "../../src/lib/components/TemplatePicker.svelte";
import type { Api } from "../../src/lib/types.js";
import { server } from "../support/msw.js";

function caseSummary(
	overrides: Partial<Api<"CaseSummary">> = {},
): Api<"CaseSummary"> {
	return {
		id: 1,
		case_name: "Sterling Industries",
		access_code: "STERLING",
		...overrides,
	};
}

function stubCaseList(items: Api<"CaseSummary">[]) {
	server.use(
		http.get("*/api/cases", () =>
			HttpResponse.json({ cases: items } satisfies Api<"CaseListResponse">),
		),
	);
}

beforeEach(() => {
	// cases is a module singleton (see cases.svelte.ts) -- reset between tests
	// the same way the list itself would after a fresh page load. invalidate()
	// also clears the "already loaded" cache flag, so each test's mounted
	// TemplatePicker actually re-fetches from its own stubCaseList instead of
	// short-circuiting on a previous test's cached result.
	cases.list = [];
	cases.isLoading = false;
	cases.error = "";
	cases.invalidate();
});

describe("TemplatePicker delete-confirmation flow (edit mode)", () => {
	it("opens the confirm dialog with the case's name, without navigating away", async () => {
		stubCaseList([caseSummary()]);
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
		stubCaseList([caseSummary()]);
		let deleteCalled = false;
		server.use(
			http.delete("*/api/cases/:id", () => {
				deleteCalled = true;
				return HttpResponse.json({ ok: true });
			}),
		);
		const user = userEvent.setup();
		render(TemplatePicker, { props: { mode: "edit" } });
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		await screen.findByText('Delete "Sterling Industries"?');
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(
			screen.queryByText('Delete "Sterling Industries"?'),
		).not.toBeInTheDocument();
		expect(deleteCalled).toBe(false);
		expect(screen.getByText("Sterling Industries")).toBeInTheDocument();
	});

	it("Delete removes the case from the list and closes the dialog", async () => {
		stubCaseList([caseSummary({ id: 1, case_name: "Sterling Industries" })]);
		let deletedId: string | undefined;
		server.use(
			http.delete("*/api/cases/:id", ({ params }) => {
				deletedId = params.id as string;
				return HttpResponse.json({ ok: true });
			}),
		);
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
		expect(deletedId).toBe("1");
		expect(screen.queryByText("Sterling Industries")).not.toBeInTheDocument();
		expect(cases.list).toEqual([]);
	});

	it("keeps the dialog open and the case in the list when the delete request fails", async () => {
		stubCaseList([caseSummary()]);
		server.use(
			http.delete("*/api/cases/:id", () =>
				HttpResponse.json({ detail: "Case not found." }, { status: 404 }),
			),
		);
		const user = userEvent.setup();
		render(TemplatePicker, { props: { mode: "edit" } });
		await screen.findByText("Sterling Industries");

		await user.click(screen.getByRole("button", { name: "Delete case" }));
		const dialog = await screen.findByText('Delete "Sterling Industries"?');
		await user.click(screen.getByRole("button", { name: "Delete" }));

		// The failure path (confirmDelete's catch) never clears pendingDelete,
		// so the dialog stays open and the case is never removed.
		await waitFor(() => expect(dialog).toBeInTheDocument());
		expect(cases.list).toHaveLength(1);
	});

	it("does not offer a delete button in template (create) mode", async () => {
		stubCaseList([caseSummary()]);
		render(TemplatePicker, { props: { mode: "template" } });
		await screen.findByText("Sterling Industries");

		expect(
			screen.queryByRole("button", { name: "Delete case" }),
		).not.toBeInTheDocument();
	});
});
