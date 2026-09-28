import { getFunctionName } from "convex/server";
import { toast } from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { STUDENT_ERROR } from "../../convex/lib/studentErrors.js";
import { session } from "../../src/lib/session.svelte.js";
import { RunStore } from "../../src/lib/student/run.svelte.js";
import {
	clientServerError,
	clientStudentError,
} from "../support/convexClientErrors.js";
import {
	makeContact,
	makeRunState,
	makeSharedFile,
	message,
} from "../support/fixtures.js";

const mockClientMutation = vi.fn();
const mockClientQuery = vi.fn();

type FakeQueryEntry = { data?: unknown; error?: Error };
const fakeQueryData = new Map<string, FakeQueryEntry>();
let fakeQueryVersion = $state(0);

// Builds the key for a fake query result from its name and arguments.
function fakeQueryKey(refName: string, args: unknown): string {
	return `${refName}::${JSON.stringify(args)}`;
}

// Sets a fake query result and notifies subscribers.
function setFakeQuery(
	refName: string,
	args: unknown,
	entry: FakeQueryEntry,
): void {
	fakeQueryData.set(fakeQueryKey(refName, args), entry);
	fakeQueryVersion += 1;
}

// Clears all fake query results.
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
const GET_TURN_STREAM = "api/turn:getTurnStream";

// Sets the fake turn stream query result for the active persona.
function setTurn(
	turn: Partial<{
		streamId: string;
		status: string;
		settled: boolean;
		claimable: boolean;
		text: string;
	}>,
	withText = true,
): void {
	setFakeQuery(
		GET_TURN_STREAM,
		{ runId: "run-1", personaId: "mary", withText },
		{
			data: {
				streamId: "s1",
				settled: false,
				claimable: false,
				text: "",
				...turn,
			},
		},
	);
}

const caseData = {
	id: "case-1",
	case_name: "Sterling Industries",
	brief: "Reduce office supply costs.",
	simulation_duration: null as number | null,
};

const liveRuns: RunStore[] = [];
// Creates a RunStore and returns it with the session and the mocked goto and toast.
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

// Starts a run in the session and seeds the fake state query with a run state.
async function primeRun(
	run: Awaited<ReturnType<typeof freshRun>>["run"],
	session: Awaited<ReturnType<typeof freshRun>>["session"],
	overrides: Parameters<typeof makeRunState>[0] = {},
) {
	session.startRun({ runId: "run-1" });
	setFakeQuery(
		GET_SIMULATION_STATE,
		{ runId: "run-1" },
		{
			data: makeRunState({
				case: caseData,
				contacts: [makeContact({ id: "mary", chat_ended: false })],
				...overrides,
			}),
		},
	);
	await vi.waitFor(() => expect(run.raw).not.toBeNull());
}

beforeEach(() => {
	session.clearRun();
	mockClientMutation.mockReset();
	mockClientQuery.mockReset();
	mockUseQuery.mockClear();
	resetFakeQueries();
});

afterEach(() => {
	for (const run of liveRuns.splice(0)) run.destroy();
	vi.unstubAllGlobals();
});

