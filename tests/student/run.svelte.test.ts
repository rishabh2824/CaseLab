// run.svelte.ts uses `window.setTimeout`/`setInterval` directly (notes debounce,
// run-expiry watch), which is why this file is named `*.svelte.test.ts` rather than plain
// `*.test.ts`: per vite.config.ts's project split, that suffix (also what gets the Svelte
// compiler to process runes in this non-.svelte module) routes it to the jsdom-backed
// "client" project, not "server"/node.

import { getFunctionName } from "convex/server";
import { toast } from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { session } from "../../src/lib/session.svelte.js";
import { RunStore } from "../../src/lib/student/run.svelte.js";
import {
	makeContact,
	makeRunState,
	makeSharedFile,
	message,
} from "../support/fixtures.js";

// startSession/sendMessage go through Convex mutations, and the run's live state
// (contacts, histories, ...) through a Convex query subscription -- both mocked here.
const mockClientMutation = vi.fn();
const mockClientQuery = vi.fn();

// A minimal, reactive-enough stand-in for convex-svelte's useQuery: entries are keyed by
// (function name, args) and re-read via a getter on every access, gated behind a $state
// version counter so changing an *existing* key's value later (simulating a live server
// push, same args as before) still invalidates anything derived from it -- a plain Map
// mutation alone wouldn't, since Svelte has no way to see inside a plain JS getter.
type FakeQueryEntry = { data?: unknown; error?: Error };
const fakeQueryData = new Map<string, FakeQueryEntry>();
let fakeQueryVersion = $state(0);

function fakeQueryKey(refName: string, args: unknown): string {
	return `${refName}::${JSON.stringify(args)}`;
}

function setFakeQuery(
	refName: string,
	args: unknown,
	entry: FakeQueryEntry,
): void {
	fakeQueryData.set(fakeQueryKey(refName, args), entry);
	fakeQueryVersion += 1;
}

function resetFakeQueries(): void {
	fakeQueryData.clear();
	fakeQueryVersion += 1;
}

const mockUseQuery = vi.fn();
mockUseQuery.mockImplementation((ref: unknown, argsOrFn: unknown) => ({
	get data() {
		void fakeQueryVersion;
		const args = typeof argsOrFn === "function" ? argsOrFn() : argsOrFn;
		if (args === "skip") return undefined;
		// biome-ignore lint/suspicious/noExplicitAny: ref's real type is a branded object convex/server owns
		return fakeQueryData.get(fakeQueryKey(getFunctionName(ref as any), args))
			?.data;
	},
	get error() {
		void fakeQueryVersion;
		const args = typeof argsOrFn === "function" ? argsOrFn() : argsOrFn;
		if (args === "skip") return undefined;
		// biome-ignore lint/suspicious/noExplicitAny: ref's real type is a branded object convex/server owns
		return fakeQueryData.get(fakeQueryKey(getFunctionName(ref as any), args))
			?.error;
	},
	isLoading: false,
	isStale: false,
}));

