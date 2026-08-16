import { expect, test } from "@playwright/test";
import { ADMIN_ROLE, caseDoc, mockApi, signInAsAdmin } from "./mockApi.js";

// Mirrors DemoCaseView.svelte's own hardcoded DEMO_CASE_ID -- update this alongside that
// constant if the dev deployment is ever reseeded.
const DEMO_CASE_ID = "k5787w72emrc30bkhxh03e85p98c023g";

test("the demo case view renders the case read-only", async ({ page }) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/cases:get",
				args: { caseId: DEMO_CASE_ID },
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
				name: "api/cases:get",
				args: { caseId: DEMO_CASE_ID },
				error: "Failed to load demo.",
			},
		],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await expect(page.getByText("Failed to load demo.")).toBeVisible();
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

	await page.getByRole("button", { name: /Sterling Industries/ }).click();

	await expect(page).toHaveURL(/\/admin\/cases\/new\?template=case5/);
	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");
	await expect(page.getByLabel("Access code")).toHaveValue("sterling");
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
