import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildHTMLForm } from "../src/lib/case/exportCase.js";
import { ADMIN_ROLE, caseDoc, mockApi, signInAsAdmin } from "./mockApi.js";

// Tests that visiting /admin without a session starts a Google sign-in.
test("an unauthenticated visit to /admin attempts a Google sign-in", async ({
	page,
}) => {
	await mockApi(page, {});
	const signInRequest = page.waitForRequest(
		(req) => req.method() === "POST" && req.url().includes("/sign-in/social"),
	);
	await page.goto("/admin");
	const request = await signInRequest;
	expect(request.postDataJSON()).toMatchObject({ provider: "google" });
});

// Tests that a signed-in ADMIN reaches /admin without seeing the manage-admins control.
test("a signed-in ADMIN reaches /admin without the manage-admins control", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin");
	await expect(
		page.getByRole("heading", { name: "Choose what you want to work on" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "Manage admins" })).toHaveCount(
		0,
	);
});

// Tests that a signed-in SUPER admin sees the manage-admins control.
test("a signed-in SUPER admin sees the manage-admins control", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.SUPER });
	await page.goto("/admin");
	await expect(page.getByRole("link", { name: "Manage admins" })).toBeVisible();
});

// Tests that visiting /admin/admins without a session starts a Google sign-in.
test("an unauthenticated visit to /admin/admins attempts a Google sign-in", async ({
	page,
}) => {
	await mockApi(page, {});
	const signInRequest = page.waitForRequest(
		(req) => req.method() === "POST" && req.url().includes("/sign-in/social"),
	);
	await page.goto("/admin/admins");
	const request = await signInRequest;
	expect(request.postDataJSON()).toMatchObject({ provider: "google" });
});

// Tests that a non-super admin visiting /admin/admins is redirected to /admin.
test("a non-super admin visiting /admin/admins redirects to /admin", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/admins");
	await expect(page).toHaveURL(/\/admin$/);
});

