import { getFunctionName } from "convex/server";
import { flushSync, tick } from "svelte";
import { toast } from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { STUDENT_ERROR } from "../../convex/lib/studentErrors.js";
import { session } from "../../src/lib/session.svelte.js";
import { RunStore } from "../../src/lib/student/run.svelte.js";
import {
	clientServerError,
	clientStudentError,
} from "../support/convexClientErrors.js";
import { convexFake, type QueryState } from "../support/convexFake.svelte.js";
import {
	makeContact,
	makeRunState,
	makeSharedFile,
	message,
} from "../support/factories.js";

const sendMessage = convexFake.mutation(api.turn.sendMessage);
const GET_STATE = getFunctionName(api.simulations.get);
const SEND_MESSAGE = getFunctionName(api.turn.sendMessage);

type RunStateQuery = QueryState<typeof api.simulations.get>;

// Sets the state query for a run. The fixture uses plain string ids, so its data is branded here.
function setRunQuery(
	args: { runId: string },
	entry: { data?: ReturnType<typeof makeRunState>; error?: Error },
): void {
	convexFake.setQuery(
		api.simulations.get,
		args as { runId: Id<"runs"> },
		entry as RunStateQuery,
	);
}

// Lets pending reactive effects run, so a "nothing happened" assertion is made after they had the chance to.
async function settle(): Promise<void> {
	await tick();
	flushSync();
}

function setHistory(
	personaId: string,
	messages: ReturnType<typeof message>[] = [],
	reply: { id: string; status: "pending" | "done" | "failed" } | null = null,
): void {
	convexFake.setQuery(
		api.simulations.getPersonaHistory,
		{ runId: "run-1" as Id<"runs">, personaId },
		{
			data: {
				messages,
				reply: reply && { ...reply, id: reply.id as Id<"runMessages"> },
			},
		},
	);
}

const caseData = {
	id: "case-1",
	caseName: "Sterling Industries",
	brief: "Reduce office supply costs.",
	simulationDuration: null as number | null,
	authors: ["Olive Owner"],
};

const disposers: (() => void)[] = [];
// Creates a RunStore inside an effect root, as a component would, and returns it with the session and the mocked goto and toast.
function freshRun() {
	let run!: RunStore;
	disposers.push(
		$effect.root(() => {
			run = new RunStore();
		}),
	);
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
	setRunQuery(
		{ runId: "run-1" },
		{
			data: makeRunState({
				case: caseData,
				contacts: [makeContact({ id: "mary", chatEnded: false })],
				...overrides,
			}),
		},
	);
	await vi.waitFor(() => expect(run.raw).not.toBeNull());
}

