import { expect, test } from "@playwright/test";
import { ADMIN_ROLE, caseDoc, mockApi, signInAsAdmin } from "./mockApi.js";

test("the demo case view renders the case read-only", async ({ page }) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/cases:getDemo",
				args: {},
				data: caseDoc(),
			},
		],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await expect(page.getByText("Sterling Industries")).toBeVisible();
	await expect(page.getByText("Demo Case", { exact: false })).toBeVisible();
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	await expect(page.getByText("Mary").first()).toBeVisible();

	// Read-only: nothing on this screen accepts input.
	await expect(page.locator("input, textarea")).toHaveCount(0);
});

test("a failed demo-case load surfaces an inline error", async ({ page }) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/cases:getDemo",
				args: {},
				error: "Failed to load demo.",
			},
		],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await expect(page.getByText("Failed to load demo.")).toBeVisible();
});

// getDemo returns null (rather than throwing) when DEMO_CASE_ID isn't set for this
// deployment -- distinct from the error case above, which is a real query failure.
test("no demo case configured shows a plain message, not an error", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [{ name: "api/cases:getDemo", args: {}, data: null }],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await expect(
		page.getByText("No demo case is set up for this deployment."),
	).toBeVisible();
});

test("choosing a template seeds a new case form", async ({ page }) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/cases:listAll",
				args: {},
				data: [caseDoc({ _id: "case5" })],
			},
			{
				name: "api/cases:getForEdit",
				args: { caseId: "case5" },
				data: caseDoc({ _id: "case5" }),
			},
		],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/template");

	await page.getByRole("link", { name: /Sterling Industries/ }).click();

	await expect(page).toHaveURL(/\/admin\/cases\/new\?template=case5/);
	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");
	// Not carried over from the template: the source case's code is already claimed, so copying
	// it here would just guarantee the new case's first save fails (see CaseForm's loadCase).
	await expect(page.getByLabel("Access code")).toHaveValue("");
});

test("the template picker shows an empty state when there are no cases", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [{ name: "api/cases:listAll", args: {}, data: [] }],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/template");

	await expect(page.getByText("No cases found.")).toBeVisible();
});