describe("init", () => {
	// Tests that a run already in the session is left alone.
	it("resumes a persisted run without starting anything", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1" });

		run.init();

		expect(goto).not.toHaveBeenCalled();
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// A simulation that has ended stays ended: with no run to resume the student goes home,
	// and nothing starts a new one behind their back.
	it("goes home, without starting a new run, when there is no run to resume", async () => {
		const { run, session, goto } = await freshRun();

		run.init();

		expect(goto).toHaveBeenCalledWith("/");
		expect(mockClientMutation).not.toHaveBeenCalled();
		expect(session.runId).toBe("");
	});
});

describe("which persona is selected", () => {
	// Tests that the default selection skips a contact who is not yet available.
	it("defaults to the first contact that's actually available, skipping one that isn't yet", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [
				makeContact({ id: "later", available_at: 999 }),
				makeContact({ id: "mary" }),
			],
		});

		await vi.waitFor(() => expect(run.activeContactId).toBe("mary"));
	});

	// Tests that the last selected persona is restored, e.g. after a reload.
	it("restores the persona the student last selected, e.g. after a reload", async () => {
		const { run, session } = await freshRun();
		session.startRun({ runId: "run-1" });
		session.setActivePersona("bob");
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{
				data: makeRunState({
					case: caseData,
					contacts: [makeContact({ id: "mary" }), makeContact({ id: "bob" })],
				}),
			},
		);

		await vi.waitFor(() => expect(run.activeContactId).toBe("bob"));
	});

	// Tests that a remembered persona no longer in the run is ignored.
	it("ignores a remembered persona that's no longer in the run", async () => {
		const { run, session } = await freshRun();
		session.startRun({ runId: "run-1" });
		session.setActivePersona("gone");
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{
				data: makeRunState({
					case: caseData,
					contacts: [makeContact({ id: "mary" })],
				}),
			},
		);

		await vi.waitFor(() => expect(run.activeContactId).toBe("mary"));
	});

	// Tests that a selection is remembered in the session and forgotten along with the run.
	it("remembers a selection in the session, and forgets it with the run", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary" }), makeContact({ id: "bob" })],
		});
		await vi.waitFor(() => expect(run.activeContactId).toBe("mary"));

		run.selectContact("bob");

		expect(session.activePersonaId).toBe("bob");
		expect(
			JSON.parse(sessionStorage.getItem("caseLabSession") ?? "{}"),
		).toMatchObject({ activePersonaId: "bob" });

		session.clearRun();
		expect(session.activePersonaId).toBe("");
	});
});

describe("session resume / live-query errors", () => {
	// Tests that a run-not-found or run-expired error sends the student home without starting a new run.
	it.each([
		[STUDENT_ERROR.RUN_NOT_FOUND, "Run not found."],
		[STUDENT_ERROR.RUN_EXPIRED, "Run expired."],
	] as const)(
		"a %s error sends the student home without starting a new run",
		async (code, text) => {
			const { session, goto } = await freshRun();
			session.startRun({ runId: "stale-run" });
			sessionStorage.setItem(notesKey("stale-run"), "my notes");
			setFakeQuery(
				GET_SIMULATION_STATE,
				{ runId: "stale-run" },
				{ error: clientStudentError("api/simulations:get", code, text, "Q") },
			);

			await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
			expect(session.runId).toBe("");
			expect(sessionStorage.getItem(notesKey("stale-run"))).toBeNull();
			expect(mockClientMutation).not.toHaveBeenCalled();
		},
	);

	// Tests that an unrelated error sets loadError instead of clearing the run.
	it("a non-expiry error sets loadError instead of clearing the run", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ error: clientServerError("api/simulations:get", "Q") },
		);

		await vi.waitFor(() =>
			expect(run.loadError).toBe("Failed to load the simulation."),
		);
		expect(session.runId).toBe("run-1");
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that a deliberate student error's own message is shown as loadError.
	it("shows a deliberate student error's own message as loadError", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{
				error: clientStudentError(
					"api/simulations:get",
					STUDENT_ERROR.CASE_NOT_FOUND,
					"Case not found.",
					"Q",
				),
			},
		);

		await vi.waitFor(() => expect(run.loadError).toBe("Case not found."));
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that loadError clears once the live subscription recovers.
	it("clears loadError once the live subscription recovers", async () => {
		const { run, session } = await freshRun();
		session.startRun({ runId: "run-1" });
		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ error: clientServerError("api/simulations:get", "Q") },
		);
		await vi.waitFor(() => expect(run.loadError).not.toBe(""));

		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{ data: makeRunState({ run_id: "run-1" }) },
		);

		await vi.waitFor(() => expect(run.loadError).toBe(""));
	});
});

