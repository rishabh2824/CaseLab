import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { convexFake } from "./convexFake.svelte.js";
import { server } from "./msw.js";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

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

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
	server.resetHandlers();
	convexFake.reset();
});
afterAll(() => server.close());
