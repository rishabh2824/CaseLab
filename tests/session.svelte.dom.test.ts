import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../src/lib/session.svelte.js";

const STORAGE_KEY = "caseLabSession";

// The session module as a new instance: the browser caches modules by URL, so a different fragment makes it load (and read sessionStorage) again.
async function freshSessionModule(): Promise<
	typeof import("../src/lib/session.svelte.js")
> {
	const url = new URL("../src/lib/session.svelte.ts", import.meta.url);
	url.hash = `fresh-${Math.random()}`;
	return await import(/* @vite-ignore */ url.href);
}

describe("session restore (observed through a fresh module load)", () => {
	// Tests that a stored session is restored.
	it("restores the session this tab stored", async () => {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: "r", startTime: 555, activePersonaId: "bob" }),
		);
		const { session: fresh } = await freshSessionModule();
		expect(fresh.runId).toBe("r");
		expect(fresh.startTime).toBe(555);
		expect(fresh.activePersonaId).toBe("bob");
	});
});

describe("SessionStore mutators", () => {
	beforeEach(() => {
		session.clearRun();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const readRaw = () =>
		JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string) as Record<
			string,
			unknown
		>;

	// Tests that startRun persists the run id and start time.
	it("startRun persists runId and startTime", () => {
		session.startRun({ runId: "run-1", startTime: 555 });

		expect(session.runId).toBe("run-1");
		expect(session.startTime).toBe(555);
		expect(readRaw()).toMatchObject({
			runId: "run-1",
			startTime: 555,
		});
	});

	// Tests that clearRun resets the run fields.
	it("clearRun clears the run fields", () => {
		session.startRun({ runId: "run-3", startTime: Date.now() });

		session.clearRun();

		expect(session.runId).toBe("");
		expect(session.startTime).toBeNull();
		expect(readRaw()).toMatchObject({
			runId: "",
			startTime: null,
		});
	});
});
