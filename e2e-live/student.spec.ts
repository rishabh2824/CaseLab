import { expect, test } from "./fixtures.js";

test("a student opens a case by its code, chats with a persona and exports the transcript", async ({
	page,
	seedCase,
}) => {
	const { accessCode } = await seedCase();

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill(accessCode);
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();

	await page
		.getByPlaceholder("Type your message...")
		.fill("What vendor do we use?");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.getByText("Our vendor is Acme Supplies.")).toBeVisible();

	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PDF" }).click();
	expect((await download).suggestedFilename()).toBe("chats.pdf");
});

test("an unknown access code is refused with the server's message", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("nosuchcodehere");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page.getByText("Invalid access code.")).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});

test("a persona who refers the student unlocks a new contact", async ({
	page,
	seedCase,
}) => {
	const { accessCode } = await seedCase({
		extraPersonas: [{ id: "B", name: "Bob", role: "COO" }],
		referrals: [
			{ fromId: "A", toId: "B", conditions: "the student asks for the COO" },
		],
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill(accessCode);
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Type your message...")
		.fill("Can you connect me with the COO?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(page.getByText("Let me connect you with Bob.")).toBeVisible();
	await expect(page.getByText("New contact unlocked: Bob (COO)")).toBeVisible();
	await expect(page.locator("button", { hasText: "Bob" })).toBeVisible();
});

test("a reloaded page resumes the same run", async ({ page, seedCase }) => {
	const { accessCode } = await seedCase();

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill(accessCode);
	await page.getByRole("button", { name: "Open Case" }).click();
	await page
		.getByPlaceholder("Type your message...")
		.fill("What vendor do we use?");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.getByText("Our vendor is Acme Supplies.")).toBeVisible();

	await page.reload();

	await expect(page.getByText("What vendor do we use?")).toBeVisible();
	await expect(page.getByText("Our vendor is Acme Supplies.")).toBeVisible();
});
