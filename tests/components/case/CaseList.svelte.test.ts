import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { ERROR_CODE } from "#shared/errors.js";
import CaseList from "../../../src/lib/components/case/CaseList.svelte";
import {
	clientAppError,
	clientServerError,
} from "../../support/convexClientErrors.js";

type Item = { _id: string; name: string; accessCode?: string };

// Renders the list for a query in the given state.
function renderList(query: {
	data?: Item[];
	isLoading?: boolean;
	error?: Error;
}) {
	return render(CaseList<Item>, {
		eyebrow: "Admin",
		title: "Your cases",
		description: "Pick a case.",
		query: {
			data: query.data,
			isLoading: query.isLoading ?? false,
			error: query.error,
		},
		href: (item: Item) => `/admin/cases/${item._id}`,
	});
}

describe("case list states", () => {
	// Tests that a loading list says so and shows no cases or empty message.
	it("shows a loading message while the cases load", async () => {
		await renderList({ isLoading: true });

		await expect.element(page.getByText("Loading cases...")).toBeVisible();
		await expect
			.element(page.getByText("No cases found."))
			.not.toBeInTheDocument();
	});

	// Tests that a failure the server explains shows its message.
	it("shows the server's message when loading fails with one", async () => {
		await renderList({
			error: clientAppError(
				"cases:listAll",
				ERROR_CODE.NOT_AUTHORIZED,
				"Your account is not authorized.",
				"Q",
			),
		});

		await expect
			.element(page.getByText("Your account is not authorized."))
			.toBeVisible();
	});

	// Tests that an unexplained failure, such as a redacted server error, shows a generic message.
	it("shows a generic message for an unexplained failure", async () => {
		await renderList({ error: clientServerError("cases:listAll", "Q") });

		await expect.element(page.getByText("Failed to load cases.")).toBeVisible();
	});

	// Tests that a list with no cases says so.
	it("says when there are no cases", async () => {
		await renderList({ data: [] });

		await expect.element(page.getByText("No cases found.")).toBeVisible();
		await expect.element(page.getByRole("link")).not.toBeInTheDocument();
	});

	// Tests that each case links to its page and shows its access code only when it has one.
	it("links each case and shows an access code only when there is one", async () => {
		await renderList({
			data: [
				{ _id: "a", name: "Acme", accessCode: "acme" },
				{ _id: "b", name: "Template copy" },
			],
		});

		await expect
			.element(page.getByRole("link", { name: /Acme/ }))
			.toHaveAttribute("href", "/admin/cases/a");
		await expect.element(page.getByText("Access code: acme")).toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Template copy" }))
			.toHaveAttribute("href", "/admin/cases/b");
		expect(page.getByText(/^Access code:/).elements()).toHaveLength(1);
	});
});
