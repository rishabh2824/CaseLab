import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*Spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
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
		env: { E2E: "true", BUILD_DIR: "build-e2e" },
	},
});
