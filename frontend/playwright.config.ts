import { defineConfig, devices } from "@playwright/test";

// E2E runs a production build+preview against a fully-mocked backend (see
// *Spec.ts files below), so it needs no live API, database, or Anthropic
// tokens. Every fetch in client.ts is a same-origin relative path, so it
// naturally resolves against whatever origin the preview server serves, and
// every /api call is intercepted. Uses build+preview rather than `vite dev`:
// the landing route is prerendered/SSR'd, so its markup exists before
// hydration finishes — under the dev server's slower per-request compile,
// Playwright's click can land before the submit handler attaches, causing a
// native form GET instead of the SPA navigation. A bundled preview build
// hydrates fast enough that this race doesn't happen. webServer below runs
// `pnpm run build`, not a bare `vite build` — the real build pipeline also
// runs scripts/inline-critical-css.mjs, and that step needs coverage same as
// everything else that ships to production.
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: ".",
	// Files are named `*Spec.ts` (no dot before "Spec"), not Playwright's
	// default `*.spec.ts` — matches this file's testMatch below.
	testMatch: "**/*Spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// On CI the HTML report is uploaded as an artifact when the run fails, so a
	// failure can be diagnosed (including traces) without re-running locally.
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `pnpm run build && npx vite preview --port ${PORT} --strictPort`,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
