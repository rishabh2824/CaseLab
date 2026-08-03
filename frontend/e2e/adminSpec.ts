import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildHTMLForm } from "../src/lib/case/exportCase.js";
import {
	ADMIN_ROLE,
	adminOut,
	caseDetail,
	caseSummary,
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

test("/admin/edit lists cases from GET /api/cases and deleting one removes it", async ({
	page,
}) => {
	let cases = [
		caseSummary({
			id: 1,
			case_name: "Sterling Industries",
			access_code: "STERLING",
		}),
		caseSummary({ id: 2, case_name: "Acme Corp", access_code: "ACME" }),
	];
	await mockApi(page, {
		"GET /api/cases": () => ({ json: { cases } }),
		"DELETE /api/cases/:id": ({ url }) => {
			const id = Number(url.pathname.split("/").pop());
			cases = cases.filter((c) => c.id !== id);
			return { json: { ok: true } };
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/edit");

	await expect(page.getByText("Sterling Industries")).toBeVisible();
	await expect(page.getByText("Acme Corp")).toBeVisible();

	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Delete case" }).first().click();

	await expect(page.getByText("Sterling Industries")).not.toBeVisible();
	await expect(page.getByText("Acme Corp")).toBeVisible();
});

// --- create ------------------------------------------------------------------

test("creating a case submits the expected payload", async ({ page }) => {
	let postBody: Record<string, unknown> | undefined;
	await mockApi(page, {
		"POST /api/cases": ({ body }) => {
			postBody = body as Record<string, unknown>;
			return { json: { case_id: 42 } };
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/scratch");

	await page.getByLabel("Case name").fill("Riverside Manufacturing");
	await page.getByLabel("Initial brief").fill("Cut logistics costs by 10%.");
	await page.getByLabel("Access code").fill("RIVERSIDE");

	// A blank form starts with zero personas — at least one root is required.
	await page.getByRole("button", { name: "+ Add root persona" }).click();
	await page.getByText("Persona 1").click(); // expand the newly-added persona's <details>
	await page.getByLabel("Persona name").fill("Sam Rivera");
	await page.getByLabel("Title/Role").fill("Operations Lead");

	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case saved successfully.")).toBeVisible();

	expect(postBody?.case_name).toBe("Riverside Manufacturing");
	expect(postBody?.access_code).toBe("RIVERSIDE");
	const personas = postBody?.personas as Array<{ id: string; name: string }>;
	expect(personas).toHaveLength(1);
	expect(personas[0]?.name).toBe("Sam Rivera");
	expect(postBody?.roots).toEqual([personas[0]?.id]);
});

test("submitting with required fields empty does not issue a request and reveals the field errors", async ({
	page,
}) => {
	// No POST /api/cases handler registered — a call would 599 and fail the test.
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/scratch");

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

test("editing a case populates the form and the save carries expected_version", async ({
	page,
}) => {
	let putBody: Record<string, unknown> | undefined;
	await mockApi(page, {
		"GET /api/cases/:id": () => ({
			json: { case: caseDetail({ id: 7, version: 3 }) },
		}),
		"PUT /api/cases/:id": ({ body }) => {
			putBody = body as Record<string, unknown>;
			return { json: { case_id: 7 } };
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/edit/form?caseId=7");

	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");
	await expect(page.getByLabel("Access code")).toHaveValue("STERLING");

	await page.getByRole("button", { name: "Submit" }).click();
	await expect(page.getByText("Case updated successfully.")).toBeVisible();
	expect(putBody?.expected_version).toBe(3);
});

test("a version conflict shows the modal; Reload discards edits and reloads the case", async ({
	page,
}) => {
	let getCalls = 0;
	await mockApi(page, {
		"GET /api/cases/:id": () => {
			getCalls++;
			// Second load (triggered by "Reload") reflects someone else's save.
			return {
				json: {
					case: caseDetail({
						id: 7,
						version: getCalls === 1 ? 3 : 4,
						case_name:
							getCalls === 1
								? "Sterling Industries"
								: "Sterling Industries (updated)",
					}),
				},
			};
		},
		"PUT /api/cases/:id": () => ({
			status: 409,
			json: { detail: { message: "Conflict.", code: "version_conflict" } },
		}),
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/edit/form?caseId=7");
	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");

	await page.getByLabel("Case name").fill("Sterling Industries Edited");
	await page.getByRole("button", { name: "Submit" }).click();

	await expect(
		page.getByText("This case was updated by someone else"),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Reload and lose my changes" })
		.click();

	// Reload discards the in-progress edit and shows the other admin's save.
	await expect(page.getByLabel("Case name")).toHaveValue(
		"Sterling Industries (updated)",
	);
});

test("a version conflict shows the modal; Keep editing adopts the new version without discarding edits", async ({
	page,
}) => {
	let versionCalls = 0;
	await mockApi(page, {
		"GET /api/cases/:id": () => ({
			json: { case: caseDetail({ id: 7, version: 3 }) },
		}),
		"GET /api/cases/:id/version": () => {
			versionCalls++;
			return { json: { version: 4 } };
		},
		"PUT /api/cases/:id": () => ({
			status: 409,
			json: { detail: { message: "Conflict.", code: "version_conflict" } },
		}),
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/edit/form?caseId=7");
	await expect(page.getByLabel("Case name")).toHaveValue("Sterling Industries");

	await page.getByLabel("Case name").fill("Sterling Industries Edited");
	await page.getByRole("button", { name: "Submit" }).click();

	await expect(
		page.getByText("This case was updated by someone else"),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Keep editing — I'll overwrite theirs" })
		.click();

	// "Keep editing" only adopts the version silently — the admin's in-progress
	// edit must survive (unlike Reload, nothing here refetches the case body).
	await expect(page.getByLabel("Case name")).toHaveValue(
		"Sterling Industries Edited",
	);
	expect(versionCalls).toBe(1);
});

// --- unsaved changes ----------------------------------------------------------

test("a dirty form triggers the unsaved-changes modal when navigating via the top bar", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/scratch");

	await page.getByLabel("Case name").fill("Draft Case");
	await page.getByRole("button", { name: "Go to admin home" }).click();

	await expect(page.getByText("You have unsaved changes")).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	// Cancel stays on the form — the unsaved edit is neither lost nor navigated away from.
	await expect(page).toHaveURL(/\/admin\/new\/scratch$/);
	await expect(page.getByLabel("Case name")).toHaveValue("Draft Case");
});

// --- export / import -----------------------------------------------------------

test("exporting the blank form triggers a download named from the case name", async ({
	page,
}) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/scratch");
	await page.getByLabel("Case name").fill("My Great Case!");

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export template" }).click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toBe("my-great-case.html");
});

test("importing a filled-in export populates the form", async ({ page }) => {
	await mockApi(page, {});
	await signInAsAdmin(page, { role: ADMIN_ROLE.ADMIN });
	await page.goto("/admin/new/scratch");

	// buildHTMLForm is the exact function CaseForm's own "Export template"
	// button calls — building a filled-in copy here and feeding it back in
	// exercises the same round trip an admin would perform by hand.
	const html = buildHTMLForm({
		caseName: "Imported Case",
		accessCode: "IMPORTED",
		simulationDurationMinutes: 30,
		initialBrief: "An imported brief.",
		commonInformation: "Imported background.",
	});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "case-lab-e2e-"));
	const filePath = path.join(dir, "import.html");
	fs.writeFileSync(filePath, html);

	await page.locator('input[type="file"]').setInputFiles(filePath);

	await expect(page.getByLabel("Case name")).toHaveValue("Imported Case");
	await expect(page.getByLabel("Access code")).toHaveValue("IMPORTED");
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
	await page.goto("/admin/new/scratch");

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
		adminOut({ id: 1, email: "existing@wisc.edu", role: ADMIN_ROLE.ADMIN }),
	];
	let addBody: Record<string, unknown> | undefined;
	await mockApi(page, {
		"GET /api/admin/admins": () => ({ json: admins }),
		"POST /api/admin/admins": ({ body }) => {
			addBody = body as Record<string, unknown>;
			admins = [
				...admins,
				adminOut({
					id: 2,
					email: addBody.email as string,
					name: addBody.name as string | null,
					role: addBody.role as number,
				}),
			];
			return { json: admins[admins.length - 1] };
		},
		"DELETE /api/admin/admins/:id": ({ url }) => {
			const id = Number(url.pathname.split("/").pop());
			admins = admins.filter((a) => a.id !== id);
			return { json: { ok: true, cases_deleted: 1, cases_reassigned: 2 } };
		},
	});
	await signInAsAdmin(page, { role: ADMIN_ROLE.SUPER });
	await page.goto("/admin/admins");

	await expect(page.getByText("existing@wisc.edu")).toBeVisible();

	await page.getByLabel("Email").fill("new@wisc.edu");
	await page.getByLabel("Name (optional)").fill("New Admin");
	await page.getByRole("button", { name: "Add admin" }).click();

	await expect(page.getByText("new@wisc.edu")).toBeVisible();
	expect(addBody?.email).toBe("new@wisc.edu");

	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Delete" }).first().click();

	await expect(
		page.getByText(
			"Deleted existing@wisc.edu — 1 case deleted, 2 cases reassigned.",
		),
	).toBeVisible();
	await expect(page.getByText("existing@wisc.edu")).not.toBeVisible();
});
