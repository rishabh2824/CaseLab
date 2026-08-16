import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildHTMLForm } from "../src/lib/case/exportCase.js";
import {
	ADMIN_ROLE,
	adminDoc,
	caseDoc,
	mockApi,
	signInAsAdmin,
} from "./mockApi.js";

// --- route guards -----------------------------------------------------------

test("an unauthenticated visit to /admin redirects to the landing page", async ({
	page,
}) => {
	await mockApi(page, {});
	await page.goto("/admin");
	await expect(page).toHaveURL(/\/$/);
});

test("a signed-in ADMIN reaches /admin without the manage-admins control", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin");
	await expect(
		page.getByRole("heading", { name: "Choose what you want to work on" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Manage admins" })).toHaveCount(
		0,
	);
});

test("a signed-in SUPER admin sees the manage-admins control", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.SUPER });
	await page.goto("/admin");
	await expect(
		page.getByRole("button", { name: "Manage admins" }),
	).toBeVisible();
});

test("an unauthenticated visit to /admin/admins redirects to the landing page", async ({
	page,
}) => {
	await mockApi(page, {});
	await page.goto("/admin/admins");
	await expect(page).toHaveURL(/\/$/);
});

test("a non-super admin visiting /admin/admins redirects to /admin", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/admins");
	await expect(page).toHaveURL(/\/admin$/);
});

// --- case list / delete ------------------------------------------------------

