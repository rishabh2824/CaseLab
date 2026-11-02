import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { convexFake } from "./convexFake.svelte.js";
import { server } from "./msw.js";

// SvelteKit's generated dev env module reads this global, which only exists in a running app.
(globalThis as Record<string, unknown>).__sveltekit_dev = { env: {} };

vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

// Every component test talks to this one typed fake instead of its own hand-written mock.
vi.mock("convex-svelte", async () => {
	const { convexSvelteModule } = await import("./convexFake.svelte.js");
	return convexSvelteModule;
});

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

// jsdom has no layout, so it leaves this out.
Element.prototype.scrollIntoView = vi.fn();
// jsdom also reports no boxes for any element, which makes floating content (popovers, tooltips) count as detached from its trigger and hide itself.
Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;

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
	convexFake.reset();
	document.body.style.pointerEvents = "";
	server.resetHandlers();
	sessionStorage.clear();
});
afterAll(() => server.close());
