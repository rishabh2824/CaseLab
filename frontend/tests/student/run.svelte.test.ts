// run.svelte.ts uses `window.setTimeout`/`setInterval` directly (notes
// debounce, run-expiry watch) and relies on relative `fetch("/api/...")`
// URLs resolving against a real origin — both need a `window`/`location`,
// which is why this file is named `*.svelte.test.ts` rather than plain
// `*.test.ts`: per vite.config.ts's project split, that suffix (also what
// gets the Svelte compiler to process `$state` in this non-.svelte module)
// routes it to the jsdom-backed "client" project, not "server"/node.
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeContact,
	makeRunState,
	makeSharedFile,
	message,
} from "../support/fixtures.js";
import { server } from "../support/msw.js";

// A case with no configured duration keeps #ensureExpiryWatch's early-return
// branch active, so tests never touch `window.setInterval` incidentally —
// that behavior (auto-ending a run on expiry) is out of scope here.
const caseData = {
	id: 1,
	case_name: "Sterling Industries",
	brief: "Reduce office supply costs.",
	simulation_duration: null as number | null,
};

// RunStore is created fresh per /student mount via context (setRunStore),
// not a module singleton — so tests just need a fresh instance, with a
// fresh, empty-call-history `goto`/`toast` mock bound to whatever this
// import returns (still re-imported per test since `session` remains a
// module singleton these tests share/reset).
async function freshRun() {
	const { RunStore } = await import("../../src/lib/student/run.svelte.js");
	const { session } = await import("../../src/lib/session.svelte.js");
	const nav = await import("$app/navigation");
	const sonner = await import("svelte-sonner");
	return {
		run: new RunStore(),
		session,
		goto: vi.mocked(nav.goto),
		toast: vi.mocked(sonner.toast),
	};
}

// An SSE response body the test drives by hand (rather than a canned string
// or a fixed chunk/delay schedule), so mid-stream assertions land on an exact
// point in the sequence instead of racing a timer.
function manualSseStream() {
	const encoder = new TextEncoder();
	let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller;
		},
	});
	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		push(frame: string) {
			controllerRef.enqueue(encoder.encode(frame));
		},
		error(err: unknown) {
			controllerRef.error(err);
		},
		close() {
			controllerRef.close();
		},
	};
}

beforeEach(() => {
	vi.resetModules();
});

describe("startSession", () => {
	it("a successful POST populates raw, writes the session, and selects an active contact", async () => {
		const { run, session, goto } = await freshRun();
		server.use(
			http.post("*/api/simulations/start", () =>
				HttpResponse.json(
					makeRunState({
						run_id: "run-42",
						case: caseData,
						contacts: [makeContact({ id: "mary" })],
						active_persona_id: "mary",
					}),
				),
			),
		);

		await run.startSession("ACCESS1");

		expect(run.raw?.run_id).toBe("run-42");
		expect(session.runId).toBe("run-42");
		expect(session.accessCode).toBe("ACCESS1");
		expect(run.activeContactId).toBe("mary");
		expect(goto).not.toHaveBeenCalled();
	});

	it("a failed POST navigates home", async () => {
		const { run, goto } = await freshRun();
		server.use(
			http.post("*/api/simulations/start", () =>
				HttpResponse.json(
					{ detail: "Access code not found." },
					{ status: 404 },
				),
			),
		);

		await run.startSession("BADCODE");

		expect(run.raw).toBeNull();
		expect(goto).toHaveBeenCalledWith("/");
	});
});

describe("refresh", () => {
	it("a 404 clears the run id and starts a fresh session when an access code is still known", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "stale-run", accessCode: "ACCESS1" });
		server.use(
			http.get("*/api/simulations/stale-run", () =>
				HttpResponse.json({ detail: "Run not found." }, { status: 404 }),
			),
			http.post("*/api/simulations/start", () =>
				HttpResponse.json(
					makeRunState({
						run_id: "fresh-run",
						case: caseData,
						contacts: [makeContact({ id: "mary" })],
						active_persona_id: "mary",
					}),
				),
			),
		);

		await run.refresh("stale-run");

		// #handleExpired fires startSession without awaiting it, so the fresh
		// run only shows up once that fetch resolves.
		await vi.waitFor(() => expect(run.raw?.run_id).toBe("fresh-run"));
		expect(session.runId).toBe("fresh-run");
		expect(goto).not.toHaveBeenCalled();
	});

	it("a 404 with no known access code navigates home instead", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "stale-run", accessCode: "" });
		server.use(
			http.get("*/api/simulations/stale-run", () =>
				HttpResponse.json({ detail: "Run not found." }, { status: 404 }),
			),
		);

		await run.refresh("stale-run");

		expect(goto).toHaveBeenCalledWith("/");
		expect(session.runId).toBe("");
	});

	it("a non-404 error sets loadError instead of clearing the run", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
		server.use(
			http.get("*/api/simulations/run-1", () =>
				HttpResponse.json({ detail: "Server exploded." }, { status: 500 }),
			),
		);

		await run.refresh("run-1");

		expect(run.loadError).toBe("Server exploded.");
		expect(session.runId).toBe("run-1");
		expect(goto).not.toHaveBeenCalled();
	});
});

