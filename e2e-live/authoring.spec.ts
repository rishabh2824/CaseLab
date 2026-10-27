import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";

test("an exported case form can be imported back into a new case", async ({
	page,
	signInAs,
}) => {
	await signInAs(page, "admin");
	await page.goto("/admin/cases/new");
	await page.getByLabel("Case name").fill("Round Trip Case");
	await page.getByLabel("Initial brief").fill("Survive the round trip.");

	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export template" }).click();
	const exported = await download;
	expect(exported.suggestedFilename()).toBe("export case.html");
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "case-lab-live-")),
		"export.html",
	);
	await exported.saveAs(file);

	await page.goto("/admin/cases/new");
	await page.locator('input[type="file"]').setInputFiles(file);

	await expect(page.getByLabel("Case name")).toHaveValue("Round Trip Case");
	await expect(page.getByLabel("Initial brief")).toHaveValue(
		"Survive the round trip.",
	);
});

test("choosing an existing case as a template seeds a new case without its access code", async ({
	page,
	signInAs,
	seedCase,
}) => {
	const { name } = await seedCase({ role: "admin" });
	await signInAs(page, "admin");
	await page.goto("/admin/new/template");

	await page.getByRole("link", { name: new RegExp(name) }).click();

	await expect(page).toHaveURL(/\/admin\/cases\/new\?template=/);
	await expect(page.getByLabel("Case name")).toHaveValue(name);
	await expect(page.getByLabel("Access code")).toHaveValue("");
});

test("a super admin marks a case as a template", async ({
	page,
	signInAs,
	seedCase,
}) => {
	const { accessCode } = await seedCase({ role: "super" });
	await signInAs(page, "super");
	await page.goto("/admin/edit");

	const row = page
		.locator("div")
		.filter({ has: page.getByText(`Access code: ${accessCode}`) })
		.filter({ has: page.getByRole("switch") })
		.last();
	const toggle = row.getByRole("switch", { name: "Offer as a template" });
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
});
