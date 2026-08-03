import { expect, test } from "@playwright/test";
import {
	ADMIN_ROLE,
	caseDetail,
	caseSummary,
	demoCaseDetail,
	mockApi,
	signInAsAdmin,
} from "./mockApi.js";

test("the demo case view renders the case read-only", async ({ page }) => {
	await mockApi(page, {
		"GET /api/cases/demo": () => ({ json: { case: demoCaseDetail() } }),
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
		"GET /api/cases/demo": () => ({
			status: 500,
			json: { detail: "Failed to load demo." },
		}),
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await expect(page.getByText("Failed to load demo.")).toBeVisible();
});

test("choosing a template seeds a new case form", async ({ page }) => {
	await mockApi(page, {
		"GET /api/cases": () => ({
			json: {
				cases: [
					caseSummary({
						id: 5,
						case_name: "Sterling Industries",
						access_code: "STERLING",
					}),
				],
			},
		}),
		"GET /api/cases/:id": () => ({ json: { case: caseDetail({ id: 5 }) } }),
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/template");

	await page.getByRole("button", { name: /Sterling Industries/ }).click();

	await expect(page).toHaveURL(/\/admin\/new\/form\?template=5/);
	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");
	await expect(page.getByLabel("Access code")).toHaveValue("STERLING");
});

test("the template picker shows an empty state when there are no cases", async ({
	page,
}) => {
	await mockApi(page, {
		"GET /api/cases": () => ({ json: { cases: [] } }),
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/template");

	await expect(page.getByText("No cases found.")).toBeVisible();
});
