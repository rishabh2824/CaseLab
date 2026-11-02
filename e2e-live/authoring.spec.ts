import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Id } from "../convex/_generated/dataModel.js";
import { api, expect, test } from "./fixtures.js";

test("an exported case form can be imported back into a new case", async ({
	page,
	signInAs,
}) => {
	await signInAs(page, "admin");
	await page.goto("/admin/cases/new/blank");
	await page.getByLabel("Case name").fill("Round Trip Case");
	await page.getByLabel("Student brief").fill("Survive the round trip.");

	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export template" }).click();
	const exported = await download;
	expect(exported.suggestedFilename()).toBe("export case.html");
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "case-lab-live-")),
		"export.html",
	);
	await exported.saveAs(file);

	await page.goto("/admin/cases/new/blank");
	await page.locator('input[type="file"].hidden').setInputFiles(file);

	await expect(page.getByLabel("Case name")).toHaveValue("Round Trip Case");
	await expect(page.getByLabel("Student brief")).toHaveValue(
		"Survive the round trip.",
	);
});

test("a case with a dead end can't be saved, and its problem leads to the field", async ({
	page,
	signInAs,
	seedCase,
	apiAs,
}) => {
	const { caseId } = await seedCase({
		role: "admin",
		extraPersonas: [{ id: "B", name: "Priya", role: "Procurement" }],
		referrals: [
			{ fromId: "A", toId: "B", conditions: "asks about the tender" },
		],
	});
	await signInAs(page, "admin");
	await page.goto(`/admin/cases/${caseId}`);

	await page.locator(".svelte-flow__node").filter({ hasText: "Priya" }).click();
	const condition = page.getByLabel(
		"When should Mary refer the student to this persona?",
	);
	await condition.fill("");
	await page.locator(".svelte-flow__node").filter({ hasText: "Mary" }).click();
	await page.getByRole("button", { name: "Save case" }).click();

	await page
		.getByRole("button", { name: /students can't reach Priya/ })
		.click();
	await expect(condition).toBeFocused();

	const admin = await apiAs("admin");
	const saved = await admin.query(api.cases.getForEdit, {
		caseId: caseId as Id<"cases">,
	});
	expect(saved.structure.referrals[0]?.conditions).toBe(
		"asks about the tender",
	);
});

test("an arrow can be dropped anywhere on a referred persona's box", async ({
	page,
	signInAs,
	seedCase,
}) => {
	const { caseId } = await seedCase({
		role: "admin",
		extraPersonas: [
			{ id: "B", name: "Priya", role: "Procurement" },
			{ id: "C", name: "Dana", role: "Legal" },
		],
		referrals: [
			{ fromId: "A", toId: "B", conditions: "asks about the tender" },
			{ fromId: "A", toId: "C", conditions: "asks about the contract" },
		],
	});
	await signInAs(page, "admin");
	await page.goto(`/admin/cases/${caseId}`);

	const box = (persona: string) =>
		page.locator(".svelte-flow__node").filter({ hasText: persona });
	// Drags from a persona's dot to a spot three quarters of the way across another persona's box, well away from its dot.
	const dragArrow = async (from: string, to: string) => {
		const start = await box(from)
			.locator(".svelte-flow__handle.source")
			.boundingBox();
		const end = await box(to).boundingBox();
		if (!start || !end) throw new Error("expected both personas on screen");
		await page.mouse.move(
			start.x + start.width / 2,
			start.y + start.height / 2,
		);
		await page.mouse.down();
		await page.mouse.move(end.x + end.width * 0.75, end.y + end.height / 2, {
			steps: 15,
		});
		await page.mouse.up();
	};
	const arrows = page.locator(".svelte-flow__edge");
	await expect(arrows).toHaveCount(2);
	// Centred, so the sticky save bar doesn't cover the diagram.
	await page
		.locator(".svelte-flow")
		.evaluate((diagram) => diagram.scrollIntoView({ block: "center" }));

	await dragArrow("Priya", "Dana");
	await expect(arrows).toHaveCount(3);

	// A starting persona still can't be referred.
	await dragArrow("Dana", "Mary");
	await expect(arrows).toHaveCount(3);

	// Clicking a box still opens the persona once the drag is over.
	await box("Priya").click();
	await expect(page.getByLabel("Persona name")).toHaveValue("Priya");
});

test("choosing an existing case as a template seeds a new case without its access code", async ({
	page,
	signInAs,
	seedCase,
}) => {
	const { name } = await seedCase({ role: "admin" });
	await signInAs(page, "admin");
	await page.goto("/admin/cases/new/template");

	await page.getByRole("link", { name: new RegExp(name) }).click();

	await expect(page).toHaveURL(/\/admin\/cases\/new\/template\/.+/);
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
	await page.goto("/admin/cases");

	const row = page
		.locator("div")
		.filter({ has: page.getByText(`Access code: ${accessCode}`) })
		.filter({ has: page.getByRole("switch") })
		.last();
	const toggle = row.getByRole("switch", { name: "Offer as a template" });
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
});