describe("sendMessage guards", () => {
	// Each guard test registers a counting handler for the message endpoint
	// (rather than no handler at all) so a broken guard shows up as a
	// deterministic assertion failure — a stray call would otherwise surface
	// as an unhandled rejection from MSW's onUnhandledRequest:"error" instead
	// of a clean test failure.
	async function setupAvailablePersona(
		run: Awaited<ReturnType<typeof freshRun>>["run"],
		session: Awaited<ReturnType<typeof freshRun>>["session"],
	) {
		session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
		run.raw = makeRunState({
			case: caseData,
			contacts: [
				makeContact({ id: "mary", available: true, chat_ended: false }),
			],
			active_persona_id: "mary",
		});
		run.activeContactId = "mary";
	}

	it("returns false and sends nothing when there is no run id", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		session.setRunId("");
		let calls = 0;
		server.use(
			http.post("*/api/simulations/:runId/message", () => {
				calls++;
				return new HttpResponse(null);
			}),
		);

		expect(run.sendMessage("hello")).toBe(false);
		expect(calls).toBe(0);
	});

	it("returns false and sends nothing when there is no active contact", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		run.activeContactId = null;
		let calls = 0;
		server.use(
			http.post("*/api/simulations/:runId/message", () => {
				calls++;
				return new HttpResponse(null);
			}),
		);

		expect(run.sendMessage("hello")).toBe(false);
		expect(calls).toBe(0);
	});

	it("returns false and sends nothing for an empty or whitespace-only message", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		let calls = 0;
		server.use(
			http.post("*/api/simulations/:runId/message", () => {
				calls++;
				return new HttpResponse(null);
			}),
		);

		expect(run.sendMessage("")).toBe(false);
		expect(run.sendMessage("   \n\t ")).toBe(false);
		expect(calls).toBe(0);
	});

	it("returns false and sends nothing while a send is already in flight", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		run.isSending = true;
		let calls = 0;
		server.use(
			http.post("*/api/simulations/:runId/message", () => {
				calls++;
				return new HttpResponse(null);
			}),
		);

		expect(run.sendMessage("hello")).toBe(false);
		expect(calls).toBe(0);
	});

	it("returns false and sends nothing when the active persona is unavailable", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		run.raw = makeRunState({
			case: caseData,
			contacts: [makeContact({ id: "mary", available: false })],
			active_persona_id: "mary",
		});
		run.activeContactId = "mary";
		let calls = 0;
		server.use(
			http.post("*/api/simulations/:runId/message", () => {
				calls++;
				return new HttpResponse(null);
			}),
		);

		expect(run.sendMessage("hello")).toBe(false);
		expect(calls).toBe(0);
	});

	it("returns false and sends nothing when the active persona's chat has ended", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		run.raw = makeRunState({
			case: caseData,
			contacts: [
				makeContact({ id: "mary", available: true, chat_ended: true }),
			],
			active_persona_id: "mary",
		});
		run.activeContactId = "mary";
		let calls = 0;
		server.use(
			http.post("*/api/simulations/:runId/message", () => {
				calls++;
				return new HttpResponse(null);
			}),
		);

		expect(run.sendMessage("hello")).toBe(false);
		expect(calls).toBe(0);
	});

	it("returns true when the message is accepted", async () => {
		const { run, session } = await freshRun();
		await setupAvailablePersona(run, session);
		server.use(
			http.post(
				"*/api/simulations/run-1/message",
				() =>
					new HttpResponse('event: done\ndata: {"reply":"hi"}\n\n', {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					}),
			),
		);

		expect(run.sendMessage("hello")).toBe(true);
		await vi.waitFor(() => expect(run.isSending).toBe(false));
	});
});

