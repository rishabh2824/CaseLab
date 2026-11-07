import { afterEach, vi } from "vitest";
import "../../src/app.css";
import { convexFake } from "./convexFake.svelte.js";

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

// Test files share one browser page, so whatever a test leaves in it has to be put back.
// Components are unmounted by vitest-browser-svelte itself.
afterEach(() => {
	convexFake.reset();
	document.body.style.pointerEvents = "";
	sessionStorage.clear();
});
