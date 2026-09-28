import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw.js";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

vi.mock("$app/environment", () => ({
	browser: false,
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

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