vi.mock("convex-svelte", () => ({
	getConvexClient: () => ({
		mutation: mockClientMutation,
		query: mockClientQuery,
	}),
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const GET_SIMULATION_STATE = "api/simulations:get";
const GET_PERSONA_HISTORY = "api/simulations:getPersonaHistory";
const GET_STREAMING_PREVIEW = "api/turn:getStreamingPreview";

// A case with no configured duration keeps #ensureExpiryWatch's early-return
// branch active, so tests never touch `window.setInterval` incidentally —
// that behavior (auto-ending a run on expiry) is out of scope here.
const caseData = {
	id: "case-1",
	case_name: "Sterling Industries",
	brief: "Reduce office supply costs.",
	simulation_duration: null as number | null,
};

// RunStore is created fresh per /student mount (createRunStore), not a module singleton --
// session IS a module singleton these tests share, reset via session.clearRun()/
// clearAdmin() in beforeEach below rather than vi.resetModules(): fakeQueryVersion above is a
// $state declared at this file's top level, which vi.resetModules() would NOT re-evaluate
// (only subsequently-imported modules get a fresh instance) -- reactivity across that boundary
// silently doesn't propagate, since a freshly re-imported run.svelte.ts would run under a
// different Svelte runtime instance than this file's own top-level $state. Every created
// RunStore is tracked and disposed in afterEach, so a stale instance's effects can't keep
// reacting to the next test's session changes.
const liveRuns: RunStore[] = [];
function freshRun() {
	const run = new RunStore();
	liveRuns.push(run);
	return {
		run,
		session,
		goto: vi.mocked(goto),
		toast: vi.mocked(toast),
	};
}

// Establishes a run whose active persona ("mary") is available, wired through the fake
// reactive query rather than a direct `run.raw = ...` assignment -- raw is now $derived,
// read-only, sourced from the (mocked) live subscription.
async function primeRun(
	run: Awaited<ReturnType<typeof freshRun>>["run"],
	session: Awaited<ReturnType<typeof freshRun>>["session"],
	overrides: Parameters<typeof makeRunState>[0] = {},
) {
	session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
	setFakeQuery(
		GET_SIMULATION_STATE,
		{ runId: "run-1" },
		{
			data: makeRunState({
				case: caseData,
				contacts: [makeContact({ id: "mary", chat_ended: false })],
				active_persona_id: "mary",
				...overrides,
			}),
		},
	);
	await vi.waitFor(() => expect(run.raw).not.toBeNull());
}

beforeEach(() => {
	session.clearRun();
	session.clearAdmin();
	mockClientMutation.mockReset();
	mockClientQuery.mockReset();
	mockUseQuery.mockClear();
	resetFakeQueries();
});

afterEach(() => {
	for (const run of liveRuns.splice(0)) run.destroy();
});

describe("startSession", () => {
	it("a successful call populates raw (via the live query), writes the session, and selects an active contact", async () => {
		const { run, session, goto } = await freshRun();
		mockClientMutation.mockResolvedValue(
			makeRunState({
				run_id: "run-42",
				case: caseData,
				contacts: [makeContact({ id: "mary" })],
				active_persona_id: "mary",
			}),
		);
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-42" },
			{
				data: makeRunState({
					run_id: "run-42",
					case: caseData,
					contacts: [makeContact({ id: "mary" })],
					active_persona_id: "mary",
				}),
			},
		);

		await run.startSession("ACCESS1");

		expect(session.runId).toBe("run-42");
		expect(session.accessCode).toBe("ACCESS1");
		await vi.waitFor(() => expect(run.raw?.run_id).toBe("run-42"));
		expect(run.activeContactId).toBe("mary");
		expect(goto).not.toHaveBeenCalled();
	});

	it("a failed call navigates home", async () => {
		const { run, goto } = await freshRun();
		mockClientMutation.mockRejectedValue(new Error("Invalid access code."));

		await run.startSession("BADCODE");

		expect(run.raw).toBeNull();
		expect(goto).toHaveBeenCalledWith("/");
	});
});

describe("session resume / live-query errors", () => {
	it("an expired run clears the run id and starts a fresh session when an access code is still known", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "stale-run", accessCode: "ACCESS1" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "stale-run" },
			{ error: new Error("Run not found.") },
		);
		mockClientMutation.mockResolvedValue(
			makeRunState({
				run_id: "fresh-run",
				case: caseData,
				contacts: [makeContact({ id: "mary" })],
				active_persona_id: "mary",
			}),
		);
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "fresh-run" },
			{
				data: makeRunState({
					run_id: "fresh-run",
					case: caseData,
					contacts: [makeContact({ id: "mary" })],
					active_persona_id: "mary",
				}),
			},
		);

		// #handleExpired fires startSession without awaiting it, so the fresh
		// run only shows up once that call resolves.
		await vi.waitFor(() => expect(run.raw?.run_id).toBe("fresh-run"));
		expect(session.runId).toBe("fresh-run");
		expect(goto).not.toHaveBeenCalled();
	});

	it("an expired run with no known access code navigates home instead", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "stale-run", accessCode: "" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "stale-run" },
			{ error: new Error("Run not found.") },
		);

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(session.runId).toBe("");
		void run;
	});

	it("a non-expiry error sets loadError instead of clearing the run", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ error: new Error("Server exploded.") },
		);

		await vi.waitFor(() => expect(run.loadError).toBe("Server exploded."));
		expect(session.runId).toBe("run-1");
		expect(goto).not.toHaveBeenCalled();
	});

	// REGRESSION: loadError used to only ever be set, never cleared, so a transient failure
	// (network blip, momentary server error) left the error banner up forever even after the
	// subscription went on to succeed.
	it("clears loadError once the live subscription recovers", async () => {
		const { run, session } = await freshRun();
		session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ error: new Error("Server exploded.") },
		);
		await vi.waitFor(() => expect(run.loadError).toBe("Server exploded."));

		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ data: makeRunState({ run_id: "run-1" }) },
		);

		await vi.waitFor(() => expect(run.loadError).toBe(""));
	});
});

