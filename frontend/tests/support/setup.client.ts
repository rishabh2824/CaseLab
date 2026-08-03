// Setup for the `client` (jsdom) vitest project: Svelte components and the
// DOMParser-based case importer.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw.js";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

vi.mock("$app/environment", () => ({
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

// jsdom implements neither of these, and both are load-bearing: the case form
// generates persona ids with randomUUID, and downloadForm revokes an object URL
// after triggering the download.
if (!globalThis.crypto?.randomUUID) {
	let counter = 0;
	Object.defineProperty(globalThis.crypto, "randomUUID", {
		configurable: true,
		value: () =>
			`00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` as const,
	});
}
if (!URL.createObjectURL) {
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
	cleanup();
	// bits-ui's dialogs lock the page by setting `pointer-events: none` on
	// <body> while open, and restore it from a transition callback on close. A
	// test that ends with a modal open — or that froze the clock so the exit
	// transition never ran — leaves that lock in place, and the NEXT test's
	// clicks then fail with "element has pointer-events: none". Clearing it
	// here keeps that from leaking across files.
	document.body.style.pointerEvents = "";
	server.resetHandlers();
	// Only sessionStorage — session.svelte.ts is the sole storage user and that
	// is what it writes to. (jsdom exposes no localStorage here anyway.)
	sessionStorage.clear();
});
afterAll(() => server.close());
