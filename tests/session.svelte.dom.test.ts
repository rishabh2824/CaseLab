import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../src/lib/session.svelte.js";

const STORAGE_KEY = "caseLabSession";

describe("session restore (observed through a fresh module load)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	// Tests that invalid stored JSON falls back to the default session state.
	it("falls back to defaults on invalid JSON", async () => {
		sessionStorage.setItem(STORAGE_KEY, "not valid json {{{");
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.startTime).toBeNull();
	});

	// Tests that a stored session is restored.
	it("restores the session this tab stored", async () => {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: "r", startTime: 555, activePersonaId: "bob" }),
		);
		const { session: fresh } = await import("../src/lib/session.svelte.js");
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

	// Tests that startRun defaults the start time to now when omitted.
	it("startRun defaults startTime to now when omitted", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		session.startRun({ runId: "run-2" });

		expect(session.startTime).toBe(1_700_000_000_000);
		expect(readRaw().startTime).toBe(1_700_000_000_000);
	});

	// Tests that clearRun resets the run fields.
	it("clearRun clears the run fields", () => {
		session.startRun({ runId: "run-3" });

		session.clearRun();

		expect(session.runId).toBe("");
		expect(session.startTime).toBeNull();
		expect(readRaw()).toMatchObject({
			runId: "",
			startTime: null,
		});
	});
});
