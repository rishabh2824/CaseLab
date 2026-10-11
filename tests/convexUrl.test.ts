import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConvexSiteUrl } from "../src/lib/convexUrl.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveConvexSiteUrl", () => {
	// Tests that a cloud deployment URL maps to its .convex.site twin.
	it("derives the site URL from a .convex.cloud deployment URL", () => {
		vi.stubEnv("VITE_CONVEX_URL", "https://happy-animal-123.convex.cloud");
		vi.stubEnv("VITE_CONVEX_SITE_URL", "");
		expect(resolveConvexSiteUrl()).toBe("https://happy-animal-123.convex.site");
	});

	// Tests that an explicit site URL wins, as a local deployment serves it from another port.
	it("uses VITE_CONVEX_SITE_URL when it is set", () => {
		vi.stubEnv("VITE_CONVEX_URL", "http://127.0.0.1:3210");
		vi.stubEnv("VITE_CONVEX_SITE_URL", "http://127.0.0.1:3211");
		expect(resolveConvexSiteUrl()).toBe("http://127.0.0.1:3211");
	});
});
