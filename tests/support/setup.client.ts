import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw.js";

// SvelteKit's generated dev env module reads this global, which only exists in a running app.
(globalThis as Record<string, unknown>).__sveltekit_dev = { env: {} };

vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

vi.mock("$app/env", () => ({
	browser: true,
	building: false,
	dev: true,
	version: "test",
}));

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

if (!globalThis.crypto?.randomUUID) {
	let counter = 0;
	Object.defineProperty(globalThis.crypto, "randomUUID", {
		configurable: true,
		value: () =>
			`00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` as const,
	});
}
URL.createObjectURL = vi.fn(() => "blob:mock");
URL.revokeObjectURL = vi.fn();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
	cleanup();
	document.body.style.pointerEvents = "";
	server.resetHandlers();
	sessionStorage.clear();
});
afterAll(() => server.close());