describe("streaming reconciliation", () => {
	async function setupTwoContacts(
		run: Awaited<ReturnType<typeof freshRun>>["run"],
		session: Awaited<ReturnType<typeof freshRun>>["session"],
	) {
		session.startRun({ runId: "run-1", accessCode: "ACCESS1" });
		run.raw = makeRunState({
			case: caseData,
			contacts: [
				makeContact({ id: "mary", name: "Mary", available: true }),
				makeContact({ id: "bob", name: "Bob", available: true }),
			],
			active_persona_id: "mary",
			histories: {
				mary: [message("user", "prior q"), message("assistant", "prior a")],
				bob: [message("user", "bob q"), message("assistant", "bob a")],
			},
		});
		run.activeContactId = "mary";
	}

	it("shows the optimistic user turn plus partial streamed text, composed on the persona's prior history", async () => {
		const { run, session } = await freshRun();
		await setupTwoContacts(run, session);
		const stream = manualSseStream();
		server.use(
			http.post("*/api/simulations/run-1/message", () => stream.response),
		);

		expect(run.sendMessage("New question")).toBe(true);
		stream.push('event: delta\ndata: {"text":"Hel"}\n\n');
		await vi.waitFor(() =>
			expect(run.streamingTurn?.messages.at(-1)?.content).toBe("Hel"),
		);

		expect(run.messagesByPersona.mary).toEqual([
			message("user", "prior q"),
			message("assistant", "prior a"),
			message("user", "New question"),
			{ role: "assistant", content: "Hel" },
		]);

		stream.push('event: done\ndata: {"reply":"Hel"}\n\n');
		stream.close();
		await vi.waitFor(() => expect(run.isSending).toBe(false));
	});

	it("a done frame's reply becomes the final assistant message, appended to the persona's prior history", async () => {
		// DoneFrame carries only `reply`, not a full history array (see
		// simulation_runtime.py's DoneFrame) -- the client appends it to the
		// prior history it already had, rather than trusting a server-sent
		// blob. This also covers `reply` differing from what streamed (e.g.
		// the backend's cleanReply stripping a leading speaker tag) -- the
		// committed text must be `reply`, not the raw streamed preview.
		const { run, session } = await freshRun();
		await setupTwoContacts(run, session);
		const stream = manualSseStream();
		server.use(
			http.post("*/api/simulations/run-1/message", () => stream.response),
		);

		run.sendMessage("New question");
		stream.push('event: delta\ndata: {"text":"[Mary] draft"}\n\n');
		await vi.waitFor(() => expect(run.streamingTurn).not.toBeNull());

		stream.push(
			'event: done\ndata: {"reply":"the canonical server reply"}\n\n',
		);
		stream.close();

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.serverHistories.mary).toEqual([
			message("user", "prior q"),
			message("assistant", "prior a"),
			message("user", "New question"),
			message("assistant", "the canonical server reply"),
		]);
	});

	it("commits the streamed text when the stream closes cleanly with no done frame", async () => {
		const { run, session } = await freshRun();
		await setupTwoContacts(run, session);
		const stream = manualSseStream();
		server.use(
			http.post("*/api/simulations/run-1/message", () => stream.response),
		);

		run.sendMessage("New question");
		stream.push('event: delta\ndata: {"text":"partial reply"}\n\n');
		await vi.waitFor(() =>
			expect(run.streamingTurn?.messages.at(-1)?.content).toBe("partial reply"),
		);
		// No `done` frame — the server just closes the connection.
		stream.close();

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.serverHistories.mary).toEqual([
			message("user", "prior q"),
			message("assistant", "prior a"),
			message("user", "New question"),
			message("assistant", "partial reply"),
		]);
		expect(run.streamingTurn).toBeNull();
	});

	it("an error frame keeps the user's turn, drops the assistant reply, and shows a toast", async () => {
		const { run, session, toast } = await freshRun();
		await setupTwoContacts(run, session);
		const stream = manualSseStream();
		server.use(
			http.post("*/api/simulations/run-1/message", () => stream.response),
		);

		run.sendMessage("New question");
		stream.push('event: delta\ndata: {"text":"partial"}\n\n');
		await vi.waitFor(() => expect(run.streamingTurn).not.toBeNull());
		stream.push('event: error\ndata: {"detail":"The model errored."}\n\n');
		stream.close();

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.serverHistories.mary).toEqual([
			message("user", "prior q"),
			message("assistant", "prior a"),
			message("user", "New question"),
		]);
		expect(run.streamingTurn).toBeNull();
		expect(toast).toHaveBeenCalledWith("The model errored.", {
			duration: 4000,
		});
	});

	// A mid-stream break (as opposed to a pre-stream rejection, covered by the
	// error-frame/ApiError tests elsewhere in this file) only happens after the
	// backend has already 200'd the request -- prepareTurn already persisted
	// the user's message, and its producer task keeps generating and
	// persisting the reply after a client disconnect regardless of whether
	// this stream is still being read (see services/simulation/stream.py).
	// So #runSend refetches instead of assuming the reply was lost: this pins
	// that recovery, not the old drop-the-reply fallback.
	it("recovers a stream break by refetching the run instead of dropping the reply", async () => {
		const { run, session, toast } = await freshRun();
		await setupTwoContacts(run, session);
		const stream = manualSseStream();
		server.use(
			http.post("*/api/simulations/run-1/message", () => stream.response),
		);
		const recovered = makeRunState({
			case: caseData,
			contacts: [
				makeContact({ id: "mary", name: "Mary", available: true }),
				makeContact({ id: "bob", name: "Bob", available: true }),
			],
			active_persona_id: "mary",
			histories: {
				// The producer finished and persisted the full turn server-side
				// during the disconnect, unseen by this client until the refetch.
				mary: [
					message("user", "prior q"),
					message("assistant", "prior a"),
					message("user", "New question"),
					message("assistant", "Recovered reply"),
				],
				bob: [message("user", "bob q"), message("assistant", "bob a")],
			},
		});
		server.use(
			http.get("*/api/simulations/run-1", () => HttpResponse.json(recovered)),
		);

		run.sendMessage("New question");
		stream.push('event: delta\ndata: {"text":"partial"}\n\n');
		await vi.waitFor(() => expect(run.streamingTurn).not.toBeNull());
		stream.error(new Error("connection reset"));

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.serverHistories.mary).toEqual([
			message("user", "prior q"),
			message("assistant", "prior a"),
			message("user", "New question"),
			message("assistant", "Recovered reply"),
		]);
		expect(run.streamingTurn).toBeNull();
		expect(toast).toHaveBeenCalledWith(
			"Connection interrupted. Reconnected to check for a reply.",
			{ duration: 4000 },
		);
	});

	it("does not let deltas for a persona switched away from overwrite the newly active persona's view", async () => {
		const { run, session } = await freshRun();
		await setupTwoContacts(run, session);
		const stream = manualSseStream();
		server.use(
			http.post("*/api/simulations/run-1/message", () => stream.response),
		);

		run.sendMessage("New question"); // sent to mary, the active contact
		stream.push('event: delta\ndata: {"text":"first chunk"}\n\n');
		await vi.waitFor(() =>
			expect(run.streamingTurn?.messages.at(-1)?.content).toBe("first chunk"),
		);

		const bobViewBeforeSwitch = run.messagesByPersona.bob;
		run.selectContact("bob"); // user looks away from mary mid-stream
		// #runSend accumulates deltas with `+=`, so this chunk is the
		// incremental piece, not the full text-so-far.
		stream.push('event: delta\ndata: {"text":", more"}\n\n');
		await vi.waitFor(() =>
			expect(run.streamingTurn?.messages.at(-1)?.content).toBe(
				"first chunk, more",
			),
		);

		// Bob's messages are untouched by mary's ongoing stream.
		expect(run.messagesByPersona.bob).toEqual(bobViewBeforeSwitch);
		expect(run.messagesByPersona.bob).toEqual(run.serverHistories.bob);

		stream.push('event: done\ndata: {"reply":"first chunk, more"}\n\n');
		stream.close();
		await vi.waitFor(() => expect(run.isSending).toBe(false));
	});

	it('marks the contact chat_ended, without a generic toast, when the send fails with code "conversation_ended"', async () => {
		// prepareTurn runs inside the SSE generator (services/simulation/stream.py's
		// streamMessage), so this arrives as a 200 + an "error" frame carrying
		// `code: "conversation_ended"` -- never a rejected fetch/JSON error response.
		const { run, session, toast } = await freshRun();
		await setupTwoContacts(run, session);
		server.use(
			http.post(
				"*/api/simulations/run-1/message",
				() =>
					new HttpResponse(
						'event: error\ndata: {"detail":"This conversation has ended.","code":"conversation_ended"}\n\n',
						{ status: 200, headers: { "Content-Type": "text/event-stream" } },
					),
			),
		);

		run.sendMessage("New question");
		await vi.waitFor(() => expect(run.isSending).toBe(false));

		const mary = run.raw?.contacts.find((c) => c.id === "mary");
		expect(mary?.chat_ended).toBe(true);
		expect(mary?.chat_end_reason).toBe("harassment");
		expect(toast).not.toHaveBeenCalled();
	});
});

