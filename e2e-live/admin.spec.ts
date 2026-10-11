import { api, expect, test, uniqueCode } from "./fixtures.js";

test("an admin creates a case in the form and a student can then open it", async ({
	page,
	browser,
	signInAs,
}) => {
	const accessCode = uniqueCode();
	await signInAs(page, "admin");
	await page.goto("/admin/cases/new");

	await page.getByLabel("Case name").fill("Riverside Manufacturing");
	await page.getByLabel("Initial brief").fill("Cut logistics costs by 10%.");
	await page.getByLabel("Access code").fill(accessCode);
	await page.getByRole("button", { name: "+ Add root persona" }).click();
	await page.getByLabel("Persona name").fill("Sam Rivera");
	await page.getByLabel("Title/Role").fill("Operations Lead");
	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case saved successfully.")).toBeVisible();

	const student = await browser.newPage({ baseURL: "http://localhost:4173" });
	await student.goto("/");
	await student.getByPlaceholder("Enter access code").fill(accessCode);
	await student.getByRole("button", { name: "Open Case" }).click();
	await expect(student).toHaveURL(/\/student$/);
	await expect(student.getByText("Cut logistics costs by 10%.")).toBeVisible();
	await expect(
		student.getByRole("button", { name: /Sam Rivera/ }),
	).toBeVisible();
	await student.close();
});

test("an admin edits a case and then deletes it", async ({
	page,
	signInAs,
	seedCase,
	apiAs,
}) => {
	const { caseId, name, accessCode } = await seedCase({ role: "admin" });
	await signInAs(page, "admin");
	await page.goto(`/admin/cases/${caseId}/edit`);

	await expect(page.getByLabel("Case name")).toHaveValue(name);
	await page.getByLabel("Case name").fill("Renamed by the admin");
	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case updated successfully.")).toBeVisible();

	const admin = await apiAs("admin");
	const afterEdit = await admin.query(api.cases.listAll, {});
	expect(afterEdit.map((c) => c.name)).toContain("Renamed by the admin");

	await page.goto("/admin/edit");
	await expect(page.getByText("Renamed by the admin")).toBeVisible();
	const row = page
		.locator("div")
		.filter({ has: page.getByText(`Access code: ${accessCode}`) })
		.filter({ has: page.getByRole("button", { name: "Delete case" }) })
		.last();
	await row.getByRole("button", { name: "Delete case" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(page.getByRole("alertdialog")).not.toBeVisible();
	await expect(page.getByText("Renamed by the admin")).toHaveCount(0);

	const afterDelete = await admin.query(api.cases.listAll, {});
	expect(afterDelete.map((c) => c._id)).not.toContain(caseId);
});

test("a signed-in user who is not on the roster is turned away", async ({
	page,
	signInAs,
}) => {
	await signInAs(page, "stranger");
	await page.goto("/admin");

	await expect(page.getByText("Not authorized.")).toBeVisible();
	await expect(page.getByText("Create New Case")).not.toBeVisible();
});

test("a super admin adds and removes an admin", async ({ page, signInAs }) => {
	const email = `${uniqueCode()}@e2e.caselab.invalid`;
	await signInAs(page, "super");
	await page.goto("/admin/admins");

	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Add admin" }).click();
	await expect(page.getByText(`Added ${email}.`)).toBeVisible();
	await expect(page.getByText(email, { exact: true })).toBeVisible();

	const row = page.getByRole("row", { name: new RegExp(email) });
	await row.getByRole("button", { name: "Delete" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(page.getByText(email, { exact: true })).not.toBeVisible();
});

test("a regular admin cannot open the admin management page", async ({
	page,
	signInAs,
}) => {
	await signInAs(page, "admin");
	await page.goto("/admin/admins");

	await expect(page).toHaveURL(/\/admin$/);
});
