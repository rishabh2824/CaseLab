import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { STUDENT_ERROR } from "../../convex/lib/studentErrors.js";
import { session } from "../../src/lib/session.svelte.js";
import Landing from "../../src/routes/+page.svelte";
import {
	clientServerError,
	clientStudentError,
} from "../support/convexClientErrors.js";

const mockMutation = vi.fn();

vi.mock("convex-svelte", () => ({
	getConvexClient: () => ({ mutation: mockMutation }),
}));

// Types a code into the access-code box and submits the form.
async function submitCode(code: string) {
	const user = userEvent.setup();
	await user.type(screen.getByLabelText("Access code"), code);
	await user.click(screen.getByRole("button", { name: "Open Case" }));
}

beforeEach(() => {
	mockMutation.mockReset();
	session.clearRun();
});

describe("landing page access-code form", () => {
	// Tests that a blank code is refused on the client without calling the server.
	it("rejects a blank code without calling the server", async () => {
		render(Landing);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText("Access code"), "   ");
		await user.click(screen.getByRole("button", { name: "Open Case" }));
		expect(screen.getByText("Invalid access code.")).toBeInTheDocument();
		expect(mockMutation).not.toHaveBeenCalled();
	});

	// Tests that the code is trimmed and lower-cased before it is sent.
	it("sends the trimmed, lower-cased code to the start mutation", async () => {
		mockMutation.mockResolvedValue({ runId: "run-1" });
		render(Landing);
		await submitCode("  Sterling-42 ");
		await waitFor(() => expect(mockMutation).toHaveBeenCalledOnce());
		const [ref, args] = mockMutation.mock.calls[0] as [never, unknown];
		expect(getFunctionName(ref)).toBe("simulations:start");
		expect(args).toEqual({ accessCode: "sterling-42" });
	});

	// Tests that a started run is stored in the session and the student goes to the simulation.
	it("stores the run and goes to /student on success", async () => {
		mockMutation.mockResolvedValue({ runId: "run-7" });
		render(Landing);
		await submitCode("sterling");
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/student"));
		expect(session.runId).toBe("run-7");
		expect(session.startTime).not.toBeNull();
	});

	// Tests that a real-shaped student error shows the server's own message.
	it("shows the message from a student error", async () => {
		mockMutation.mockRejectedValue(
			clientStudentError(
				"simulations:start",
				STUDENT_ERROR.INVALID_ACCESS_CODE,
				"That access code was not recognised.",
			),
		);
		render(Landing);
		await submitCode("nope");
		expect(
			await screen.findByText("That access code was not recognised."),
		).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
		expect(session.runId).toBe("");
	});

	// Tests that a redacted production error falls back to the generic message.
	it("shows the generic message for a redacted server error", async () => {
		mockMutation.mockRejectedValue(clientServerError("simulations:start"));
		render(Landing);
		await submitCode("sterling");
		expect(
			await screen.findByText(
				"Something went wrong starting the simulation. Please try again.",
			),
		).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that a network failure also falls back to the generic message.
	it("shows the generic message when the request itself fails", async () => {
		mockMutation.mockRejectedValue(new TypeError("Failed to fetch"));
		render(Landing);
		await submitCode("sterling");
		expect(
			await screen.findByText(
				"Something went wrong starting the simulation. Please try again.",
			),
		).toBeInTheDocument();
	});

	// Tests that the button is locked while the request runs and freed afterwards.
	it("disables the button while starting and re-enables it after a failure", async () => {
		let fail: (err: Error) => void = () => {};
		mockMutation.mockReturnValue(
			new Promise((_, reject) => {
				fail = reject;
			}),
		);
		render(Landing);
		await submitCode("sterling");
		const busy = await screen.findByRole("button", { name: "Starting…" });
		expect(busy).toBeDisabled();
		fail(clientServerError("simulations:start"));
		expect(
			await screen.findByRole("button", { name: "Open Case" }),
		).toBeEnabled();
	});

	// Tests that pressing Enter in the box submits the form like the button does.
	it("submits when Enter is pressed in the input", async () => {
		mockMutation.mockResolvedValue({ runId: "run-2" });
		render(Landing);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText("Access code"), "sterling{Enter}");
		await waitFor(() => expect(mockMutation).toHaveBeenCalledOnce());
	});

	// Tests that a later success clears the error left by an earlier failure.
	it("clears an earlier error after a successful retry", async () => {
		mockMutation
			.mockRejectedValueOnce(clientServerError("simulations:start"))
			.mockResolvedValueOnce({ runId: "run-3" });
		render(Landing);
		const user = userEvent.setup();
		await user.type(screen.getByLabelText("Access code"), "sterling");
		await user.click(screen.getByRole("button", { name: "Open Case" }));
		await screen.findByText(/Something went wrong/);
		await user.click(screen.getByRole("button", { name: "Open Case" }));
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/student"));
		expect(screen.queryByText(/Something went wrong/)).toBeNull();
	});

	// Tests that the admin login link points at the admin area.
	it("links to the admin login", () => {
		render(Landing);
		expect(screen.getByRole("link", { name: "Admin Login" })).toHaveAttribute(
			"href",
			"/admin",
		);
	});
});