describe("applyMeta", () => {
	function setupRaw(run: Awaited<ReturnType<typeof freshRun>>["run"]) {
		run.raw = makeRunState({
			case: caseData,
			contacts: [
				makeContact({ id: "mary", chat_ended: false, warning_count: 0 }),
			],
			active_persona_id: "mary",
			shared_files: [makeSharedFile({ file_id: "7", file_name: "budget.pdf" })],
		});
	}

	it("appends new contacts with available: true patched in", async () => {
		const { run } = await freshRun();
		setupRaw(run);

		run.applyMeta("mary", {
			new_contacts: [makeContact({ id: "bob", name: "Bob", available: false })],
			shared_files: [],
			chat_ended: false,
			chat_end_reason: null,
			warning_count: 0,
		});

		const bob = run.raw?.contacts.find((c) => c.id === "bob");
		expect(bob?.available).toBe(true);
	});

	it("ignores a contact id that is already present", async () => {
		const { run } = await freshRun();
		setupRaw(run);

		run.applyMeta("mary", {
			new_contacts: [makeContact({ id: "mary", name: "Renamed Mary" })],
			shared_files: [],
			chat_ended: false,
			chat_end_reason: null,
			warning_count: 0,
		});

		expect(run.raw?.contacts).toHaveLength(1);
		expect(run.raw?.contacts[0]?.name).not.toBe("Renamed Mary");
	});

	it("updates chat_ended/chat_end_reason/warning_count on the target contact only", async () => {
		const { run } = await freshRun();
		run.raw = makeRunState({
			case: caseData,
			contacts: [
				makeContact({ id: "mary", chat_ended: false, warning_count: 0 }),
				makeContact({ id: "bob", chat_ended: false, warning_count: 0 }),
			],
			active_persona_id: "mary",
		});

		run.applyMeta("mary", {
			new_contacts: [],
			shared_files: [],
			chat_ended: true,
			chat_end_reason: "harassment",
			warning_count: 2,
		});

		const mary = run.raw?.contacts.find((c) => c.id === "mary");
		const bob = run.raw?.contacts.find((c) => c.id === "bob");
		expect(mary).toMatchObject({
			chat_ended: true,
			chat_end_reason: "harassment",
			warning_count: 2,
		});
		expect(bob).toMatchObject({ chat_ended: false, warning_count: 0 });
	});

	it("appends new shared files", async () => {
		const { run } = await freshRun();
		setupRaw(run);

		run.applyMeta("mary", {
			new_contacts: [],
			shared_files: [makeSharedFile({ file_id: "9", file_name: "new.pdf" })],
			chat_ended: false,
			chat_end_reason: null,
			warning_count: 0,
		});

		expect(run.raw?.shared_files.map((f) => f.file_id)).toEqual(["7", "9"]);
	});

	it("de-duplicates a file id that is already listed", async () => {
		const { run } = await freshRun();
		setupRaw(run);

		run.applyMeta("mary", {
			new_contacts: [],
			shared_files: [
				makeSharedFile({ file_id: "7", file_name: "renamed.pdf" }),
			],
			chat_ended: false,
			chat_end_reason: null,
			warning_count: 0,
		});

		expect(run.raw?.shared_files).toHaveLength(1);
		expect(run.raw?.shared_files[0]?.file_name).toBe("budget.pdf");
	});
});

