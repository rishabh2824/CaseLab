import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import AdminLayout from "../../src/routes/(app)/admin/+layout.svelte";
import { clientServerError } from "../support/convexClientErrors.js";

type Viewer = {
	data?: { role: "super" | "admin" } | null;
	isLoading: boolean;
	error?: Error;
};

const auth = { isLoading: false, isAuthenticated: false };
let viewer: Viewer = { data: undefined, isLoading: false };
const mockSocial = vi.fn();
const mockSignOut = vi.fn();

vi.mock("@mmailaender/convex-better-auth-svelte/svelte", () => ({
	createSvelteAuthClient: vi.fn(),
	useAuth: () => auth,
}));

vi.mock("convex-svelte", () => ({
	getConvexClient: () => ({}),
	useQuery: () => viewer,
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

// Sets the query string the layout reads once when it is created.
function setSearch(search: string) {
	window.history.replaceState({}, "", `/admin${search}`);
}

beforeEach(() => {
	auth.isLoading = false;
	auth.isAuthenticated = false;
	viewer = { data: undefined, isLoading: false };
	mockSocial.mockReset().mockResolvedValue(undefined);
	mockSignOut.mockReset().mockResolvedValue(undefined);
	setSearch("");
});

afterEach(() => {
	vi.useRealTimers();
	setSearch("");
});

describe("admin layout sign-in", () => {
	// Tests that an anonymous visitor is sent straight into the Google flow with the right callbacks.
	it("starts Google sign-in for an anonymous visitor", () => {
		render(AdminLayout, { props: { children } });
		expect(mockSocial).toHaveBeenCalledOnce();
		expect(mockSocial).toHaveBeenCalledWith({
			provider: "google",
			callbackURL: "/admin",
			errorCallbackURL: "/admin?error=unauthorized",
		});
		expect(screen.queryByText("admin content")).toBeNull();
	});

	// Tests that sign-in waits until the auth state has loaded.
	it("does not sign in while auth is still loading", () => {
		auth.isLoading = true;
		render(AdminLayout, { props: { children } });
		expect(mockSocial).not.toHaveBeenCalled();
	});

	// Tests that an already signed-in visitor is not sent through Google again.
	it("does not sign in when already authenticated", () => {
		auth.isAuthenticated = true;
		viewer = { data: { role: "admin" }, isLoading: false };
		render(AdminLayout, { props: { children } });
		expect(mockSocial).not.toHaveBeenCalled();
	});

	// Tests that a rejected account sees the refusal instead of looping back into Google.
	it("shows the unauthorized message and does not retry sign-in", () => {
		setSearch("?error=unauthorized");
		render(AdminLayout, { props: { children } });
		expect(
			screen.getByText("Your account is not authorized."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Back to the landing page" }),
		).toHaveAttribute("href", "/");
		expect(mockSocial).not.toHaveBeenCalled();
	});

	// Tests that a one-time-token redirect gets a grace period before sign-in restarts.
	it("waits out the one-time-token exchange before signing in", async () => {
		vi.useFakeTimers();
		setSearch("?ott=abc");
		render(AdminLayout, { props: { children } });
		expect(mockSocial).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4000);
		expect(mockSocial).toHaveBeenCalledOnce();
	});

	// Tests that a failed sign-in shows its message and can be retried.
	it("shows a sign-in failure and retries on demand", async () => {
		mockSocial.mockRejectedValueOnce(new Error("Popup blocked."));
		const user = userEvent.setup();
		render(AdminLayout, { props: { children } });
		expect(await screen.findByText("Popup blocked.")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(mockSocial).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(screen.queryByText("Popup blocked.")).toBeNull(),
		);
	});

	// Tests that a non-Error rejection still shows a readable message.
	it("falls back to a generic message for a non-Error failure", async () => {
		mockSocial.mockRejectedValueOnce("nope");
		render(AdminLayout, { props: { children } });
		expect(
			await screen.findByText("Sign-in failed. Try again."),
		).toBeInTheDocument();
	});
});

describe("admin layout viewer gate", () => {
	beforeEach(() => {
		auth.isAuthenticated = true;
	});

	// Tests that nothing renders while the viewer query is loading.
	it("renders nothing while the viewer is loading", () => {
		viewer = { data: undefined, isLoading: true };
		render(AdminLayout, { props: { children } });
		expect(screen.queryByText("admin content")).toBeNull();
		expect(screen.queryByText("Not authorized.")).toBeNull();
	});

	// Tests that a rostered admin gets the top bar and the page.
	it("renders the top bar and the page for an admin", () => {
		viewer = { data: { role: "admin" }, isLoading: false };
		render(AdminLayout, { props: { children } });
		expect(screen.getByText("admin content")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Go to admin home" }),
		).toBeInTheDocument();
	});

	// Tests that a signed-in user missing from the roster never sees admin content.
	it("blocks a signed-in user who is not on the roster", async () => {
		viewer = { data: null, isLoading: false };
		const user = userEvent.setup();
		render(AdminLayout, { props: { children } });
		expect(screen.getByText("Not authorized.")).toBeInTheDocument();
		expect(screen.queryByText("admin content")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Sign out" }));
		expect(mockSignOut).toHaveBeenCalledOnce();
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
	});

	// Tests that a viewer query failure shows a safe message and a reload button.
	it("shows a friendly error with a reload button when the viewer query fails", () => {
		viewer = {
			data: undefined,
			isLoading: false,
			error: clientServerError("api/admins:viewer", "Q"),
		};
		render(AdminLayout, { props: { children } });
		expect(
			screen.getByText("Something went wrong loading your admin account."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
		expect(screen.queryByText("admin content")).toBeNull();
	});
});
