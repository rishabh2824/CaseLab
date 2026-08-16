// Runs in the jsdom (client) project: requireSuperAdmin reads session.svelte.ts's session
// store, which touches sessionStorage -- a real browser-like global the node project
// doesn't provide.
import { isRedirect } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSuperAdmin } from "../src/lib/auth.js";
import { ADMIN_ROLE } from "../src/lib/constants.js";
import { session } from "../src/lib/session.svelte.js";

async function caughtRedirect(fn: () => Promise<void>) {
	try {
		await fn();
		throw new Error("expected a redirect to be thrown");
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return e;
	}
}

describe("requireSuperAdmin", () => {
	// requireSuperAdmin trusts session.adminRole directly rather than checking
	// anything itself -- AdminAuth.svelte (mounted during sign-in) is what
	// keeps it settled, by syncing it from Convex's `viewer` query. These
	// tests set session.adminRole directly, the way that sync would have.
	afterEach(() => {
		session.clearAdmin();
		vi.restoreAllMocks();
	});

	it("does not redirect when the session admin is SUPER", () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.SUPER,
			adminEmail: "super@wisc.edu",
		});

		expect(() => requireSuperAdmin()).not.toThrow();
	});

	it("redirects to /admin when the session admin is a non-SUPER ADMIN", async () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.ADMIN,
			adminEmail: "admin@wisc.edu",
		});

		const redirect = await caughtRedirect(async () => requireSuperAdmin());

		expect(redirect.status).toBe(302);
		expect(redirect.location).toBe("/admin");
	});
});
