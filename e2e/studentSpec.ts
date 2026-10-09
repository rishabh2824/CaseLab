import { expect, test } from "@playwright/test";
import { STUDENT_ERROR } from "../convex/lib/studentErrors.js";
import { makeSharedFile } from "../tests/support/fixtures.js";
import {
	contact,
	mockApi,
	runState,
	studentError,
	turnHandler,
} from "./mockApi.js";

// Tests that a student can enter an access code and message a persona.
test("student enters an access code and messages a persona", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: turnHandler({
			reply: "Our current vendor is Acme Supplies.",
		}),
	});

	await page.goto("/");

	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page).toHaveURL(/\/student$/);
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	await expect(page.getByText("Mary").first()).toBeVisible();

	await page
		.getByPlaceholder("Type your message...")
		.fill("What vendor do we use?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(page.getByText("What vendor do we use?")).toBeVisible();
	await expect(
		page.getByText("Our current vendor is Acme Supplies."),
	).toBeVisible();
});

// Tests that an invalid access code shows an inline error.
test("an invalid access code surfaces an inline error", async ({ page }) => {
	await mockApi(page, {
		mutations: {
			"api/simulations:start": () => {
				throw studentError(
					STUDENT_ERROR.INVALID_ACCESS_CODE,
					"Invalid access code.",
				);
			},
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("wrong-code");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page.getByText("Invalid access code.")).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});

// Tests that an empty access code shows the inline error without sending a request.
test("an empty access code shows the inline error without a request", async ({
	page,
}) => {
	let mutationCalled = false;
	await mockApi(page, {
		mutations: {
			"api/simulations:start": () => {
				mutationCalled = true;
				return runState();
			},
		},
	});

	await page.goto("/");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page.getByText("Invalid access code.")).toBeVisible();
	expect(mutationCalled).toBe(false);
});

// Tests that the access code is lower-cased before being sent.
test("the access code is lower-cased before being sent", async ({ page }) => {
	let sentAccessCode: string | undefined;
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": (args: { accessCode: string }) => {
				sentAccessCode = args.accessCode;
				return runState();
			},
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("STERLING");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page).toHaveURL(/\/student$/);
	expect(sentAccessCode).toBe("sterling");
});

// Tests that a reload mid-run resumes the persisted run instead of starting a new one.
test("a reload mid-run resumes from the persisted runId instead of starting a new run", async ({
	page,
}) => {
	let startCalls = 0;
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => {
				startCalls++;
				return runState();
			},
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);
	expect(startCalls).toBe(1);

	await page.reload();
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	expect(startCalls).toBe(1);
});

// Tests that an expired run sends the student home instead of starting a new run.
test("an expired run sends the student home instead of starting a new run", async ({
	page,
}) => {
	let startCalls = 0;
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				error: {
					code: STUDENT_ERROR.RUN_EXPIRED,
					message: "Run expired.",
				},
			},
		],
		mutations: {
			"api/simulations:start": () => {
				startCalls++;
				return runState({ runId: "testrun123" });
			},
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByPlaceholder("Enter access code")).toBeVisible();
	expect(startCalls).toBe(1);
});

