import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import AdminTopBar from "../../src/lib/components/AdminTopBar.svelte";
import {
	type SaveFn,
	unsavedGuard,
} from "../../src/lib/unsavedGuard.svelte.js";

const mockSignOut = vi.fn();

vi.mock("$lib/auth-client.js", () => ({
	authClient: { signOut: (...args: unknown[]) => mockSignOut(...args) },
}));

// Registers a dirty form with the given save function.
function registerDirtyForm(save: SaveFn = async () => ({ ok: true })) {
	unsavedGuard.register(() => true, save);
}

beforeEach(() => {
	mockSignOut.mockReset().mockResolvedValue(undefined);
	unsavedGuard.unregister();
	unsavedGuard.closeModal();
});

describe("AdminTopBar", () => {
	// Tests that the home button goes straight to the admin home when nothing is unsaved.
	it("goes to /admin from a clean form", async () => {
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Go to admin home" }));
		expect(goto).toHaveBeenCalledWith("/admin");
	});

	// Tests that signing out calls Better Auth and lands on the landing page.
	it("signs out and goes to the landing page", async () => {
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		expect(mockSignOut).toHaveBeenCalledOnce();
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
	});

	// Tests that a failing sign-out request does not stop the redirect.
	it("still leaves for the landing page when the sign-out request fails", async () => {
		mockSignOut.mockRejectedValue(new Error("network"));
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
	});

	// Tests that a dirty form holds navigation behind the modal.
	it("opens the unsaved-changes modal instead of navigating from a dirty form", async () => {
		registerDirtyForm();
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Go to admin home" }));
		expect(
			await screen.findByText("You have unsaved changes"),
		).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that saving from the modal then completes the held navigation.
	it("saves and then navigates when the user chooses Save changes", async () => {
		const save = vi.fn(async () => ({ ok: true as const }));
		registerDirtyForm(save);
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Go to admin home" }));
		await user.click(
			await screen.findByRole("button", { name: "Save changes" }),
		);
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/admin"));
		expect(save).toHaveBeenCalledOnce();
		expect(unsavedGuard.showModal).toBe(false);
	});

	// Tests that a failed save keeps the user on the page with the error shown.
	it("stays put and shows the error when the save fails", async () => {
		registerDirtyForm(async () => ({
			ok: false,
			error: "Case name is required.",
		}));
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Go to admin home" }));
		await user.click(
			await screen.findByRole("button", { name: "Save changes" }),
		);
		expect(
			await screen.findByText("Case name is required."),
		).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that discarding continues the held sign-out without saving.
	it("signs out after Discard changes", async () => {
		const save = vi.fn(async () => ({ ok: true as const }));
		registerDirtyForm(save);
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		await user.click(
			await screen.findByRole("button", { name: "Discard changes" }),
		);
		await waitFor(() => expect(mockSignOut).toHaveBeenCalledOnce());
		expect(goto).toHaveBeenCalledWith("/");
		expect(save).not.toHaveBeenCalled();
	});

	// Tests that cancelling closes the modal and does nothing else.
	it("does nothing when the user cancels the modal", async () => {
		registerDirtyForm();
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		await user.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(unsavedGuard.showModal).toBe(false));
		expect(mockSignOut).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();
	});
});
