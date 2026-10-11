import { defineConfig, devices } from "@playwright/test";

// The live suite: a real browser, the real frontend build and a real (local) Convex backend. Only the
// LLM provider is replaced, through LLM_BASE_URL. Run it with `pnpm run test:e2e:live`.
export default defineConfig({
	testDir: "./e2e-live",
	testMatch: "**/*.spec.ts",
	globalSetup: "./e2e-live/global-setup.ts",
	// One local backend is shared, so specs run one after another.
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	timeout: 60_000,
	use: {
		baseURL: "http://localhost:4173",
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