// Tests that /admin/edit lists cases from the API and deleting one removes it from the list.
test("/admin/edit lists cases from cases:listAll and deleting one removes it", async ({
	page,
}) => {
	let cases = [
		caseDoc({
			_id: "case1",
			name: "Sterling Industries",
			accessCode: "sterling",
		}),
		caseDoc({ _id: "case2", name: "Acme Corp", accessCode: "acme" }),
	];
	await mockApi(page, {
		queries: [{ name: "cases:listAll", args: {}, data: cases }],
		mutations: {
			"cases:deleteCase": async (args: { caseId: string }, { setQuery }) => {
				cases = cases.filter((c) => c._id !== args.caseId);
				await setQuery("cases:listAll", {}, { data: cases });
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/edit");

	await expect(page.getByText("Sterling Industries")).toBeVisible();
	await expect(page.getByText("Acme Corp")).toBeVisible();

	await page.getByRole("button", { name: "Delete case" }).first().click();
	await expect(page.getByText('Delete "Sterling Industries"?')).toBeVisible();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();

	await expect(page.getByRole("alertdialog")).not.toBeVisible();
	await expect(page.getByText("Sterling Industries")).not.toBeVisible();
	await expect(page.getByText("Acme Corp")).toBeVisible();
});

// Tests that creating a case submits the expected payload.
test("creating a case submits the expected payload", async ({ page }) => {
	let createArgs: Record<string, unknown> | undefined;
	await mockApi(page, {
		mutations: {
			"cases:create": (args: Record<string, unknown>) => {
				createArgs = args;
				return { caseId: "new-case-id" };
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	await page.getByLabel("Case name").fill("Riverside Manufacturing");
	await page.getByLabel("Initial brief").fill("Cut logistics costs by 10%.");
	await page.getByLabel("Access code").fill("riverside");

	await page.getByRole("button", { name: "+ Add root persona" }).click();
	await page.getByLabel("Persona name").fill("Sam Rivera");
	await page.getByLabel("Title/Role").fill("Operations Lead");

	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case saved successfully.")).toBeVisible();

	expect(createArgs?.name).toBe("Riverside Manufacturing");
	expect(createArgs?.accessCode).toBe("riverside");
	const structure = createArgs?.structure as {
		personas: Array<{ id: string; name: string }>;
		roots: string[];
	};
	expect(structure.personas).toHaveLength(1);
	expect(structure.personas[0]?.name).toBe("Sam Rivera");
	expect(structure.roots).toEqual([structure.personas[0]?.id]);
});

// Tests that only edited fields show errors until Submit, which sends no request and reveals the rest.
test("submitting with required fields empty does not issue a request and reveals the field errors", async ({
	page,
}) => {
	let created = false;
	await mockApi(page, {
		mutations: {
			"cases:create": () => {
				created = true;
				return { caseId: "new-case-id" };
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	const nameInput = page.getByLabel("Case name");
	await nameInput.fill("x");
	await nameInput.fill("");

	await expect(page.getByText("Case name is required.")).toBeVisible();
	await expect(page.getByText("Initial brief is required.")).not.toBeVisible();

	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Initial brief is required.")).toBeVisible();
	await expect(page.getByText("Access code is required.")).toBeVisible();
	await expect(page.getByText("At least 1 persona is required")).toBeVisible();
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
	expect(created).toBe(false);
});

// Tests that editing a case populates the form and saving updates the existing case.
test("editing a case populates the form and the save updates the existing case", async ({
	page,
}) => {
	let updateArgs: Record<string, unknown> | undefined;
	await mockApi(page, {
		queries: [
			{
				name: "cases:getForEdit",
				args: { caseId: "case7" },
				data: caseDoc({ _id: "case7" }),
			},
		],
		mutations: {
			"cases:update": (args: Record<string, unknown>) => {
				updateArgs = args;
				return { caseId: "case7" };
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/case7/edit");

	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");
	await expect(page.getByLabel("Access code")).toHaveValue("sterling");

	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case updated successfully.")).toBeVisible();
	expect(updateArgs?.caseId).toBe("case7");
	expect(updateArgs?.name).toBe("Sterling Industries");
});

// Tests that exporting the blank form triggers a download.
test("exporting the blank form triggers a download", async ({ page }) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");
	await page.getByLabel("Case name").fill("My Great Case!");

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export template" }).click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toBe("export case.html");
});

// Tests that importing a filled-in export populates the form.
test("importing a filled-in export populates the form", async ({ page }) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	const html = buildHTMLForm({
		caseName: "Imported Case",
		accessCode: "imported",
		simulationDurationMinutes: 30,
		initialBrief: "An imported brief.",
		commonInformation: "Imported background.",
	});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "case-lab-e2e-"));
	const filePath = path.join(dir, "import.html");
	fs.writeFileSync(filePath, html);

	await page.locator('input[type="file"]').setInputFiles(filePath);

	await expect(page.getByLabel("Case name")).toHaveValue("Imported Case");
	await expect(page.getByLabel("Access code")).toHaveValue("imported");
	await expect(page.getByLabel("Simulation duration (Minutes)")).toHaveValue(
		"30",
	);
	await expect(page.getByLabel("Initial brief")).toHaveValue(
		"An imported brief.",
	);
});

// Tests that a server-rejected delete keeps the case in the list and explains why.
test("a server-rejected delete keeps the case in the list and explains why", async ({
	page,
}) => {
	const cases = [
		caseDoc({
			_id: "case1",
			name: "Sterling Industries",
			accessCode: "sterling",
		}),
	];
	await mockApi(page, {
		queries: [{ name: "cases:listAll", args: {}, data: cases }],
		mutations: {
			"cases:deleteCase": () => {
				throw new Error("This case has an active simulation in progress.");
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/edit");

	await page.getByRole("button", { name: "Delete case" }).first().click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();

	await expect(
		page.getByText("This case has an active simulation in progress."),
	).toBeVisible();
	await expect(page.getByRole("alertdialog")).toBeVisible();
});

// Tests that a server-rejected save keeps the admin's draft on screen.
test("a server-rejected save keeps the admin's draft on screen", async ({
	page,
}) => {
	await mockApi(page, {
		mutations: {
			"cases:create": () => {
				throw new Error(
					"An access code with this value already exists on another case.",
				);
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	await page.getByLabel("Case name").fill("Riverside Manufacturing");
	await page.getByLabel("Initial brief").fill("Cut logistics costs by 10%.");
	await page.getByLabel("Access code").fill("riverside");
	await page.getByRole("button", { name: "+ Add root persona" }).click();
	await page.getByLabel("Persona name").fill("Sam Rivera");
	await page.getByLabel("Title/Role").fill("Operations Lead");
	await page.getByRole("button", { name: "Submit" }).click();

	await expect(
		page.getByText(
			"An access code with this value already exists on another case.",
		),
	).toBeVisible();
	await expect(page.getByLabel("Case name")).toHaveValue(
		"Riverside Manufacturing",
	);
	await expect(page.getByLabel("Access code")).toHaveValue("riverside");
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
});
