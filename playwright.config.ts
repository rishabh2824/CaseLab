import { defineConfig, devices } from "@playwright/test";

// E2E runs a production build+preview against a fully-mocked backend (see
// *Spec.ts files below and e2e/mockApi.ts/e2e/support/convexMock.svelte.ts),
// so it needs no live Convex deployment, database, or LLM credentials. The
// `E2E: "true"` env var below makes vite.config.ts alias `convex-svelte` to
// a Node-bridged in-memory mock for this build only — every useQuery/
// getConvexClient().mutation() call resolves against that mock instead of
// opening a real WebSocket. Uses build+preview rather than `vite dev`: a
// bundled build hydrates fast enough that Playwright's click can't land
// before the submit handler attaches, unlike the dev server's slower
// per-request compile. webServer below runs `pnpm run build`, not a bare
// `vite build` — the real build pipeline also runs critical-css.mjs, and
// that step needs coverage same as everything else that ships to
// production.
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	// Scoped to e2e/ (not repo root "."): with "." a stray nested checkout under
	// .claude/worktrees/**/e2e that happens to carry its own playwright.config.ts (e.g. an
	// in-progress git worktree) gets swept into test discovery too, and Playwright's
	// per-config module loading then throws "Requiring @playwright/test second time".
	// e2e/ is also just tighter scoping on its own merits — every *Spec.ts file already
	// lives there.
	testDir: "./e2e",
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
		env: { E2E: "true" },
	},
});
