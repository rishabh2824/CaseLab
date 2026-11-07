import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { goto } from "$app/navigation";
import AdminTopBar from "../../../src/lib/components/ui/AdminTopBar.svelte";

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
	it("links to the admin home", async () => {
		await render(AdminTopBar);
		await expect
			.element(page.getByRole("link", { name: "Go to admin home" }))
			.toHaveAttribute("href", "/admin");
	});

	// Tests that signing out lands on the landing page and then calls Better Auth.
	it("goes to the landing page and signs out", async () => {
		await render(AdminTopBar);
		await page.getByRole("button", { name: "Sign out" }).click();
		expect(goto).toHaveBeenCalledWith("/");
		await vi.waitFor(() => expect(mockSignOut).toHaveBeenCalledOnce());
	});

	// Tests that a failing sign-out request does not surface as an error.
	it("ignores a failing sign-out request", async () => {
		mockSignOut.mockRejectedValue(new Error("network"));
		await render(AdminTopBar);
		await page.getByRole("button", { name: "Sign out" }).click();
		await vi.waitFor(() => expect(mockSignOut).toHaveBeenCalledOnce());
	});

	// Tests that a navigation held back by the unsaved-changes dialog does not sign the admin out.
	it("does not sign out when the navigation to the landing page was cancelled", async () => {
		pathname = "/admin/cases/new";
		await render(AdminTopBar);
		await page.getByRole("button", { name: "Sign out" }).click();
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(mockSignOut).not.toHaveBeenCalled();
	});
});
