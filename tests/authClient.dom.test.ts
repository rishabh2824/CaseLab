import { describe, expect, it, vi } from "vitest";
import { authClient } from "../src/lib/auth-client.js";
import { resolveConvexSiteUrl } from "../src/lib/convexUrl.js";

describe("authClient", () => {
	// Tests that sign-out posts to the Better Auth endpoint on the Convex site URL, not the app's own origin.
	it("signs out against the Convex site's auth endpoint", async () => {
		const customFetchImpl = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await authClient.signOut({ fetchOptions: { customFetchImpl } });

		expect(customFetchImpl).toHaveBeenCalledTimes(1);
		const [input, init] = customFetchImpl.mock.calls[0]!;
		const url = input instanceof Request ? input.url : String(input);
		const method = input instanceof Request ? input.method : init?.method;
		expect(url).toBe(`${resolveConvexSiteUrl()}/api/auth/sign-out`);
		expect(method).toBe("POST");
	});
});
