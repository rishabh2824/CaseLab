import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import AdminTopBar from "../../src/lib/components/AdminTopBar.svelte";

const mockSignOut = vi.fn();
let pathname = "/";

vi.mock("#lib/auth-client.js", () => ({
	authClient: { signOut: (...args: unknown[]) => mockSignOut(...args) },
}));

vi.mock("$app/state", () => ({
	page: {
		get url() {
			return new URL(`http://localhost${pathname}`);
		},
	},
}));

beforeEach(() => {
	mockSignOut.mockReset().mockResolvedValue(undefined);
	pathname = "/";
});

describe("AdminTopBar", () => {
	// Tests that the home control is a plain link, so the form's navigation guard covers it.
	it("links to the admin home", () => {
		render(AdminTopBar);
		expect(
			screen.getByRole("link", { name: "Go to admin home" }),
		).toHaveAttribute("href", "/admin");
	});

	// Tests that signing out lands on the landing page and then calls Better Auth.
	it("goes to the landing page and signs out", async () => {
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		expect(goto).toHaveBeenCalledWith("/");
		await waitFor(() => expect(mockSignOut).toHaveBeenCalledOnce());
	});

	// Tests that a failing sign-out request does not surface as an error.
	it("ignores a failing sign-out request", async () => {
		mockSignOut.mockRejectedValue(new Error("network"));
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(mockSignOut).toHaveBeenCalledOnce());
	});

	// Tests that a navigation held back by the unsaved-changes dialog does not sign the admin out.
	it("does not sign out when the navigation to the landing page was cancelled", async () => {
		pathname = "/admin/cases/new";
		const user = userEvent.setup();
		render(AdminTopBar);
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(mockSignOut).not.toHaveBeenCalled();
	});
});