describe("sendMessage guards", () => {
	it("returns false and sends nothing when there is no run id", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		session.setRunId("");

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	it("returns false and sends nothing when there is no active contact", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = null;

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	it("returns false and sends nothing for an empty or whitespace-only message", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";

		expect(run.sendMessage("")).toBe(false);
		expect(run.sendMessage("   \n\t ")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	it("returns false and sends nothing while a send is already in flight", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		run.isSending = true;

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	it("returns false and sends nothing when the active persona is unavailable", async () => {
		const { run, session } = await freshRun();
		// available_at far in the future -- elapsedMinutes stays ~0 for the test's real-time
		// duration (session.startTime defaults to "now"), so this persona never becomes
		// available. See fixtures.ts's makeContact comment for why not `available: false`.
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary", available_at: 9999 })],
		});
		run.activeContactId = "mary";

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	it("returns false and sends nothing when the active persona's chat has ended", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary", chat_ended: true })],
		});
		run.activeContactId = "mary";

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	it("returns true and calls the api/turn:start mutation when the message is accepted", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		mockClientMutation.mockResolvedValue(undefined);

		expect(run.sendMessage("hello")).toBe(true);
		await vi.waitFor(() => expect(mockClientMutation).toHaveBeenCalled());
		const [, args] = mockClientMutation.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(args).toEqual({
			runId: "run-1",
			personaId: "mary",
			message: "hello",
		});
	});
});

describe("sendMessage lifecycle", () => {
	it("isSending stays true through the user's own message landing, and only clears once the reply lands too", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [message("user", "prior q"), message("assistant", "prior a")] },
		);
		run.activeContactId = "mary";
		await vi.waitFor(() => expect(run.activeMessages).toHaveLength(2));
		mockClientMutation.mockResolvedValue(undefined);

		run.sendMessage("New question");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		// The mutation resolving alone must not clear isSending -- only a persisted reply
		// (reflected via the live query) does, since runTurn finishes asynchronously.
		await Promise.resolve();
		expect(run.isSending).toBe(true);

		// startTurn (services/turn.ts) persists the user's own message before runTurn ever
		// runs -- the live query reflects that first, with no reply yet. isSending must NOT
		// clear here: this is exactly the regression where the Send button read "Send"
		// instead of showing the typing indicator while the reply was still generating.
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{
				data: [
					message("user", "prior q"),
					message("assistant", "prior a"),
					message("user", "New question"),
				],
			},
		);
		await Promise.resolve();
		expect(run.isSending).toBe(true);

		// Simulate the turn completing server-side: the live query now also returns the
		// reply (applyDecisions/applyBoundary both insert exactly one assistant message).
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{
				data: [
					message("user", "prior q"),
					message("assistant", "prior a"),
					message("user", "New question"),
					message("assistant", "the reply"),
				],
			},
		);

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.activeMessages).toEqual([
			message("user", "prior q"),
			message("assistant", "prior a"),
			message("user", "New question"),
			message("assistant", "the reply"),
		]);
	});

	it("a rejected mutation (e.g. rate limited, conversation ended) clears isSending immediately and shows a toast", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		mockClientMutation.mockRejectedValue(
			new Error("This conversation has ended."),
		);

		run.sendMessage("hello");

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).toHaveBeenCalledWith("This conversation has ended.", {
			duration: 4000,
		});
	});

	it("streamingPreview surfaces the live streamingReplies row's text only while status is 'streaming'", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";

		expect(run.streamingPreview).toBeNull();

		setFakeQuery(
			GET_STREAMING_PREVIEW,
			{ runId: "run-1", personaId: "mary" },
			{ data: { status: "streaming", text: "Partial re" } },
		);
		await vi.waitFor(() => expect(run.streamingPreview).toBe("Partial re"));

		setFakeQuery(
			GET_STREAMING_PREVIEW,
			{ runId: "run-1", personaId: "mary" },
			{ data: { status: "done", text: "" } },
		);
		await vi.waitFor(() => expect(run.streamingPreview).toBeNull());
	});

	it("a failed runTurn (streamingReplies status 'error') clears isSending and toasts, instead of leaving it stuck forever", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		mockClientMutation.mockResolvedValue(undefined);

		run.sendMessage("hello");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		// runTurn's catch (services/turn.ts) marks the row "error" on any failure -- unlike a
		// synchronous startTurn rejection, this arrives asynchronously via the reactive
		// subscription, not a rejected mutation promise, since the mutation already resolved.
		setFakeQuery(
			GET_STREAMING_PREVIEW,
			{ runId: "run-1", personaId: "mary" },
			{ data: { status: "error", text: "" } },
		);

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.streamingPreview).toBeNull();
		expect(toast).toHaveBeenCalledWith(
			"Something went wrong generating a reply. Please resend your message.",
			{ duration: 4000 },
		);
	});
});