describe("notification diffing (#diffAndNotify, observed via the mocked toast)", () => {
	it("fires no toasts for the initial roster, exactly one for a later new contact and a later new file, and none for a repeat", async () => {
		const { run, toast } = await freshRun();
		server.use(
			http.post("*/api/simulations/start", () =>
				HttpResponse.json(
					makeRunState({
						run_id: "run-1",
						case: caseData,
						contacts: [makeContact({ id: "mary", name: "Mary" })],
						active_persona_id: "mary",
						shared_files: [],
					}),
				),
			),
		);
		await run.startSession("ACCESS1");
		expect(toast).not.toHaveBeenCalled();

		const bob = makeContact({ id: "bob", name: "Bob", role: "Analyst" });
		const newFile = makeSharedFile({ file_id: "9", file_name: "new.pdf" });
		run.applyMeta("mary", {
			new_contacts: [bob],
			shared_files: [newFile],
			chat_ended: false,
			chat_end_reason: null,
			warning_count: 0,
		});

		expect(toast).toHaveBeenCalledTimes(2);
		expect(toast).toHaveBeenCalledWith("New contact unlocked: Bob (Analyst)", {
			duration: 4000,
		});
		expect(toast).toHaveBeenCalledWith("File shared: new.pdf", {
			duration: 4000,
		});

		// The same contact/file showing up again must not re-notify.
		run.applyMeta("mary", {
			new_contacts: [bob],
			shared_files: [newFile],
			chat_ended: false,
			chat_end_reason: null,
			warning_count: 0,
		});
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
