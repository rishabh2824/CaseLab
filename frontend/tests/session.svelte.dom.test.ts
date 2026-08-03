// Client project: `browser` is mocked `true` here (see setup.client.ts), so
// session.svelte.ts's sessionStorage branch is live and this file can
// observe read/write round-trips for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_ROLE } from "../src/lib/constants.js";
import { session } from "../src/lib/session.svelte.js";

// Mirrors the private STORAGE_KEY in session.svelte.ts (not exported) — the
// only way to seed/inspect the raw persisted blob from outside the module.
const STORAGE_KEY = "caseLabSession";

describe("normalizePersisted (observed through a fresh module load)", () => {
	// `initial = readPersisted()` runs once at module-evaluation time, so
	// exercising different starting blobs requires a genuinely fresh module
	// instance per case — the already-imported singleton above only ever saw
	// whatever sessionStorage held when *this file* first loaded.
	beforeEach(() => {
		vi.resetModules();
	});

	it("falls back to defaults on invalid JSON", async () => {
		sessionStorage.setItem(STORAGE_KEY, "not valid json {{{");
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.accessCode).toBe("");
		expect(fresh.adminRole).toBeNull();
		expect(fresh.adminEmail).toBe("");
		expect(fresh.startTime).toBeNull();
	});

	it("falls back to defaults when the stored value is JSON null", async () => {
		sessionStorage.setItem(STORAGE_KEY, "null");
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.startTime).toBeNull();
	});

	it("falls back to defaults when the stored value is a JSON string", async () => {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify("just a string"));
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.accessCode).toBe("");
	});

	it("falls back to defaults when the stored value is a JSON array", async () => {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["run-1", "code-1"]));
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe("");
		expect(fresh.accessCode).toBe("");
		expect(fresh.adminRole).toBeNull();
	});

	// The documented per-field fallback: a blob that's an object but has one
	// bad field and one good one keeps the good one rather than discarding the
	// whole thing (the old, cruder behavior would have wiped accessCode too).
	it("keeps good fields and defaults only the bad ones in the same blob", async () => {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ runId: 42, accessCode: "ABC123" }),
		);
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.runId).toBe(""); // numeric runId is invalid -> default
		expect(fresh.accessCode).toBe("ABC123"); // valid string -> kept
	});

	it.each([
		[3, null],
		["SUPER", null],
		[ADMIN_ROLE.SUPER, ADMIN_ROLE.SUPER],
		[ADMIN_ROLE.ADMIN, ADMIN_ROLE.ADMIN],
	])("adminRole %j normalizes to %j", async (stored, expected) => {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ adminRole: stored }));
		const { session: fresh } = await import("../src/lib/session.svelte.js");
		expect(fresh.adminRole).toBe(expected);
	});
});

describe("SessionStore mutators", () => {
	// The store is a module-level singleton; reset its public fields directly
	// between tests rather than depending on re-import (re-import is reserved
	// for the normalizePersisted-at-load-time tests above).
	beforeEach(() => {
		session.clearRun();
		session.clearAdmin();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const readRaw = () =>
		JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string) as Record<
			string,
			unknown
		>;

	it("startRun persists runId, accessCode, and startTime", () => {
		session.startRun({ runId: "run-1", accessCode: "ABCD12", startTime: 555 });

		expect(session.runId).toBe("run-1");
		expect(session.accessCode).toBe("ABCD12");
		expect(session.startTime).toBe(555);
		expect(readRaw()).toMatchObject({
			runId: "run-1",
			accessCode: "ABCD12",
			startTime: 555,
		});
	});

	it("startRun defaults startTime to now when omitted", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		session.startRun({ runId: "run-2", accessCode: "XYZ999" });

		expect(session.startTime).toBe(1_700_000_000_000);
		expect(readRaw().startTime).toBe(1_700_000_000_000);
	});

	it("setAdmin persists adminRole and adminEmail", () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.ADMIN,
			adminEmail: "admin@example.com",
		});

		expect(session.adminRole).toBe(ADMIN_ROLE.ADMIN);
		expect(session.adminEmail).toBe("admin@example.com");
		expect(readRaw()).toMatchObject({
			adminRole: ADMIN_ROLE.ADMIN,
			adminEmail: "admin@example.com",
		});
	});

	it("clearRun clears the run fields but preserves the admin fields", () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.SUPER,
			adminEmail: "super@example.com",
		});
		session.startRun({ runId: "run-3", accessCode: "CODE33" });

		session.clearRun();

		expect(session.runId).toBe("");
		expect(session.accessCode).toBe("");
		expect(session.startTime).toBeNull();
		expect(session.adminRole).toBe(ADMIN_ROLE.SUPER);
		expect(session.adminEmail).toBe("super@example.com");
		expect(readRaw()).toMatchObject({
			runId: "",
			accessCode: "",
			startTime: null,
			adminRole: ADMIN_ROLE.SUPER,
			adminEmail: "super@example.com",
		});
	});

	it("clearAdmin clears the admin fields but preserves the run fields", () => {
		session.setAdmin({
			adminRole: ADMIN_ROLE.SUPER,
			adminEmail: "super@example.com",
		});
		session.startRun({ runId: "run-4", accessCode: "CODE44" });

		session.clearAdmin();

		expect(session.adminRole).toBeNull();
		expect(session.adminEmail).toBe("");
		expect(session.runId).toBe("run-4");
		expect(session.accessCode).toBe("CODE44");
		expect(readRaw()).toMatchObject({
			adminRole: null,
			adminEmail: "",
			runId: "run-4",
			accessCode: "CODE44",
		});
	});

	it("setRunId writes through to sessionStorage", () => {
		session.setRunId("run-5");

		expect(session.runId).toBe("run-5");
		expect(readRaw().runId).toBe("run-5");
	});
});