// Tests that typing over the word limit blocks Send without sending a message.
test("typing over the word limit blocks Send without sending a message", async ({
	page,
}) => {
	let turnCalled = false;
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: () => {
			turnCalled = true;
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const longMessage = new Array(51).fill("word").join(" ");
	await page.getByPlaceholder("Type your message...").fill(longMessage);

	await expect(page.getByText("51/50 words")).toBeVisible();
	await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
	expect(turnCalled).toBe(false);
});

// Tests that a referral unlock adds the new contact and shows a toast.
test("a referral unlock adds the new contact and fires a toast", async ({
	page,
}) => {
	const bob = contact({ id: "bob", name: "Bob", role: "Vendor Rep" });
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: turnHandler({
			reply: "I'll connect you with Bob.",
			nextRunState: runState({ contacts: [contact(), bob] }),
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Type your message...")
		.fill("Can you refer me to someone?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(
		page.getByText("New contact unlocked: Bob (Vendor Rep)"),
	).toBeVisible();
	await expect(page.locator("button", { hasText: "Bob" })).toBeVisible();
});

// Tests that a shared file appears in the file list and shows a toast.
test("a shared file appears in the file list and fires a toast", async ({
	page,
}) => {
	const file = makeSharedFile({
		fileId: "f1",
		fileName: "vendor-contract.pdf",
		url: "https://example.com/f1",
	});
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: turnHandler({
			reply: "Here's the vendor contract.",
			nextRunState: runState({ sharedFiles: [file] }),
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Type your message...")
		.fill("Can you share the contract?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(
		page.getByText("File shared: vendor-contract.pdf"),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "vendor-contract.pdf" }),
	).toBeVisible();
});

// Tests that a chat-ended meta frame disables the composer for that persona.
test("a chat-ended meta frame disables the composer for that persona", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: turnHandler({
			reply: "I'm done talking to you.",
			nextRunState: runState({
				contacts: [contact({ chatEnded: true, chatEndReason: "harassment" })],
			}),
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page.getByPlaceholder("Type your message...").fill("One more question");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(
		page.getByText("This persona has ended the conversation for this chat."),
	).toBeVisible();
	await expect(
		page.getByPlaceholder("This conversation has ended."),
	).toBeDisabled();
});

// Tests that an unavailable contact cannot be selected or messaged.
test("an unavailable contact cannot be selected or messaged", async ({
	page,
}) => {
	const state = runState({
		contacts: [
			contact(),
			contact({
				id: "bob",
				name: "Bob",
				role: "Vendor Rep",
				availableAt: 9999,
			}),
		],
	});
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: state,
			},
		],
		mutations: { "api/simulations:start": () => state },
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const bobButton = page.locator("button", { hasText: "Bob" });
	await expect(bobButton).toBeDisabled();
	await expect(page.getByText("Available in 9999 min")).toBeVisible();
	await expect(
		page.locator("p.font-display", { hasText: "Mary" }),
	).toBeVisible();
});

// Tests that a failed reply drops the student's message and shows a toast.
test("a failed reply drops the student's message and shows a toast", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: turnHandler({ reply: null }),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Type your message...")
		.fill("What vendor do we use?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(
		page.getByText(
			"Something went wrong generating a reply. Please resend your message.",
		),
	).toBeVisible();
	await expect(page.getByText("What vendor do we use?")).not.toBeVisible();
});

// Tests that notes autosave to sessionStorage after a debounce and never to the backend.
test("notes autosave writes to sessionStorage after a debounce, never to the backend", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: { "api/simulations:start": () => runState() },
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Write your notes here...")
		.fill("Vendor is Acme.");

	await expect
		.poll(() =>
			page.evaluate(() => sessionStorage.getItem("caselab:notes:testrun123")),
		)
		.toBe("Vendor is Acme.");
});

// Tests that exporting the PDF requests the export payload and triggers a download.
test("exporting the PDF requests the export payload and triggers a download", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
			{
				name: "api/simulations:exportRun",
				args: { runId: "testrun123" },
				data: {
					case: { id: "case1", caseName: "Sterling Industries" },
					personas: [
						{
							id: "mary",
							name: "Mary",
							role: "Chief Financial Officer",
							messages: [],
						},
					],
				},
			},
		],
		mutations: { "api/simulations:start": () => runState() },
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PDF" }).click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toBe("chats.pdf");
});

// Tests that a non-expiry backend error shows an inline alert instead of a frozen screen.
test("a non-expiry backend error surfaces an inline alert instead of a silently frozen screen", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				error: {
					code: STUDENT_ERROR.CASE_NOT_FOUND,
					message: "Case not found.",
				},
			},
		],
		mutations: { "api/simulations:start": () => runState() },
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await expect(page.getByRole("alert")).toHaveText("Case not found.");
});

// Tests that a rejected turn re-enables the composer so the student can retry.
test("a rejected turn re-enables the composer so the student can retry", async ({
	page,
}) => {
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
		},
		turn: () => {
			throw studentError(
				STUDENT_ERROR.REPLY_IN_PROGRESS,
				"Please wait for the current reply.",
			);
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const composer = page.getByPlaceholder("Type your message...");
	await composer.fill("first attempt");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(
		page.getByText("Please wait for the current reply."),
	).toBeVisible();
	await composer.fill("second attempt");
	await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});