describe("sendMessage guards", () => {
	// Tests that sendMessage returns false and sends nothing without a run id.
	it("returns false and sends nothing when there is no run id", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		session.setRunId("");

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing without an active contact.
	it("returns false and sends nothing when there is no active contact", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = null;

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing for an empty or whitespace-only message.
	it("returns false and sends nothing for an empty or whitespace-only message", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";

		expect(run.sendMessage("")).toBe(false);
		expect(run.sendMessage("   \n\t ")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing while a send is in flight.
	it("returns false and sends nothing while a send is already in flight", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		run.isSending = true;

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing when the active persona is unavailable.
	it("returns false and sends nothing when the active persona is unavailable", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary", available_at: 9999 })],
		});
		run.activeContactId = "mary";

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing when the persona's chat has ended.
	it("returns false and sends nothing when the active persona's chat has ended", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary", chat_ended: true })],
		});
		run.activeContactId = "mary";

		expect(run.sendMessage("hello")).toBe(false);
		expect(mockClientMutation).not.toHaveBeenCalled();
	});

	// Tests that an accepted message returns true and calls the api/turn:start mutation.
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
	// Tests that isSending stays true until the sent turn settles, regardless of how many messages it adds.
	it("isSending stays true until the sent turn settles, however many messages that adds to the history", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [message("user", "prior q"), message("assistant", "prior a")] },
		);
		setTurn({ streamId: "old", status: "done", settled: true });
		run.activeContactId = "mary";
		await vi.waitFor(() => expect(run.activeMessages).toHaveLength(2));
		mockClientMutation.mockResolvedValue(undefined);

		run.sendMessage("New question");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		await Promise.resolve();
		expect(run.isSending).toBe(true);

		setTurn({ streamId: "new", status: "streaming", text: "The rep" });
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

		setTurn({ streamId: "new", status: "done", settled: true });
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
		expect(run.activeMessages).toHaveLength(4);
	});

	// Tests that a boundary reply clears isSending even though it adds only one message.
	it("clears isSending after a boundary reply, though it adds only one message to the history", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [] },
		);
		run.activeContactId = "mary";
		mockClientMutation.mockResolvedValue(undefined);

		run.sendMessage("asdf asdf asdf");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		setTurn({ status: "streaming" });
		setTurn({ status: "done", settled: true });
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [message("assistant", "I am not able to follow that.")] },
		);

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).not.toHaveBeenCalled();
		expect(run.sendMessage("a real question")).toBe(true);
	});

	// Tests that a rejected mutation clears isSending immediately and shows a toast.
	it("a rejected mutation (e.g. rate limited, conversation ended) clears isSending immediately and shows a toast", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		mockClientMutation.mockRejectedValue(
			clientStudentError(
				"api/turn:start",
				STUDENT_ERROR.CONVERSATION_ENDED,
				"This conversation has ended.",
			),
		);

		run.sendMessage("hello");

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).toHaveBeenCalledWith("This conversation has ended.", {
			duration: 4000,
		});
	});

	// Tests that a real server error shows a generic toast rather than the client's wrapper text.
	it("shows a generic toast, not the client's wrapper text, when the server hit a real error", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		mockClientMutation.mockRejectedValue(clientServerError("api/turn:start"));

		run.sendMessage("hello");

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).toHaveBeenCalledWith("Message failed. Please try again.", {
			duration: 4000,
		});
	});

	// Tests that streamingPreview shows an undriven turn's persisted text and clears once it settles.
	it("streamingPreview shows an undriven turn's persisted text, and clears once the turn settles", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";

		expect(run.streamingPreview).toBeNull();

		setTurn({ status: "streaming", text: "Partial re" });
		await vi.waitFor(() => expect(run.streamingPreview).toBe("Partial re"));

		setTurn({ status: "streaming", text: "Partial re", settled: true });
		await vi.waitFor(() => expect(run.streamingPreview).toBeNull());
	});

	// Tests that a claimable turn is streamed exactly once and the reply shows as it streams.
	it("drives a claimable turn over /turn-stream exactly once and shows the reply as it streams", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		const body = new TransformStream<Uint8Array, Uint8Array>();
		const writer = body.writable.getWriter();
		const fetchMock = vi.fn(async () => new Response(body.readable));
		vi.stubGlobal("fetch", fetchMock);

		setTurn({ status: "pending", claimable: true });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringMatching(/\.convex\.site\/turn-stream$/),
			{ method: "POST", body: JSON.stringify({ streamId: "s1" }) },
		);

		setTurn({ status: "streaming" }, false);
		const encoder = new TextEncoder();
		await writer.write(encoder.encode("Hel"));
		await vi.waitFor(() => expect(run.streamingPreview).toBe("Hel"));
		await writer.write(encoder.encode("lo."));
		await vi.waitFor(() => expect(run.streamingPreview).toBe("Hello."));

		setTurn({ status: "done", settled: true }, false);
		await vi.waitFor(() => expect(run.streamingPreview).toBeNull());
		await writer.close();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// Tests that the persisted reply is used when another tab claimed the turn first.
	it("falls back to the persisted copy when another tab claimed the turn first", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		const fetchMock = vi.fn(async () => new Response(null, { status: 409 }));
		vi.stubGlobal("fetch", fetchMock);

		setTurn({ status: "pending", claimable: true });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		setTurn({ status: "streaming", text: "From the other tab" });
		await vi.waitFor(() =>
			expect(run.streamingPreview).toBe("From the other tab"),
		);
	});

	// Tests that a failed stream clears isSending and toasts instead of leaving it stuck.
	it("a failed turn (stream status 'error') clears isSending and toasts, instead of leaving it stuck forever", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		mockClientMutation.mockResolvedValue(undefined);

		run.sendMessage("hello");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		setTurn({ status: "error" });

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.streamingPreview).toBeNull();
		expect(toast).toHaveBeenCalledWith(
			"Something went wrong generating a reply. Please resend your message.",
			{ duration: 4000 },
		);
	});

	// Tests that the previous turn's error is not mistaken for the new send failing.
	it("does not mistake the previous turn's error for the new send failing", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		setTurn({ streamId: "old", status: "error" });
		await vi.waitFor(() => expect(run.streamingPreview).toBeNull());
		mockClientMutation.mockResolvedValue(undefined);

		run.sendMessage("hello again");
		await vi.waitFor(() => expect(mockClientMutation).toHaveBeenCalled());
		await Promise.resolve();

		expect(run.isSending).toBe(true);
		expect(toast).not.toHaveBeenCalled();
	});
});

