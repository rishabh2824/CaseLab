import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { ERROR_CODE } from "#shared/errors.js";
import { goto } from "$app/navigation";
import { session } from "../../src/lib/session.svelte.js";
import Landing from "../../src/routes/+page.svelte";
import {
	clientAppError,
	clientServerError,
} from "../support/convexClientErrors.js";
import { convexFake } from "../support/convexFake.svelte.js";

const start = convexFake.mutation(api.runs.start);
const START = getFunctionName(api.runs.start);
const run = (runId: string) => ({ runId: runId as Id<"runs"> });

const GENERIC_ERROR =
	"Something went wrong starting the simulation. Please try again.";

const codeBox = () => page.getByLabelText("Access code");
const openCase = () => page.getByRole("button", { name: "Open Case" });

// Types a code into the access-code box and submits the form.
async function submitCode(code: string) {
	await codeBox().fill(code);
	await openCase().click();
}

beforeEach(() => {
	session.clearRun();
});

describe("landing page access-code form", () => {
	// Tests that the code is sent as typed, since the server trims and lower-cases it and rejects a blank one.
	it("sends the code as typed to the start mutation", async () => {
		start.mockResolvedValue(run("run-1"));
		await render(Landing);
		await submitCode("  Sterling-42 ");
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
		expect(start).toHaveBeenCalledWith({ accessCode: "  Sterling-42 " });
	});

	// Tests that a started run is stored in the session and the student goes to the simulation.
	it("stores the run and goes to /student on success", async () => {
		start.mockResolvedValue(run("run-7"));
		await render(Landing);
		await submitCode("sterling");
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/student"));
		expect(session.runId).toBe("run-7");
		expect(session.startTime).not.toBeNull();
	});

	// Tests that a real-shaped student error shows the server's own message.
	it("shows the message from an app error", async () => {
		start.mockRejectedValue(
			clientAppError(
				START,
				ERROR_CODE.INVALID_ACCESS_CODE,
				"That access code was not recognised.",
			),
		);
		await render(Landing);
		await submitCode("nope");
		await expect
			.element(page.getByText("That access code was not recognised."))
			.toBeVisible();
		expect(goto).not.toHaveBeenCalled();
		expect(session.runId).toBe("");
	});

	// Tests that a redacted production error falls back to the generic message.
	it("shows the generic message for a redacted server error", async () => {
		start.mockRejectedValue(clientServerError(START));
		await render(Landing);
		await submitCode("sterling");
		await expect.element(page.getByText(GENERIC_ERROR)).toBeVisible();
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that a network failure also falls back to the generic message.
	it("shows the generic message when the request itself fails", async () => {
		start.mockRejectedValue(new TypeError("Failed to fetch"));
		await render(Landing);
		await submitCode("sterling");
		await expect.element(page.getByText(GENERIC_ERROR)).toBeVisible();
	});

	// Tests that the button is locked while the request runs and freed afterwards.
	it("disables the button while starting and re-enables it after a failure", async () => {
		let fail: (err: Error) => void = () => {};
		start.mockReturnValue(
			new Promise((_, reject) => {
				fail = reject;
			}),
		);
		await render(Landing);
		await submitCode("sterling");
		await expect
			.element(page.getByRole("button", { name: "Starting…" }))
			.toBeDisabled();
		fail(clientServerError(START));
		await expect.element(openCase()).toBeEnabled();
	});

	// Tests that pressing Enter in the box submits the form like the button does.
	it("submits when Enter is pressed in the input", async () => {
		start.mockResolvedValue(run("run-2"));
		await render(Landing);
		await codeBox().fill("sterling");
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
	});

	// Tests that a later success clears the error left by an earlier failure.
	it("clears an earlier error after a successful retry", async () => {
		start
			.mockRejectedValueOnce(clientServerError(START))
			.mockResolvedValueOnce(run("run-3"));
		await render(Landing);
		await submitCode("sterling");
		await expect.element(page.getByText(/Something went wrong/)).toBeVisible();
		await openCase().click();
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/student"));
		await expect
			.element(page.getByText(/Something went wrong/))
			.not.toBeInTheDocument();
	});

	// Tests that the admin login link points at the admin area.
	it("links to the admin login", async () => {
		await render(Landing);
		await expect
			.element(page.getByRole("link", { name: "Admin Login" }))
			.toHaveAttribute("href", "/admin");
	});
});
