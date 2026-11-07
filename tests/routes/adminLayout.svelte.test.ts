import { getFunctionName } from "convex/server";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { goto } from "$app/navigation";
import AdminLayout from "../../src/routes/(app)/admin/+layout.svelte";
import { clientServerError } from "../support/convexClientErrors.js";
import { convexFake, type QueryState } from "../support/convexFake.svelte.js";

const auth = { isLoading: false, isAuthenticated: false };

// Sets what the admin viewer query returns.
function setViewer(state: QueryState<typeof api.admins.viewer>) {
	convexFake.setQuery(api.admins.viewer, undefined, state);
}

// Builds the viewer row for an admin of the given role.
function viewerAs(role: "super" | "admin") {
	return {
		_id: "admin-1" as Id<"admins">,
		email: "admin@wisc.edu",
		name: "Admin",
		role,
	};
}
const mockSocial = vi.fn();
const mockSignOut = vi.fn();

vi.mock("@mmailaender/convex-better-auth-svelte/svelte", () => ({
	createSvelteAuthClient: vi.fn(),
	useAuth: () => auth,
}));

vi.mock("#lib/auth-client.js", () => ({
	authClient: {
		signIn: { social: (...args: unknown[]) => mockSocial(...args) },
		signOut: (...args: unknown[]) => mockSignOut(...args),
	},
}));

const children = createRawSnippet(() => ({
	render: () => "<p>admin content</p>",
}));

// The address the test page started on, put back after every test because these tests change it.
const originalUrl = window.location.href;

// Sets the query string the layout reads once when it is created.
function setSearch(search: string) {
	window.history.replaceState({}, "", `/admin${search}`);
}

beforeEach(() => {
	auth.isLoading = false;
	auth.isAuthenticated = false;
	mockSocial.mockReset().mockResolvedValue(undefined);
	mockSignOut.mockReset().mockResolvedValue(undefined);
	setSearch("");
});

afterEach(() => {
	vi.useRealTimers();
	window.history.replaceState({}, "", originalUrl);
});

describe("admin layout sign-in", () => {
	// Tests that an anonymous visitor is sent straight into the Google flow with the right callbacks.
	it("starts Google sign-in for an anonymous visitor", async () => {
		await render(AdminLayout, { children });
		expect(mockSocial).toHaveBeenCalledOnce();
		expect(mockSocial).toHaveBeenCalledWith({
			provider: "google",
			callbackURL: "/admin",
			errorCallbackURL: "/admin?error=unauthorized",
		});
		await expect
			.element(page.getByText("admin content"))
			.not.toBeInTheDocument();
	});

	// Tests that sign-in waits until the auth state has loaded.
	it("does not sign in while auth is still loading", async () => {
		auth.isLoading = true;
		await render(AdminLayout, { children });
		expect(mockSocial).not.toHaveBeenCalled();
	});

	// Tests that an already signed-in visitor is not sent through Google again.
	it("does not sign in when already authenticated", async () => {
		auth.isAuthenticated = true;
		setViewer({ data: viewerAs("admin") });
		await render(AdminLayout, { children });
		expect(mockSocial).not.toHaveBeenCalled();
	});

	// Tests that a rejected account sees the refusal instead of looping back into Google.
	it("shows the unauthorized message and does not retry sign-in", async () => {
		setSearch("?error=unauthorized");
		await render(AdminLayout, { children });
		await expect
			.element(page.getByText("Your account is not authorized."))
			.toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Back to the landing page" }))
			.toHaveAttribute("href", "/");
		expect(mockSocial).not.toHaveBeenCalled();
	});

	// Tests that a one-time-token redirect gets a grace period before sign-in restarts.
	it("waits out the one-time-token exchange before signing in", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		setSearch("?ott=abc");
		await render(AdminLayout, { children });
		expect(mockSocial).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4000);
		expect(mockSocial).toHaveBeenCalledOnce();
	});

	// Tests that a failed sign-in shows its message and can be retried.
	it("shows a sign-in failure and retries on demand", async () => {
		mockSocial.mockRejectedValueOnce(new Error("Popup blocked."));
		await render(AdminLayout, { children });
		await expect.element(page.getByText("Popup blocked.")).toBeVisible();
		await page.getByRole("button", { name: "Try again" }).click();
		expect(mockSocial).toHaveBeenCalledTimes(2);
		await expect
			.element(page.getByText("Popup blocked."))
			.not.toBeInTheDocument();
	});

	// Tests that a non-Error rejection still shows a readable message.
	it("falls back to a generic message for a non-Error failure", async () => {
		mockSocial.mockRejectedValueOnce("nope");
		await render(AdminLayout, { children });
		await expect
			.element(page.getByText("Sign-in failed. Try again."))
			.toBeVisible();
	});
});

describe("admin layout viewer gate", () => {
	beforeEach(() => {
		auth.isAuthenticated = true;
	});

	// Tests that a loading placeholder shows, and no admin content, while the viewer query is loading.
	it("shows a loading placeholder while the viewer is loading", async () => {
		setViewer({ isLoading: true });
		await render(AdminLayout, { children });
		await expect
			.element(page.getByRole("status"))
			.toHaveTextContent("Loading…");
		await expect
			.element(page.getByText("admin content"))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByText("Not authorized."))
			.not.toBeInTheDocument();
	});

	// Tests that a rostered admin gets the top bar and the page.
	it("renders the top bar and the page for an admin", async () => {
		setViewer({ data: viewerAs("admin") });
		await render(AdminLayout, { children });
		await expect.element(page.getByText("admin content")).toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Go to admin home" }))
			.toBeVisible();
	});

	// Tests that a signed-in user missing from the roster never sees admin content.
	it("blocks a signed-in user who is not on the roster", async () => {
		setViewer({ data: null });
		await render(AdminLayout, { children });
		await expect.element(page.getByText("Not authorized.")).toBeVisible();
		await expect
			.element(page.getByText("admin content"))
			.not.toBeInTheDocument();
		await page.getByRole("button", { name: "Sign out" }).click();
		await vi.waitFor(() => expect(mockSignOut).toHaveBeenCalledOnce());
		expect(goto).toHaveBeenCalledWith("/");
		expect(vi.mocked(goto).mock.invocationCallOrder[0]).toBeLessThan(
			mockSignOut.mock.invocationCallOrder[0] as number,
		);
	});

	// Tests that a viewer query failure shows a safe message and a reload button.
	it("shows a friendly error with a reload button when the viewer query fails", async () => {
		setViewer({
			error: clientServerError(getFunctionName(api.admins.viewer), "Q"),
		});
		await render(AdminLayout, { children });
		await expect
			.element(
				page.getByText("Something went wrong loading your admin account."),
			)
			.toBeVisible();
		await expect
			.element(page.getByRole("button", { name: "Reload" }))
			.toBeVisible();
		await expect
			.element(page.getByText("admin content"))
			.not.toBeInTheDocument();
	});
});
