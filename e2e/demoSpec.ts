import { expect, test } from "@playwright/test";
import { ADMIN_ROLE, caseDoc, mockApi, signInAsAdmin } from "./mockApi.js";

// Tests that the demo list links to a read-only view of the chosen demo case.
test("the demo list opens a read-only view of the chosen case", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "cases:listDemos",
				args: {},
				data: [{ _id: "case5", name: "Sterling Industries" }],
			},
			{
				name: "cases:getDemo",
				args: { caseId: "case5" },
				data: caseDoc({ _id: "case5", isDemo: true, accessCode: undefined }),
			},
		],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await page.getByRole("link", { name: /Sterling Industries/ }).click();

	await expect(page).toHaveURL(/\/admin\/new\/demo\/case5/);
	await expect(page.getByText("Demo Case · Read Only")).toBeVisible();
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	await expect(page.getByText("Mary").first()).toBeVisible();
	await expect(page.getByText("Access code")).toHaveCount(0);
	await expect(page.locator("input, textarea")).toHaveCount(0);
});

// Tests that a failed demo-case load shows an inline error.
test("a failed demo-case load surfaces an inline error", async ({ page }) => {
	await mockApi(page, {
		queries: [
			{
				name: "cases:getDemo",
				args: { caseId: "case5" },
				error: "Failed to load demo.",
			},
		],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo/case5");

	await expect(page.getByText("Failed to load demo.")).toBeVisible();
});

// Tests that a case which is not a demo shows a plain message rather than an error.
test("a case that is not a demo shows a plain message, not an error", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [{ name: "cases:getDemo", args: { caseId: "case5" }, data: null }],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo/case5");

	await expect(
		page.getByText("This case is not available as a demo."),
	).toBeVisible();
});

// Tests that the demo list shows an empty state when no case is flagged as a demo.
test("the demo list shows an empty state when there are no demo cases", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [{ name: "cases:listDemos", args: {}, data: [] }],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/demo");

	await expect(
		page.getByText("No demo cases are available yet."),
	).toBeVisible();
});

// Tests that a super admin can switch a case on as a demo, and that a regular admin has no switch.
test("a super admin can toggle a case as a demo, a regular admin cannot", async ({
	page,
	browser,
}) => {
	let cases = [caseDoc({ _id: "case1", isDemo: false })];
	await mockApi(page, {
		queries: [{ name: "cases:listAll", args: {}, data: cases }],
		mutations: {
			"cases:setDemo": async (
				args: { caseId: string; isDemo: boolean },
				{ setQuery },
			) => {
				cases = cases.map((c) =>
					c._id === args.caseId ? { ...c, isDemo: args.isDemo } : c,
				);
				await setQuery("cases:listAll", {}, { data: cases });
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.SUPER });
	await page.goto("/admin/edit");

	const toggle = page.getByRole("switch", { name: "Show as a demo case" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await toggle.hover();
	await expect(page.getByRole("tooltip")).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");

	const regular = await browser.newPage();
	await mockApi(regular, {
		queries: [{ name: "cases:listAll", args: {}, data: cases }],
	});
	await signInAsAdmin(regular, { role: ADMIN_ROLE.ADMIN });
	await regular.goto("/admin/edit");
	await expect(regular.getByText("Sterling Industries")).toBeVisible();
	await expect(regular.getByRole("switch")).toHaveCount(0);
});

// Tests that choosing a template seeds a new case form.
test("choosing a template seeds a new case form", async ({ page }) => {
	await mockApi(page, {
		queries: [
			{
				name: "cases:listAll",
				args: {},
				data: [caseDoc({ _id: "case5" })],
			},
			{
				name: "cases:getForEdit",
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
	await expect(page.getByLabel("Access code")).toHaveValue("");
});

// Tests that the template picker shows an empty state when there are no cases.
test("the template picker shows an empty state when there are no cases", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [{ name: "cases:listAll", args: {}, data: [] }],
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/template");

	await expect(page.getByText("No cases found.")).toBeVisible();
});
