// Runs in the jsdom (client) project: auth.ts calls apiFetch with a relative
// path ("/api/..."), which needs a document origin to resolve against — same
// reason tests/api/client.dom.test.ts lives here instead of the node project.
import { isRedirect } from "@sveltejs/kit";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchAdmin,
	requireSuperAdmin,
	signOutAdmin,
} from "../src/lib/auth.js";
import { ADMIN_ROLE } from "../src/lib/constants.js";
import { session } from "../src/lib/session.svelte.js";
import { server } from "./support/msw.js";

async function caughtRedirect(fn: () => Promise<void>) {
	try {
		await fn();
		throw new Error("expected a redirect to be thrown");
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return e;
	}
}

describe("fetchAdmin", () => {
	afterEach(() => {
		session.clearAdmin();
		vi.restoreAllMocks();
	});

	it("sets the session admin fields from a successful /api/admin/me response", async () => {
		server.use(
			http.get("*/api/admin/me", () =>
				HttpResponse.json({
					admin_id: 1,
					role: ADMIN_ROLE.SUPER,
					email: "super@wisc.edu",
					name: "Super Admin",
				}),
			),
		);

		const admin = await fetchAdmin();

		expect(admin).toEqual({ adminRole: ADMIN_ROLE.SUPER, adminEmail: "super@wisc.edu" });
		expect(session.adminRole).toBe(ADMIN_ROLE.SUPER);
		expect(session.adminEmail).toBe("super@wisc.edu");
	});

	it("clears the session and resolves null (does not throw) when /api/admin/me fails", async () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.ADMIN,
			adminEmail: "stale@wisc.edu",
		});
		server.use(
			http.get("*/api/admin/me", () =>
				HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
			),
		);

		const admin = await fetchAdmin();

		// No redirect thrown here (unlike the old requireAdmin()) -- fetchAdmin() runs
		// unawaited by the admin layout's load now, so it can't throw a load-time redirect;
		// +layout.svelte redirects itself once this promise settles unfavorably.
		expect(admin).toBeNull();
		expect(session.adminRole).toBeNull();
		expect(session.adminEmail).toBe("");
	});
});

describe("requireSuperAdmin", () => {
	// requireSuperAdmin trusts session.adminRole rather than checking
	// /api/admin/me itself — admin/admins/+page.ts's load explicitly awaits
	// the admin layout's fetchAdmin() promise (via `(await parent()).admin`)
	// before calling this, to guarantee session.adminRole is already settled.
	// These tests set session.adminRole directly, the way that awaited
	// fetchAdmin() call would have.
	afterEach(() => {
		session.clearAdmin();
		vi.restoreAllMocks();
	});

	it("does not redirect when the session admin is SUPER", () => {
		session.setAdmin({ adminRole: ADMIN_ROLE.SUPER, adminEmail: "super@wisc.edu" });

		expect(() => requireSuperAdmin()).not.toThrow();
	});

	it("redirects to /admin when the session admin is a non-SUPER ADMIN", async () => {
		session.setAdmin({ adminRole: ADMIN_ROLE.ADMIN, adminEmail: "admin@wisc.edu" });

		const redirect = await caughtRedirect(async () => requireSuperAdmin());

		expect(redirect.status).toBe(302);
		expect(redirect.location).toBe("/admin");
	});
});

describe("signOutAdmin", () => {
	afterEach(() => {
		session.clearAdmin();
		vi.restoreAllMocks();
	});

	it("clears the session, navigates home, and calls the logout endpoint", async () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.ADMIN,
			adminEmail: "admin@wisc.edu",
		});
		let logoutCalled = false;
		server.use(
			http.post("*/api/admin/logout", () => {
				logoutCalled = true;
				return HttpResponse.json({});
			}),
		);
		const nav = await import("$app/navigation");
		const goto = vi.mocked(nav.goto);
		goto.mockClear();

		await signOutAdmin();

		expect(session.adminRole).toBeNull();
		expect(session.adminEmail).toBe("");
		expect(goto).toHaveBeenCalledWith("/");
		expect(logoutCalled).toBe(true);
	});

	it("does not throw when the logout request fails (best-effort — the cookie expires on its own)", async () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.ADMIN,
			adminEmail: "admin@wisc.edu",
		});
		server.use(
			http.post("*/api/admin/logout", () =>
				HttpResponse.json({ detail: "boom" }, { status: 500 }),
			),
		);
		const nav = await import("$app/navigation");
		const goto = vi.mocked(nav.goto);
		goto.mockClear();

		await expect(signOutAdmin()).resolves.toBeUndefined();

		expect(session.adminRole).toBeNull();
		expect(goto).toHaveBeenCalledWith("/");
	});
});
