import { describe, expect, it } from "vitest";
import { authClient } from "../src/lib/auth-client.js";

describe("authClient", () => {
	// Tests that the client exposes the sign-in and sign-out calls the admin pages depend on.
	it("exposes social sign-in and sign-out", () => {
		expect(typeof authClient.signIn.social).toBe("function");
		expect(typeof authClient.signOut).toBe("function");
	});
});