describe("notification diffing (#diffAndNotify, observed via the live query)", () => {
	// Tests that toasts fire only for new contacts and files after the initial roster, and never for repeats.
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

		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [message("user", "hi")] },
		);
		await vi.waitFor(() => expect(run.activeMessages).toHaveLength(1));
		expect(toast).toHaveBeenCalledTimes(2);
	});
});

// Returns the sessionStorage key a run's notes are stored under.
const notesKey = (runId: string) => `caselab:notes:${runId}`;

describe("notes", () => {
	// Tests that setNotes debounces its write to storage.
	it("setNotes debounces: no write before the debounce elapses, written after", async () => {
		vi.useFakeTimers();
		try {
			const { run, session } = await freshRun();
			session.startRun({ runId: "run-1" });

			run.setNotes("draft text");
			await vi.advanceTimersByTimeAsync(700);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBeNull();
			await vi.advanceTimersByTimeAsync(150);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBe("draft text");
		} finally {
			vi.useRealTimers();
		}
	});

	// Tests that flushNotes writes immediately and cancels the pending debounce timer.
	it("flushNotes bypasses the debounce and cancels the pending timer so it does not fire again later", async () => {
		vi.useFakeTimers();
		try {
			const { run, session } = await freshRun();
			session.startRun({ runId: "run-1" });

			run.setNotes("draft 1");
			run.setNotes("draft 2");
			run.flushNotes();
			expect(sessionStorage.getItem(notesKey("run-1"))).toBe("draft 2");

			run.notes = "mutated after flush";
			await vi.advanceTimersByTimeAsync(1000);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBe("draft 2");
		} finally {
			vi.useRealTimers();
		}
	});

	// Tests that a storage write failure neither throws nor shows a toast.
	it("a storage write failure does not throw or show a toast", async () => {
		const { run, session, toast } = await freshRun();
		session.startRun({ runId: "run-1" });
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
	// Tests that endSimulation cancels the pending save, clears notes and the run, and navigates home.
	it("cancels any pending save, clears stored notes, clears the run, and navigates home", async () => {
		vi.useFakeTimers();
		try {
			const { run, session, goto } = await freshRun();
			session.startRun({ runId: "run-1" });
			sessionStorage.setItem(notesKey("run-1"), "earlier session");

			run.setNotes("final thoughts");
			run.endSimulation();

			expect(session.runId).toBe("");
			expect(goto).toHaveBeenCalledWith("/");
			expect(sessionStorage.getItem(notesKey("run-1"))).toBeNull();

			await vi.advanceTimersByTimeAsync(1000);
			expect(sessionStorage.getItem(notesKey("run-1"))).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a run that expires while a message is in flight", () => {
	// Tests that a run expiring while a message is in flight sends the student home without a replacement run.
	it("sends the student home instead of starting a replacement run", async () => {
		const { run, session, goto } = await freshRun();
		await primeRun(run, session);
		setFakeQuery(
			GET_PERSONA_HISTORY,
			{ runId: "run-1", personaId: "mary" },
			{ data: [] },
		);
		mockClientMutation.mockResolvedValue(undefined);

		expect(run.sendMessage("are you there?")).toBe(true);
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		setFakeQuery(
			GET_SIMULATION_STATE,
			{ runId: "run-1" },
			{
				error: clientStudentError(
					"api/simulations:get",
					STUDENT_ERROR.RUN_EXPIRED,
					"Run expired.",
					"Q",
				),
			},
		);

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(session.runId).toBe("");
		expect(mockClientMutation).toHaveBeenCalledTimes(1);
	});
});

describe("run-level time expiry", () => {
	// Tests that run-level time expiry disables messaging in place rather than navigating away.
	it("disables messaging in place instead of navigating away", async () => {
		vi.useFakeTimers();
		try {
			const { run, session, goto } = await freshRun();
			await primeRun(run, session, {
				case: { ...caseData, simulation_duration: 1 },
			});

			expect(run.timeExpired).toBe(false);
			expect(run.activePersonaAvailable).toBe(true);

			await vi.advanceTimersByTimeAsync(60_000);

			expect(run.timeExpired).toBe(true);
			expect(run.activePersonaAvailable).toBe(false);
			expect(run.sendMessage("are you there?")).toBe(false);
			expect(mockClientMutation).not.toHaveBeenCalled();
			expect(session.runId).toBe("run-1");
			expect(goto).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// Tests that the student goes home once the grace period ends, without a new run.
	it("goes home once the grace period actually expires, without starting a new run", async () => {
		vi.useFakeTimers();
		try {
			const { run, session, goto } = await freshRun();
			await primeRun(run, session, {
				case: { ...caseData, simulation_duration: 1 },
			});
			await vi.advanceTimersByTimeAsync(60_000);
			expect(run.timeExpired).toBe(true);
			expect(goto).not.toHaveBeenCalled();

			setFakeQuery(
				GET_SIMULATION_STATE,
				{ runId: "run-1" },
				{
					error: clientStudentError(
						"api/simulations:get",
						STUDENT_ERROR.RUN_NOT_FOUND,
						"Run not found.",
						"Q",
					),
				},
			);

			await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
			expect(session.runId).toBe("");
			expect(mockClientMutation).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("hostile and degenerate client-side send guards", () => {
	// Tests that messages are trimmed like the server does while unicode and newlines are sent untouched.
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

	// Tests that a burst of sends collapses into exactly one mutation.
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

	// Tests that sending to a contact whose chat has ended is refused.
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
