// Setup for the `server` (node) vitest project: pure-logic tests.
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw.js";

// `goto` and `redirect` only exist inside a running SvelteKit app. Stores and
// helpers under test call them for navigation side effects, so they're stubbed
// here as spies every test can assert on via `vi.mocked(goto)`.
vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

// Node project = no document. session.svelte.ts keys its sessionStorage access
// off this flag, so the node project covers the SSR branch and the client
// project (see setup.client.ts) covers the browser branch.
vi.mock("$app/environment", () => ({
	browser: false,
	building: false,
	dev: true,
	version: "test",
}));

// svelte-sonner renders into the DOM on import of its component, but `toast()`
// itself is a plain function; stubbed so notification calls are assertable and
// don't need a mounted <Toaster />.
vi.mock("svelte-sonner", () => {
	const toast = Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		dismiss: vi.fn(),
	});
	return { toast };
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
