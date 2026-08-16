import { expect, test } from "@playwright/test";
import { makeSharedFile } from "../tests/support/fixtures.js";
import { contact, mockApi, runState, turnHandler } from "./mockApi.js";

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
			"api/turn:start": turnHandler({
				reply: "Our current vendor is Acme Supplies.",
			}),
		},
	});

	await page.goto("/");

	// Enter the access code and open the case (landing page calls the api/simulations:start
	// mutation).
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();

	// Success navigates to the student view; brief + contact render from the live
	// api/simulations:get subscription.
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
		mutations: {
			"api/simulations:start": () => {
				throw new Error("Invalid access code.");
			},
		},
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
	// handleSubmit's blank-code guard runs before any mutation call, so submitting with
	// the field untouched must never reach the (mocked) backend.
	await page.getByRole("button", { name: "Open Case" }).click();

	await expect(page.getByText("Invalid access code.")).toBeVisible();
	expect(mutationCalled).toBe(false);
});

test("the access code is lower-cased before being sent", async ({ page }) => {
	// Convex's createCase/updateCase (and startSimulation's own lookup) only ever store
	// lowercase access codes -- the landing page normalizes to match (+page.svelte's
	// handleSubmit), unlike the old REST-era frontend this suite used to assert
	// upper-cased it.
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

	// A fresh page load re-runs run.init(); session.runId is still persisted to
	// sessionStorage (session.svelte.ts) even though all in-memory JS state resets, and
	// mockApi's query seed re-applies on every navigation (page.addInitScript) — so this
	// must resume from the existing live subscription, not start a brand-new run.
	await page.reload();
	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	expect(startCalls).toBe(1);
});

test("an expired run is detected and recovers by starting a fresh session from the stored access code", async ({
	page,
}) => {
	// Unlike the old REST flow (whose POST /start response was stashed and used directly
	// for the first render, only ever calling GET on a later reload), run.svelte.ts's
	// #runStateQuery is a live subscription from the very first render — so an "expired"
	// run is detected (and recovered from) as soon as its query resolves, not specifically
	// on a reload. testrun123 (the first mutation's run) is seeded to always report
	// expired; #handleExpired then retries startSession from the stored access code,
	// landing on a second, healthy run.
	let startCalls = 0;
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				error: "Run expired.",
			},
			{
				name: "api/simulations:get",
				args: { runId: "freshrun456" },
				data: runState({ run_id: "freshrun456" }),
			},
		],
		mutations: {
			"api/simulations:start": () => {
				startCalls++;
				return runState({
					run_id: startCalls === 1 ? "testrun123" : "freshrun456",
				});
			},
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await expect(page.getByText("Reduce office supply costs.")).toBeVisible();
	expect(startCalls).toBe(2);
});

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
			"api/turn:start": () => {
				turnCalled = true;
			},
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
	expect(turnCalled).toBe(false);
});

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
			"api/turn:start": turnHandler({
				reply: "I'll connect you with Bob.",
				nextRunState: runState({ contacts: [contact(), bob] }),
			}),
		},
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
	const file = makeSharedFile({
		file_id: "f1",
		file_name: "vendor-contract.pdf",
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
			"api/turn:start": turnHandler({
				reply: "Here's the vendor contract.",
				nextRunState: runState({ shared_files: [file] }),
			}),
		},
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
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				data: runState(),
			},
		],
		mutations: {
			"api/simulations:start": () => runState(),
			"api/turn:start": turnHandler({
				reply: "I'm done talking to you.",
				nextRunState: runState({
					contacts: [
						contact({ chat_ended: true, chat_end_reason: "harassment" }),
					],
				}),
			}),
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	await page.getByPlaceholder("Type your message...").fill("One more question");
	await page.getByRole("button", { name: "Send" }).click();

	// "Conversation ended" itself renders in two places (the sidebar contact row and the
	// header badge) — this message is unique to the chat panel.
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
	// available_at (not a since-removed `available`/`available_in` flag -- see
	// fixtures.ts's makeContact comment) far in the future keeps Bob unavailable for the
	// test's real-time duration. personaAvailability (availability.ts) reports this as
	// "available in N min", not "Unavailable" -- that string is reserved for a persona
	// whose availability window already EXPIRED (elapsed past available_at + duration),
	// which real wall-clock minutes make impractical to reach in a fast-running test.
	const state = runState({
		contacts: [
			contact(),
			contact({
				id: "bob",
				name: "Bob",
				role: "Vendor Rep",
				available_at: 9999,
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
	// Mary (active_persona_id in the fixture) stays selected — Bob was never clickable, so
	// the composer never switched personas.
	await expect(
		page.locator("p.font-display", { hasText: "Mary" }),
	).toBeVisible();
});

test("a mid-stream error frame keeps the user's message, drops the assistant reply, and shows a toast", async ({
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
			// reply: null — a partial preview streams, then the row is marked "error" with
			// no reply ever persisted. The reducer must discard any partial streamed text,
			// not commit it as history.
			"api/turn:start": turnHandler({
				reply: null,
				partialText: "Let me check on that...",
			}),
		},
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
		page.getByText(
			"Something went wrong generating a reply. Please resend your message.",
		),
	).toBeVisible();
	await expect(page.getByText("Let me check on that...")).not.toBeVisible();
});

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

	// The store debounces ~800ms before persisting — poll instead of a fixed sleep. Notes
	// are client-side only (sessionStorage, keyed by run id) — see run.svelte.ts's comment
	// on NOTES_STORAGE_PREFIX — so there's no Convex mutation to mock for this at all; one
	// firing would 599 through mockApi's "no mock registered" rejection and fail the test.
	await expect
		.poll(() =>
			page.evaluate(() => sessionStorage.getItem("caselab:notes:testrun123")),
		)
		.toBe("Vendor is Acme.");
});

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
					case: { id: "case1", case_name: "Sterling Industries" },
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

test("a non-expiry backend error surfaces an inline alert instead of a silently frozen screen", async ({
	page,
}) => {
	// run.svelte.ts sets `loadError` for any live-subscription failure that isn't
	// "Run expired."/"Run not found." (those auto-restart the run instead). Nothing rendered
	// that field, so a real backend fault mid-simulation showed the student nothing at all.
	await mockApi(page, {
		queries: [
			{
				name: "api/simulations:get",
				args: { runId: "testrun123" },
				error: "Case not found.",
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

test("a rejected turn re-enables the composer so the student can retry", async ({
	page,
}) => {
	// The server rejects synchronously (rate limit, chat ended, persona unavailable, message
	// too long). isSending must clear on that rejection -- if it didn't, one rejected message
	// would disable the composer for the rest of the run, since the effects that normally
	// clear it are waiting on a reply that will never arrive.
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
			"api/turn:start": () => {
				throw new Error("Rate limit exceeded.");
			},
		},
	});

	await page.goto("/");
	await page.getByPlaceholder("Enter access code").fill("sterling");
	await page.getByRole("button", { name: "Open Case" }).click();
	await expect(page).toHaveURL(/\/student$/);

	const composer = page.getByPlaceholder("Type your message...");
	await composer.fill("first attempt");
	await page.getByRole("button", { name: "Send" }).click();

	await expect(page.getByText("Rate limit exceeded.")).toBeVisible();
	await composer.fill("second attempt");
	await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});