test("/admin/edit lists cases from api/cases:listAll and deleting one removes it", async ({
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
		queries: [{ name: "api/cases:listAll", args: {}, data: cases }],
		mutations: {
			"api/cases:deleteCase": async (
				args: { caseId: string },
				{ setQuery },
			) => {
				cases = cases.filter((c) => c._id !== args.caseId);
				await setQuery("api/cases:listAll", {}, { data: cases });
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

	// Wait for the dialog itself to close first — its own title also says
	// "Sterling Industries", so checking the list text while it's still
	// mid-close-transition races against that.
	await expect(page.getByRole("alertdialog")).not.toBeVisible();
	await expect(page.getByText("Sterling Industries")).not.toBeVisible();
	await expect(page.getByText("Acme Corp")).toBeVisible();
});

// --- create ------------------------------------------------------------------

test("creating a case submits the expected payload", async ({ page }) => {
	let createArgs: Record<string, unknown> | undefined;
	await mockApi(page, {
		mutations: {
			"api/cases:create": (args: Record<string, unknown>) => {
				createArgs = args;
				return { caseId: "new-case-id" };
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	await page.getByLabel("Case name").fill("Riverside Manufacturing");
	await page.getByLabel("Initial brief").fill("Cut logistics costs by 10%.");
	// Convex's access-code format is lowercase-only now (services/cases.ts's
	// ACCESS_CODE_FORMAT) -- CaseForm rejects an uppercase code client-side, unlike the old
	// REST-era backend this suite used to test against.
	await page.getByLabel("Access code").fill("riverside");

	// A blank form starts with zero personas — at least one root is required.
	await page.getByRole("button", { name: "+ Add root persona" }).click();
	await page.getByText("Persona 1").click(); // expand the newly-added persona's <details>
	await page.getByLabel("Persona name").fill("Sam Rivera");
	await page.getByLabel("Title/Role").fill("Operations Lead");

	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case saved successfully.")).toBeVisible();

	expect(createArgs?.name).toBe("Riverside Manufacturing");
	expect(createArgs?.accessCode).toBe("riverside");
	const personas = createArgs?.personas as Array<{ id: string; name: string }>;
	expect(personas).toHaveLength(1);
	expect(personas[0]?.name).toBe("Sam Rivera");
	expect(createArgs?.roots).toEqual([personas[0]?.id]);
});

test("submitting with required fields empty does not issue a request and reveals the field errors", async ({
	page,
}) => {
	// No api/cases:create handler registered — a call would reject with "no mock
	// registered" and fail the test.
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	// The Submit button is disabled from load (hasValidationErrors is true on
	// a blank form), so it can never actually be clicked into submitting.
	// Typing then clearing a field is what flips showFieldErrors, the same
	// gate a real admin would trip by touching any required field.
	const nameInput = page.getByLabel("Case name");
	await nameInput.fill("x");
	await nameInput.fill("");

	await expect(page.getByText("Case name is required.")).toBeVisible();
	await expect(page.getByText("Initial brief is required.")).toBeVisible();
	await expect(page.getByText("Access code is required.")).toBeVisible();
	await expect(page.getByText("At least 1 persona is required")).toBeVisible();
	await expect(page.getByRole("button", { name: "Submit" })).toBeDisabled();
});

// --- edit ----------------------------------------------------------------

test("editing a case populates the form and the save updates the existing case", async ({
	page,
}) => {
	let updateArgs: Record<string, unknown> | undefined;
	await mockApi(page, {
		queries: [
			{
				name: "api/cases:getForEdit",
				args: { caseId: "case7" },
				data: caseDoc({ _id: "case7" }),
			},
		],
		mutations: {
			"api/cases:update": (args: Record<string, unknown>) => {
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
	// Convex's updateCase has no expected_version/optimistic-concurrency check (last-write-
	// wins, see services/cases.ts's comment) -- unlike the old REST backend, there's no
	// conflict-detection field to assert on here, just the caseId and edited fields.
	expect(updateArgs?.caseId).toBe("case7");
	expect(updateArgs?.name).toBe("Sterling Industries");
});

// --- unsaved changes ----------------------------------------------------------

test("a dirty form triggers the unsaved-changes modal when navigating via the top bar", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	await page.getByLabel("Case name").fill("Draft Case");
	await page.getByRole("button", { name: "Go to admin home" }).click();

	await expect(page.getByText("You have unsaved changes")).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	// Cancel stays on the form — the unsaved edit is neither lost nor navigated away from.
	await expect(page).toHaveURL(/\/admin\/cases\/new$/);
	await expect(page.getByLabel("Case name")).toHaveValue("Draft Case");
});

// --- export / import -----------------------------------------------------------

test("exporting the blank form triggers a download", async ({ page }) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");
	await page.getByLabel("Case name").fill("My Great Case!");

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export template" }).click();
	const download = await downloadPromise;

	// downloadForm (exportCase.ts) always downloads under this fixed name -- it doesn't
	// slugify the case name into the filename (unlike the old REST-era frontend this suite
	// used to assert against).
	expect(download.suggestedFilename()).toBe("export case.html");
});

test("importing a filled-in export populates the form", async ({ page }) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	// buildHTMLForm is the exact function CaseForm's own "Export template"
	// button calls — building a filled-in copy here and feeding it back in
	// exercises the same round trip an admin would perform by hand.
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

test("importing an unrelated HTML file surfaces the import error", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/cases/new");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "case-lab-e2e-"));
	const filePath = path.join(dir, "unrelated.html");
	fs.writeFileSync(
		filePath,
		"<html><body><h1>Not a case export</h1></body></html>",
	);

	await page.locator('input[type="file"]').setInputFiles(filePath);

	await expect(
		page.getByText("This doesn't look like a Case Lab import file."),
	).toBeVisible();
});

// --- admins management ---------------------------------------------------------

test("the admins page lists admins, adds one, and deletes one with a summary", async ({
	page,
}) => {
	let admins = [
		adminDoc({
			_id: "admin-existing",
			email: "existing@wisc.edu",
			role: "admin",
		}),
	];
	let createArgs: Record<string, unknown> | undefined;
	await mockApi(page, {
		queries: [{ name: "api/admins:listAll", args: {}, data: admins }],
		mutations: {
			"api/admins:create": async (
				args: { email: string; name?: string; role: "super" | "admin" },
				{ setQuery },
			) => {
				createArgs = args;
				const created = adminDoc({
					_id: "admin-new",
					email: args.email,
					name: args.name,
					role: args.role,
				});
				admins = [...admins, created].sort((a, b) =>
					(a.email as string).localeCompare(b.email as string),
				);
				await setQuery("api/admins:listAll", {}, { data: admins });
				return created;
			},
			"api/admins:deleteWithCascade": async (
				args: { adminId: string },
				{ setQuery },
			) => {
				admins = admins.filter((a) => a._id !== args.adminId);
				await setQuery("api/admins:listAll", {}, { data: admins });
				return { ok: true, casesDeleted: 1, casesReassigned: 2 };
			},
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.SUPER });
	await page.goto("/admin/admins");

	await expect(page.getByText("existing@wisc.edu")).toBeVisible();

	await page.getByLabel("Email").fill("new@wisc.edu");
	await page.getByLabel("Name (optional)").fill("New Admin");
	await page.getByRole("button", { name: "Add admin" }).click();

	// Scoped to the table cell, not just text: the "Added new@wisc.edu." toast
	// (also new@wisc.edu-containing) is a separate, incidental match.
	await expect(page.getByRole("cell", { name: "new@wisc.edu" })).toBeVisible();
	expect(createArgs?.email).toBe("new@wisc.edu");

	// existing@wisc.edu sorts before new@wisc.edu (listAdmins orders by email), and is a
	// plain "admin" (deletable) — the SUPER admin's own row never renders a Delete button.
	await page.getByRole("button", { name: "Delete" }).first().click();
	await expect(page.getByText("Delete existing@wisc.edu?")).toBeVisible();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();

	await expect(
		page.getByText(
			"Deleted existing@wisc.edu — 1 case deleted, 2 cases reassigned.",
		),
	).toBeVisible();
	await expect(page.getByText("existing@wisc.edu")).not.toBeVisible();
});

// --- hostile / degenerate admin interactions ---------------------------------

test("double-clicking Submit creates the case once, not twice", async ({
	page,
}) => {
	// Two cases from one impatient double-click would be a duplicate access code on the
	// second attempt server-side -- but the admin would see only an opaque conflict error
	// after a case had already been created.
	let createCalls = 0;
	await mockApi(page, {
		mutations: {
			"api/cases:create": async () => {
				createCalls++;
				// Slow enough that a second click lands while the first is still in flight.
				await new Promise((resolve) => setTimeout(resolve, 300));
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
	await page.getByText("Persona 1").click();
	await page.getByLabel("Persona name").fill("Sam Rivera");
	await page.getByLabel("Title/Role").fill("Operations Lead");

	const submit = page.getByRole("button", { name: "Submit" });
	await submit.click();
	await submit.click({ force: true }).catch(() => {});
	await submit.click({ force: true }).catch(() => {});

	await expect(page.getByText("Case saved successfully.")).toBeVisible();
	expect(createCalls).toBe(1);
});

test("a server-rejected delete keeps the case in the list and explains why", async ({
	page,
}) => {
	// deleteCase refuses while the case has a live simulation (lib/guardNoLiveRuns.ts). The
	// admin has to see that reason -- a silently-failed delete that leaves the row on screen is
	// indistinguishable from a UI bug.
	const cases = [
		caseDoc({
			_id: "case1",
			name: "Sterling Industries",
			accessCode: "sterling",
		}),
	];
	await mockApi(page, {
		queries: [{ name: "api/cases:listAll", args: {}, data: cases }],
		mutations: {
			"api/cases:deleteCase": () => {
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

test("a server-rejected save keeps the admin's draft on screen", async ({
	page,
}) => {
	// A rejected save (duplicate access code, invalid duration, live run) must not discard the
	// form the admin just spent time filling in -- losing it would make a recoverable
	// validation error into lost work.
	await mockApi(page, {
		mutations: {
			"api/cases:create": () => {
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
	await page.getByText("Persona 1").click();
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