describe("notification diffing (#diffAndNotify, observed via the live query)", () => {
	it("fires no toasts for the initial roster, exactly one for a later new contact and a later new file, and none for a repeat", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session, { shared_files: [] });
		await vi.waitFor(() => expect(toast).not.toHaveBeenCalled());

		const bob = makeContact({ id: "bob", name: "Bob", role: "Analyst" });
		const newFile = makeSharedFile({ file_id: "9", file_name: "new.pdf" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{
				data: makeRunState({
					case: caseData,
					contacts: [makeContact({ id: "mary", chat_ended: false }), bob],
					active_persona_id: "mary",
					shared_files: [newFile],
				}),
			},
		);

		await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
		expect(toast).toHaveBeenCalledWith("New contact unlocked: Bob (Analyst)", {
			duration: 4000,
		});
		expect(toast).toHaveBeenCalledWith("File shared: new.pdf", {
			duration: 4000,
		});

		// The same contact/file showing up again -- via an entirely unrelated query (this
		// persona's history is its own subscription now, see #historyQuery's comment)
		// changing -- must not re-notify.
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [message("user", "hi")] },
		);
		await vi.waitFor(() => expect(run.activeMessages).toHaveLength(1));
		expect(toast).toHaveBeenCalledTimes(2);
	});
});

// Notes are client-side only (sessionStorage, keyed by run id) — see
// run.svelte.ts's comment on NOTES_STORAGE_PREFIX for why: autosaving them
// through the backend used to take the simulations row's write lock on every
// debounced keystroke, contending with reply persistence.
const notesKey = (runId: string) => `caselab:notes:${runId}`;