beforeEach(() => {
	session.clearRun();
	sendMessage.mockResolvedValue({ replyId: "r1" as Id<"runMessages"> });
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

describe("init", () => {
	// Tests that a run already in the session is left alone.
	it("resumes a persisted run without starting anything", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1" });

		run.init();

		expect(goto).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// A simulation that has ended stays ended: with no run to resume the student goes home,
	// and nothing starts a new one behind their back.
	it("goes home, without starting a new run, when there is no run to resume", async () => {
		const { run, session, goto } = await freshRun();

		run.init();

		expect(goto).toHaveBeenCalledWith("/");
		expect(sendMessage).not.toHaveBeenCalled();
		expect(session.runId).toBe("");
	});
});

describe("which persona is selected", () => {
	// Tests that the default selection skips a contact who is not yet available.
	it("defaults to the first contact that's actually available, skipping one that isn't yet", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [
				makeContact({ id: "later", availableAt: 999 }),
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
		setRunQuery(
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
		setRunQuery(
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
	// Tests that a run-not-found error sends the student home without starting a new run.
	it("a run-not-found error sends the student home without starting a new run", async () => {
		const { session, goto } = await freshRun();
		session.startRun({ runId: "stale-run" });
		sessionStorage.setItem(notesKey("stale-run"), "my notes");
		setRunQuery(
			{ runId: "stale-run" },
			{
				error: clientStudentError(
					GET_STATE,
					STUDENT_ERROR.RUN_NOT_FOUND,
					"Run not found.",
					"Q",
				),
			},
		);

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(session.runId).toBe("");
		expect(sessionStorage.getItem(notesKey("stale-run"))).toBeNull();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// Tests that an unrelated error sets loadError instead of clearing the run.
	it("a non-expiry error sets loadError instead of clearing the run", async () => {
		const { run, session, goto } = await freshRun();
		session.startRun({ runId: "run-1" });
		setRunQuery(
			{ runId: "run-1" },
			{ error: clientServerError(GET_STATE, "Q") },
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
		setRunQuery(
			{ runId: "run-1" },
			{
				error: clientStudentError(
					GET_STATE,
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
		setRunQuery(
			{ runId: "run-1" },
			{ error: clientServerError(GET_STATE, "Q") },
		);
		await vi.waitFor(() => expect(run.loadError).not.toBe(""));

		setRunQuery({ runId: "run-1" }, { data: makeRunState({ runId: "run-1" }) });

		await vi.waitFor(() => expect(run.loadError).toBe(""));
	});
});

describe("sendMessage guards", () => {
	// Tests that sendMessage returns false and sends nothing without an active contact.
	it("returns false and sends nothing when there is no active contact", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = null;

		expect(run.sendMessage("hello")).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing for an empty or whitespace-only message.
	it("returns false and sends nothing for an empty or whitespace-only message", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";

		expect(run.sendMessage("")).toBe(false);
		expect(run.sendMessage("   \n\t ")).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// Tests that sendMessage returns false and sends nothing when there is no run in the session.
	it("returns false and sends nothing when there is no run", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		session.clearRun();

		expect(run.sendMessage("hello")).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// Tests that a reply in flight for one contact does not block messaging another contact.
	it("lets the student message another contact while a reply is in flight", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary" }), makeContact({ id: "bob" })],
		});
		setHistory("mary", [], { id: "r1", status: "pending" });
		run.activeContactId = "mary";
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		run.activeContactId = "bob";
		expect(run.isSending).toBe(false);
		expect(run.sendMessage("second")).toBe(true);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	// Tests that an accepted message returns true and is sent through the sendMessage mutation.
	it("returns true and sends the message through the sendMessage mutation", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";

		expect(run.sendMessage("hello")).toBe(true);

		expect(sendMessage).toHaveBeenCalledWith({
			runId: "run-1",
			personaId: "mary",
			message: "hello",
		});
	});
});

describe("sendMessage lifecycle", () => {
	// Tests that isSending follows the server: true while the reply is pending, false once it is done.
	it("isSending follows the server-side reply status", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", [message("user", "prior q"), message("assistant", "a")]);
		run.activeContactId = "mary";
		await vi.waitFor(() => expect(run.activeMessages).toHaveLength(2));
		expect(run.isSending).toBe(false);

		run.sendMessage("New question");
		setHistory(
			"mary",
			[
				message("user", "prior q"),
				message("assistant", "a"),
				message("user", "New question"),
			],
			{ id: "r1", status: "pending" },
		);
		await vi.waitFor(() => expect(run.isSending).toBe(true));
		expect(run.activeMessages).toHaveLength(3);

		setHistory(
			"mary",
			[
				message("user", "prior q"),
				message("assistant", "a"),
				message("user", "New question"),
				message("assistant", "the reply"),
			],
			{ id: "r1", status: "done" },
		);
		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(run.activeMessages).toHaveLength(4);
	});

	// Tests that a boundary reply, which replaces the flagged message, unlocks the composer without a toast.
	it("unlocks after a boundary reply that replaces the flagged message, without a toast", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", []);
		run.activeContactId = "mary";

		run.sendMessage("asdf asdf asdf");
		setHistory("mary", [], { id: "r1", status: "pending" });
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		setHistory(
			"mary",
			[message("assistant", "I am not able to follow that.")],
			{
				id: "r1",
				status: "done",
			},
		);

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).not.toHaveBeenCalled();
		expect(run.sendMessage("a real question")).toBe(true);
	});

	// Tests that a rejected message shows the server message and leaves the composer unlocked.
	it("a rejected message (e.g. conversation ended) shows the server message and stays unlocked", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		sendMessage.mockRejectedValue(
			clientStudentError(
				SEND_MESSAGE,
				STUDENT_ERROR.CONVERSATION_ENDED,
				"This conversation has ended.",
			),
		);

		run.sendMessage("hello");

		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith("This conversation has ended.", {
				duration: 4000,
			}),
		);
		expect(run.isSending).toBe(false);
	});

	// Tests that sending to a run that has expired ends the simulation instead of showing a toast.
	it("sends the student home when the run has expired by the time they send", async () => {
		const { run, session, goto, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		sendMessage.mockRejectedValue(
			clientStudentError(
				SEND_MESSAGE,
				STUDENT_ERROR.RUN_EXPIRED,
				"Run expired.",
			),
		);

		run.sendMessage("hello");

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(session.runId).toBe("");
		expect(toast).not.toHaveBeenCalled();
	});

	// Tests that a real server error or a network failure shows a generic toast.
	it.each([
		["a server error", () => clientServerError(SEND_MESSAGE)],
		["a network failure", () => new TypeError("Failed to fetch")],
	])("shows a generic toast after %s", async (_name, makeError) => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		sendMessage.mockRejectedValue(makeError());

		run.sendMessage("hello");

		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Message failed. Please try again.", {
				duration: 4000,
			}),
		);
		expect(run.isSending).toBe(false);
	});
});

describe("failed and stuck replies", () => {
	const FAILED_TOAST =
		"Something went wrong generating a reply. Please resend your message.";

	// Tests that a reply the server marks failed unlocks the composer and shows the toast once.
	it("a failed reply unlocks the composer and toasts once", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", []);
		run.activeContactId = "mary";

		run.sendMessage("hello");
		setHistory("mary", [message("user", "hello")], {
			id: "r1",
			status: "pending",
		});
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		setHistory("mary", [], { id: "r1", status: "failed" });

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).toHaveBeenCalledWith(FAILED_TOAST, { duration: 4000 });
		setHistory("mary", [], { id: "r1", status: "failed" });
		await settle();
		expect(toast).toHaveBeenCalledTimes(1);
	});

	// Tests that a reply that finishes normally does not toast.
	it("a finished reply does not toast", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", []);
		run.activeContactId = "mary";

		run.sendMessage("hello");
		setHistory("mary", [message("user", "hello")], {
			id: "r1",
			status: "pending",
		});
		await vi.waitFor(() => expect(run.isSending).toBe(true));
		setHistory("mary", [message("user", "hello"), message("assistant", "hi")], {
			id: "r1",
			status: "done",
		});

		await vi.waitFor(() => expect(run.isSending).toBe(false));
		expect(toast).not.toHaveBeenCalled();
	});

	// Tests that an older failed reply is not mistaken for the new send failing.
	it("does not mistake an older failed reply for the new send failing", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", [], { id: "old", status: "failed" });
		run.activeContactId = "mary";

		run.sendMessage("hello again");
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
		await settle();

		expect(toast).not.toHaveBeenCalled();
	});

	// Tests that the composer stays locked while the server says the reply is pending, with no toast.
	it("stays locked while the reply is pending", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", [message("user", "hello")], {
			id: "r1",
			status: "pending",
		});
		run.activeContactId = "mary";

		await vi.waitFor(() => expect(run.isSending).toBe(true));
		expect(toast).not.toHaveBeenCalled();
	});

	// Tests that after a failure the student can immediately resend.
	it("lets the student resend right after a failed reply", async () => {
		const { run, session } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", []);
		run.activeContactId = "mary";

		run.sendMessage("hello");
		setHistory("mary", [message("user", "hello")], {
			id: "r1",
			status: "pending",
		});
		await vi.waitFor(() => expect(run.isSending).toBe(true));
		setHistory("mary", [], { id: "r1", status: "failed" });
		await vi.waitFor(() => expect(run.isSending).toBe(false));

		expect(run.sendMessage("hello again")).toBe(true);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	// Tests that a failure on another persona neither unlocks nor toasts for the persona being viewed.
	it("ignores a failed reply on a persona other than the one being viewed", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary" }), makeContact({ id: "bob" })],
		});
		setHistory("mary", [], { id: "r1", status: "pending" });
		run.activeContactId = "mary";
		run.sendMessage("hello");
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		run.selectContact("bob");
		setHistory("bob", [], { id: "b1", status: "failed" });
		await settle();

		expect(run.isSending).toBe(false);
		expect(toast).not.toHaveBeenCalled();
		run.selectContact("mary");
		expect(run.isSending).toBe(true);
	});

	// Tests that a reply that failed while the student was viewing someone else is reported on return.
	it("reports a reply that failed while the student was viewing someone else", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session, {
			contacts: [makeContact({ id: "mary" }), makeContact({ id: "bob" })],
		});
		setHistory("mary", []);
		run.activeContactId = "mary";
		run.sendMessage("hello");
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
		setHistory("mary", [message("user", "hello")], {
			id: "r1",
			status: "pending",
		});
		await vi.waitFor(() => expect(run.isSending).toBe(true));
		run.selectContact("bob");

		setHistory("mary", [], { id: "r1", status: "failed" });
		run.selectContact("mary");

		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith(FAILED_TOAST, { duration: 4000 }),
		);
		expect(run.isSending).toBe(false);
	});

	// Tests that a reply already in progress on the server is reported and does not lock the composer.
	it("explains when the server says a reply is already in progress", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session);
		run.activeContactId = "mary";
		sendMessage.mockRejectedValue(
			clientStudentError(
				SEND_MESSAGE,
				STUDENT_ERROR.REPLY_IN_PROGRESS,
				"Please wait for the current reply to finish.",
			),
		);

		run.sendMessage("hello");

		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				"Please wait for the current reply to finish.",
				{ duration: 4000 },
			),
		);
		expect(run.isSending).toBe(false);
	});
});

