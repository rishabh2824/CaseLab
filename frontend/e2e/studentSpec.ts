import { expect, test } from "@playwright/test";
import { contact, mockApi, runState, sse, turn } from "./mockApi.js";

test("student enters an access code and messages a persona", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"POST /api/simulations/:id/message": ({ body }) => ({
			sse: turn("Our current vendor is Acme Supplies.", {
				userMessage: (body as { message: string }).message,
			}),
		}),
	});

	await page.goto("/");

	// Enter the access code and open the case (landing page submits POST /start).
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();

	// Success navigates to the student view; brief + contact render from the cache.
	await expect(page).toHaveURL(/\/student$/);
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	await expect(page.getByText("Mary").first()).toBeVisible();

	// Send a message and assert the streamed persona reply appears.
	await page
		.getByPlaceholder("Type your message...")
		.fill("What vendor do we use?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(page.getByText("What vendor do we use?")).toBeVisible();
	await expect(
		page.getByText("Our current vendor is Acme Supplies."),
	).toBeVisible();
});

test("an invalid access code surfaces an inline error", async ({ page }) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({
			status: 404,
			json: { detail: "No case found." },
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("wrong-code");
	await page.getByRole("button", { name: "Open Case" }).click();

	// The landing page shows the error inline and stays put (no navigation).
	await expect(page.getByText("Invalid access code.")).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});

test("an empty access code shows the inline error without a request", async ({
	page,
}) => {
	// No handlers registered — if the app fires a request anyway, mockApi's
	// unmatched-route 599 makes that an obvious failure rather than a hang.
	await mockApi(page, {});
	let apiCalled = false;
	page.on("request", (request) => {
		if (request.url().includes("/api/")) apiCalled = true;
	});

	await page.goto("/");
	// handleSubmit's blank-code guard runs before any fetch, so submitting
	// with the field untouched must never reach the network.
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page.getByText("Invalid access code.")).toBeVisible();
	expect(apiCalled).toBe(false);
});

