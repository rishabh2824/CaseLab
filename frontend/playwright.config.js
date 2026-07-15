import { defineConfig, devices } from '@playwright/test'

// E2E runs the real Vite build against a fully-mocked backend (see e2e/*.spec.js),
// so it needs no live API, database, or Anthropic tokens. VITE_API_BASE points at
// the same origin the dev server serves, and every /api call is intercepted.
const PORT = 5199
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: 'list',
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: `npx vite --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        env: { VITE_API_BASE: BASE_URL },
        timeout: 120_000,
    },
})