describe("notification diffing (#diffAndNotify, observed via the live query)", () => {
	// Tests that toasts fire only for new contacts and files after the initial roster, and never for repeats.
	it("fires no toasts for the initial roster, exactly one for a later new contact and a later new file, and none for a repeat", async () => {
		const { run, session, toast } = await freshRun();
		await primeRun(run, session, { sharedFiles: [] });
		await vi.waitFor(() => expect(toast).not.toHaveBeenCalled());

		const bob = makeContact({ id: "bob", name: "Bob", role: "Analyst" });
		const newFile = makeSharedFile({ fileId: "9", fileName: "new.pdf" });
		setRunQuery(
			{ runId: "run-1" },
			{
				data: makeRunState({
					case: caseData,
					contacts: [makeContact({ id: "mary", chatEnded: false }), bob],
					sharedFiles: [newFile],
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

		setHistory("mary", [message("user", "hi")]);
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
	// Tests that a run destroyed (expired) while a message is in flight, so reads report it not found, sends the student home without a replacement run.
	it("sends the student home instead of starting a replacement run", async () => {
		const { run, session, goto } = await freshRun();
		await primeRun(run, session);
		setHistory("mary", [], { id: "r1", status: "pending" });

		expect(run.sendMessage("are you there?")).toBe(true);
		await vi.waitFor(() => expect(run.isSending).toBe(true));

		setRunQuery(
			{ runId: "run-1" },
			{
				error: clientStudentError(
					GET_STATE,
					STUDENT_ERROR.RUN_NOT_FOUND,
					"Run not found.",
					"Q",
				),
			},
		);

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
		expect(session.runId).toBe("");
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("run-level time expiry", () => {
	// Tests that disposing the store's effect root, as unmounting its component does, stops the clock.
	it("stops its clock when its owner is disposed", async () => {
		vi.useFakeTimers();
		try {
			const { run, session } = await freshRun();
			await primeRun(run, session);
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			for (const dispose of disposers.splice(0)) dispose();

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// Tests that run-level time expiry disables messaging in place rather than navigating away.
	it("disables messaging in place instead of navigating away", async () => {
		vi.useFakeTimers();
		try {
			const { run, session, goto } = await freshRun();
			await primeRun(run, session, {
				case: { ...caseData, simulationDuration: 1 },
			});

			expect(run.timeExpired).toBe(false);
			expect(run.activePersonaAvailable).toBe(true);

			await vi.advanceTimersByTimeAsync(60_000);

			expect(run.timeExpired).toBe(true);
			expect(run.activePersonaAvailable).toBe(false);
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
				case: { ...caseData, simulationDuration: 1 },
			});
			await vi.advanceTimersByTimeAsync(60_000);
			expect(run.timeExpired).toBe(true);
			expect(goto).not.toHaveBeenCalled();

			setRunQuery(
				{ runId: "run-1" },
				{
					error: clientStudentError(
						GET_STATE,
						STUDENT_ERROR.RUN_NOT_FOUND,
						"Run not found.",
						"Q",
					),
				},
			);

			await vi.waitFor(() => expect(goto).toHaveBeenCalledWith("/"));
			expect(session.runId).toBe("");
			expect(sendMessage).not.toHaveBeenCalled();
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
		const typed = "  Café ☕\nQ3 — 40 % ↑ 🙂  ";

		expect(run.sendMessage(typed)).toBe(true);

		expect(sendMessage.mock.calls[0]?.[0]).toEqual({
			runId: "run-1",
			personaId: "mary",
			message: typed.trim(),
		});
	});
});