test("the access code is upper-cased before being sent", async ({ page }) => {
	let sentAccessCode: string | undefined;
	await mockApi(page, {
		"POST /api/simulations/start": ({ body }) => {
			sentAccessCode = (body as { access_code: string }).access_code;
			return { json: runState() };
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page).toHaveURL(/\/student$/);
	expect(sentAccessCode).toBe("STERLING");
});

test("a reload mid-run resumes from the persisted runId instead of starting a new run", async ({
	page,
}) => {
	let startCalls = 0;
	let getCalls = 0;
	await mockApi(page, {
		"POST /api/simulations/start": () => {
			startCalls++;
			return { json: runState() };
		},
		"GET /api/simulations/:id": () => {
			getCalls++;
			return { json: runState() };
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);
	expect(startCalls).toBe(1);
	expect(getCalls).toBe(0);

	// A fresh page load re-runs run.init(); with session.runId already
	// persisted to sessionStorage it must resume via GET, not POST /start again.
	await page.reload();
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	expect(startCalls).toBe(1);
	expect(getCalls).toBeGreaterThanOrEqual(1);
});

test("an expired run recovers by starting a fresh session from the stored access code", async ({
	page,
}) => {
	let startCalls = 0;
	await mockApi(page, {
		"POST /api/simulations/start": () => {
			startCalls++;
			return { json: runState() };
		},
		// The persisted run is gone server-side — always 404 on resume.
		"GET /api/simulations/:id": () => ({
			status: 404,
			json: { detail: "Run expired." },
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);
	expect(startCalls).toBe(1);

	// run.svelte.ts's #handleExpired() clears runId but keeps accessCode, so
	// the reload's refresh() 404 should trigger a brand-new startSession().
	await page.reload();
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	await expect(page).toHaveURL(/\/student$/);
	expect(startCalls).toBe(2);
});

test("typing over the word limit blocks Send without sending a message", async ({
	page,
}) => {
	let messageCalls = 0;
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"POST /api/simulations/:id/message": () => {
			messageCalls++;
			return { sse: turn("reply", { userMessage: "over limit" }) };
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	// MAX_MESSAGE_WORDS is 50 — 51 words trips the over-limit guard.
	const longMessage = new Array(51).fill("word").join(" ");
	await page.getByPlaceholder("Type your message...").fill(longMessage);

	await expect(page.getByText("51/50 words")).toBeVisible();
	await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
	expect(messageCalls).toBe(0);
});

test("a referral unlock adds the new contact and fires a toast", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"POST /api/simulations/:id/message": ({ body }) => ({
			sse: turn("I'll connect you with Bob.", {
				userMessage: (body as { message: string }).message,
				meta: {
					new_contacts: [
						contact({ id: "bob", name: "Bob", role: "Vendor Rep" }),
					],
				},
			}),
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

test("a shared file appears in the file list and fires a toast", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"POST /api/simulations/:id/message": ({ body }) => ({
			sse: turn("Here's the vendor contract.", {
				userMessage: (body as { message: string }).message,
				meta: {
					shared_files: [
						{
							file_id: "f1",
							file_name: "vendor-contract.pdf",
							content_type: "application/pdf",
							url: "https://example.com/f1",
						},
					],
				},
			}),
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

test("a chat-ended meta frame disables the composer for that persona", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"POST /api/simulations/:id/message": ({ body }) => ({
			sse: turn("I'm done talking to you.", {
				userMessage: (body as { message: string }).message,
				meta: { chat_ended: true, chat_end_reason: "harassment" },
			}),
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page.getByPlaceholder("Type your message...").fill("One more question");
	await page.getByRole("button", { name: "Send" }).click();

	// "Conversation ended" itself renders in two places (the sidebar contact
	// row and the header badge) — this message is unique to the chat panel.
	await expect(
		page.getByText("This persona has ended the conversation for this chat."),
	).toBeVisible();
	await expect(
		page.getByPlaceholder("This conversation has ended."),
	).toBeDisabled();
});

test("an unavailable contact cannot be selected or messaged", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({
			json: runState({
				contacts: [
					contact(),
					contact({
						id: "bob",
						name: "Bob",
						role: "Vendor Rep",
						available: false,
						available_in: 0,
					}),
				],
			}),
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const bobButton = page.locator("button", { hasText: "Bob" });
	await expect(bobButton).toBeDisabled();
	await expect(page.getByText("Unavailable")).toBeVisible();
	// Mary (active_persona_id in the fixture) stays selected — Bob was never
	// clickable, so the composer never switched personas.
	await expect(
		page.locator("p.font-display", { hasText: "Mary" }),
	).toBeVisible();
});

test("a mid-stream error frame keeps the user's message, drops the assistant reply, and shows a toast", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		// Only a partial delta, then an error frame — no `done`. The reducer
		// must discard the partial streamed text, not commit it as history.
		"POST /api/simulations/:id/message": () => ({
			sse: sse([
				{ event: "delta", data: { text: "Let me check on that..." } },
				{
					event: "error",
					data: { detail: "The reply could not be generated." },
				},
			]),
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Type your message...")
		.fill("What vendor do we use?");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(page.getByText("What vendor do we use?")).toBeVisible();
	await expect(
		page.getByText("The reply could not be generated."),
	).toBeVisible();
	await expect(page.getByText("Let me check on that...")).not.toBeVisible();
});

test("notes autosave issues a debounced PUT after typing", async ({ page }) => {
	const savedNotes: string[] = [];
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"PUT /api/simulations/:id/notes": ({ body }) => {
			savedNotes.push((body as { notes: string }).notes);
			return { json: { notes: (body as { notes: string }).notes } };
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page
		.getByPlaceholder("Write your notes here...")
		.fill("Vendor is Acme.");

	// The store debounces ~800ms before persisting — poll instead of a fixed sleep.
	await expect.poll(() => savedNotes.at(-1)).toBe("Vendor is Acme.");
});

test("exporting the PDF requests the export payload and triggers a download", async ({
	page,
}) => {
	await mockApi(page, {
		"POST /api/simulations/start": () => ({ json: runState() }),
		"GET /api/simulations/:id/export": () => ({
			json: {
				case: { id: 1, case_name: "Sterling Industries" },
				personas: [
					{
						id: "mary",
						name: "Mary",
						role: "Chief Financial Officer",
						messages: [],
					},
				],
			},
		}),
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PDF" }).click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toBe(
		"sterling-industries-chat-history.pdf",
	);
});
