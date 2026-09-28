import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../src/lib/session.svelte.js";

const STORAGE_KEY = "caseLabSession";

describe("normalizePersisted (observed through a fresh module load)", () => {
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

	// Tests that a stored JSON null falls back to the defaults.
	it("falls back to defaults when the stored value is JSON null", async () => {
		sessionStorage.setItem(STORAGE_KEY, "null");
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.startTime).toBeNull();
	});

	// Tests that a stored JSON string falls back to the defaults.
	it("falls back to defaults when the stored value is a JSON string", async () => {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify("just a string"));
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
	});

	// Tests that a stored JSON array falls back to the defaults.
	it("falls back to defaults when the stored value is a JSON array", async () => {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["run-1", "code-1"]));
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
	});

	// Tests that valid stored fields are kept while only the invalid ones are defaulted.
	it("keeps good fields and defaults only the bad ones in the same blob", async () => {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: 42, startTime: 555 }),
		);
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.startTime).toBe(555);
	});

	// Tests that a valid remembered persona is restored and a missing or malformed one is defaulted.
	it("restores the remembered persona, and defaults it when it's missing or malformed", async () => {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: "r", activePersonaId: "bob" }),
		);
		expect(
			(await import("../src/lib/session.svelte.js")).session.activePersonaId,
		).toBe("bob");

		vi.resetModules();
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: "r", activePersonaId: 7 }),
		);
		expect(
			(await import("../src/lib/session.svelte.js")).session.activePersonaId,
		).toBe("");
	});

	// Tests that unknown fields in the stored blob are ignored rather than rejecting it.
	it("ignores unknown fields in the stored blob instead of rejecting it", async () => {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: "run-1", adminRole: "super" }),
		);
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("run-1");
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

	// Tests that setRunId writes through to sessionStorage.
	it("setRunId writes through to sessionStorage", () => {
		session.setRunId("run-5");

		expect(session.runId).toBe("run-5");
		expect(readRaw().runId).toBe("run-5");
	});
});