describe("notes", () => {
	// jsdom's Storage implementation doesn't go through overridable prototype
	// methods (vi.spyOn(Storage.prototype/sessionStorage, "setItem") silently
	// never fires here), so these observe the actually-stored value instead
	// of counting calls.
	it("setNotes debounces: no write before the debounce elapses, written after", async () => {
		vi.useFakeTimers();
		try {
			const { run, session } = await freshRun();
			session.startRun({ runId: "run-1", accessCode: "ACCESS1" });

			run.setNotes("draft text");
			await vi.advanceTimersByTimeAsync(700);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBeNull();
			await vi.advanceTimersByTimeAsync(150); // crosses the 800ms debounce
			expect(sessionStorage.getItem(notesKey("run-1"))).toBe("draft text");
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushNotes bypasses the debounce and cancels the pending timer so it does not fire again later", async () => {
		vi.useFakeTimers();
		try {
			const { run, session } = await freshRun();
			session.startRun({ runId: "run-1", accessCode: "ACCESS1" });

			run.setNotes("draft 1");
			run.setNotes("draft 2");
			run.flushNotes();
			expect(sessionStorage.getItem(notesKey("run-1"))).toBe("draft 2");

			// Mutate the in-memory value directly, bypassing setNotes (so no new
			// timer gets scheduled) — if the original debounce timer from
			// setNotes("draft 2") weren't cancelled by flushNotes, it would fire
			// here and write this stale value to storage.
			run.notes = "mutated after flush";
			await vi.advanceTimersByTimeAsync(1000);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBe("draft 2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a storage write failure does not throw or show a toast", async () => {
		const { run, session, toast } = await freshRun();
		session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
		vi.stubGlobal("sessionStorage", {
			setItem: () => {
				throw new DOMException("Quota exceeded.");
			},
			getItem: () => null,
			removeItem: () => {},
		});

		run.setNotes("draft text");
		expect(() => run.flushNotes()).not.toThrow();
		expect(toast).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});
});

describe("endSimulation", () => {
	it("cancels any pending save, clears stored notes, clears the run, and navigates home", async () => {
		vi.useFakeTimers();
		try {
			const { run, session, goto } = await freshRun();
			session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
			sessionStorage.setItem(notesKey("run-1"), "earlier session");

			run.setNotes("final thoughts"); // schedules a debounced write, never flushed
			run.endSimulation();

			expect(session.runId).toBe("");
			expect(goto).toHaveBeenCalledWith("/");
			// A finished run has nothing left to read its notes back — cleared
			// outright rather than flushed first.
			expect(sessionStorage.getItem(notesKey("run-1"))).toBeNull();

			// If the pending debounced write from setNotes() above weren't
			// cancelled, it would fire here and resurrect the just-cleared entry.
			await vi.advanceTimersByTimeAsync(1000);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a run that expires while a message is in flight", () => {
	// #handleExpired resets activeContactId, notes and the run id, but not the send guard.
	// Both effects that clear isSending are scoped to `personaId === activeContactId`, so once
	// expiry nulls activeContactId neither can ever fire again -- and #handleExpired immediately
	// starts a REPLACEMENT run from the stored access code. The student lands in a working new
	// simulation with the composer permanently disabled, and the only way out is a full reload.
	it("REGRESSION: clears isSending so the replacement run's composer is usable", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [] },
		);
		mockClientMutation.mockResolvedValue(undefined);

		expect(run.sendMessage("are you there?")).toBe(true);
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		// The run expires mid-turn; the store auto-starts a fresh one from the access code.
		mockClientMutation.mockResolvedValue(
			makeRunState({
				run_id: "run-2",
				case: caseData,
				contacts: [makeContact({ id: "mary" })],
				active_persona_id: "mary",
			}),
		);
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ error: new Error("Run expired.") },
		);
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-2" },
			{
				data: makeRunState({
					run_id: "run-2",
					case: caseData,
					contacts: [makeContact({ id: "mary" })],
					active_persona_id: "mary",
				}),
			},
		);

		await vi.waitFor(() => expect(session.runId).toBe("run-2"));
		await vi.waitFor(() => expect(run.isSending).toBe(false));
	});

	it("REGRESSION: accepts a new message in the replacement run", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [] },
		);
		mockClientMutation.mockResolvedValue(undefined);
		run.sendMessage("first");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		mockClientMutation.mockResolvedValue(
			makeRunState({
				run_id: "run-2",
				case: caseData,
				contacts: [makeContact({ id: "mary" })],
				active_persona_id: "mary",
			}),
		);
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ error: new Error("Run expired.") },
		);
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-2" },
			{
				data: makeRunState({
					run_id: "run-2",
					case: caseData,
					contacts: [makeContact({ id: "mary" })],
					active_persona_id: "mary",
				}),
			},
		);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-2", personaId: "mary" },
			{ data: [] },
		);
		await vi.waitFor(() => expect(run.activeContactId).toBe("mary"));

		mockClientMutation.mockResolvedValue(undefined);
		await vi.waitFor(() => expect(run.sendMessage("second")).toBe(true));
	});
});

describe("hostile and degenerate client-side send guards", () => {
	// The client trims exactly like startTurn does (services/turn.ts) and otherwise sends the
	// text through untouched. Any other reshaping -- truncating, collapsing whitespace,
	// normalizing unicode -- would let the client's word count disagree with the server's, so
	// the Send button could enable a message the backend then rejects (or vice versa).
	it("trims exactly like the server and otherwise sends unicode and newlines untouched", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		mockClientMutation.mockResolvedValue(undefined);
		const typed = "  Café ☕\nQ3 — 40 % ↑ 🙂  ";

		expect(run.sendMessage(typed)).toBe(true);

		await vi.waitFor(() =>
			expect(mockClientMutation).toHaveBeenCalledWith(expect.anything(), {
				runId: "run-1",
				personaId: "mary",
				message: typed.trim(),
			}),
		);
	});

	// Rapid double-click / Enter-mashing: only the first send may reach the backend.
	it("collapses a burst of sends into exactly one mutation", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		mockClientMutation.mockResolvedValue(undefined);

		const accepted = [
			run.sendMessage("one"),
			run.sendMessage("two"),
			run.sendMessage("three"),
		];

		expect(accepted).toEqual([true, false, false]);
		await vi.waitFor(() => expect(mockClientMutation).toHaveBeenCalledTimes(1));
	});

	it("refuses to send to a contact whose chat has already ended", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary", chat_ended: true })],
		});
		run.activeContactId = "mary";

		expect(run.sendMessage("hello?")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});
});
