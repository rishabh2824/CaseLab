import { getConvexClient, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { getErrorMessage } from "../errors.js";
import { session } from "../session.svelte.js";
import type { ChatMessage, Contact, SharedFile } from "../types.js";

export const startSimulationRef = api.simulations.start;
export const exportRunRef = api.simulations.exportRun;

import {
	STUDENT_ERROR,
	studentErrorData,
} from "../../../convex/lib/studentErrors.js";
import { personaAvailability } from "../../../convex/lib/turnState.js";

export type DisplayContact = Contact & {
	available: boolean;
	availableIn: number | null;
	expiresIn: number | null;
};

// Shows a short toast with the message.
const notify = (message: string) => toast(message, { duration: 4000 });

const NOTES_SAVE_DEBOUNCE_MS = 800;

const NOTES_STORAGE_PREFIX = "caselab:notes:";

// Returns the sessionStorage key for a run's notes.
function notesStorageKey(runId: string): string {
	return `${NOTES_STORAGE_PREFIX}${runId}`;
}

// Loads a run's notes from sessionStorage, or an empty string if unavailable.
function loadNotes(runId: string): string {
	try {
		return sessionStorage.getItem(notesStorageKey(runId)) ?? "";
	} catch {
		return "";
	}
}

// Saves a run's notes to sessionStorage, ignoring storage errors.
function saveNotes(runId: string, notes: string): void {
	try {
		sessionStorage.setItem(notesStorageKey(runId), notes);
	} catch {}
}

// Removes a run's notes from sessionStorage, ignoring storage errors.
function clearNotes(runId: string): void {
	try {
		sessionStorage.removeItem(notesStorageKey(runId));
	} catch {}
}

export class RunStore {
	loadError = $state("");
	activeContactId = $state<string | null>(null);
	notes = $state("");

	#notesInitialized = false;
	#notesSaveTimer: number | null = null;
	#seenContacts = new Set<string>();
	#seenFiles = new Set<string>();
	#seenInitialized = false;
	#clockInterval: number | null = null;
	// The one clock everything time-based derives from, ticking once a second.
	#now = $state(Date.now());
	// The reply started by the last send, until the server reports it done or failed.
	#awaitedReplyId = $state<string | null>(null);

	#runStateQuery = useQuery(api.simulations.get, () =>
		session.runId ? { runId: session.runId as Id<"runs"> } : "skip",
	);
	#historyQuery = useQuery(api.simulations.getPersonaHistory, () =>
		session.runId && this.activeContactId
			? {
					runId: session.runId as Id<"runs">,
					personaId: this.activeContactId,
				}
			: "skip",
	);
	#history = $derived(this.#historyQuery.data);
	// Whether the active contact has a reply in flight; other contacts stay free to message.
	isSending = $derived(this.#history?.reply?.status === "pending");

	raw = $derived(this.#runStateQuery.data ?? null);
	caseData = $derived(this.raw?.case ?? null);
	elapsedSeconds = $derived(
		session.startTime !== null
			? Math.max(0, Math.floor((this.#now - session.startTime) / 1000))
			: 0,
	);
	elapsedMinutes = $derived(Math.floor(this.elapsedSeconds / 60));
	contacts = $derived<DisplayContact[]>(
		(this.raw?.contacts ?? []).map((contact) => {
			const availability = personaAvailability(
				contact.availabilityDuration,
				contact.availableAt,
				this.elapsedMinutes,
			);
			return {
				...contact,
				available: availability.available,
				availableIn: availability.availableIn,
				expiresIn: availability.expiresIn,
			};
		}),
	);
	sharedFiles = $derived<SharedFile[]>(this.raw?.sharedFiles ?? []);
	activeMessages = $derived<ChatMessage[]>(this.#history?.messages ?? []);
	activeContact = $derived(
		this.contacts.find((c) => c.id === this.activeContactId) ??
			this.contacts[0] ??
			null,
	);
	selectedContact = $derived(
		this.contacts.find((c) => c.id === this.activeContactId) ?? null,
	);
	totalDurationSeconds = $derived(
		typeof this.caseData?.simulationDuration === "number"
			? this.caseData.simulationDuration * 60
			: null,
	);
	timeExpired = $derived(
		this.totalDurationSeconds !== null &&
			this.elapsedSeconds >= this.totalDurationSeconds,
	);
	activePersonaAvailable = $derived(
		Boolean(
			!this.timeExpired &&
				this.selectedContact?.available &&
				!this.selectedContact?.chatEnded,
		),
	);

	// The store is built while the component initialises, so these effects live and die with it.
	constructor() {
		$effect(() => {
			const err = this.#runStateQuery.error;
			if (!err) {
				this.loadError = "";
				return;
			}
			const code = studentErrorData(err)?.code;
			if (
				code === STUDENT_ERROR.RUN_NOT_FOUND ||
				code === STUDENT_ERROR.RUN_EXPIRED
			) {
				this.endSimulation();
			} else {
				this.loadError = getErrorMessage(err, "Failed to load the simulation.");
			}
		});
		$effect(() => {
			if (this.raw) this.#afterLoad();
		});
		$effect(() => {
			const reply = this.#history?.reply;
			if (!this.#awaitedReplyId || reply?.id !== this.#awaitedReplyId) return;
			if (reply.status === "pending") return;
			this.#awaitedReplyId = null;
			if (reply.status === "failed")
				notify(
					"Something went wrong generating a reply. Please resend your message.",
				);
		});
		$effect(() => () => this.#stopClock());
	}

	// Goes home if there is no run to resume. Never starts a new run itself: a simulation that has
	// ended stays ended, and a new one only begins when the student enters an access code.
	init(): void {
		if (!session.runId) goto("/");
	}

	// Restores notes and the selected contact after the run loads, then updates notifications and timers.
	#afterLoad(): void {
		if (!this.#notesInitialized && session.runId) {
			this.notes = loadNotes(session.runId);
			this.#notesInitialized = true;
		}
		if (this.activeContactId == null) {
			const rows = this.contacts;
			const remembered = rows.find((c) => c.id === session.activePersonaId);
			const first = remembered ?? rows.find((c) => c.available) ?? rows[0];
			if (first) this.activeContactId = first.id;
		}
		this.#diffAndNotify();
		this.#ensureClock();
	}

	// Toasts about contacts and files that appeared since the last update, skipping the initial load.
	#diffAndNotify(): void {
		const rows: Contact[] = this.raw?.contacts ?? [];
		const files: SharedFile[] = this.raw?.sharedFiles ?? [];
		if (this.#seenInitialized) {
			for (const c of rows) {
				if (!this.#seenContacts.has(c.id))
					notify(`New contact unlocked: ${c.name} (${c.role})`);
			}
			for (const f of files) {
				if (!this.#seenFiles.has(f.fileId))
					notify(`File shared: ${f.fileName}`);
			}
		}
		this.#seenContacts = new Set(rows.map((c) => c.id));
		this.#seenFiles = new Set(files.map((f) => f.fileId));
		this.#seenInitialized = true;
	}

	// Starts the one-second clock that drives elapsed time, expiry and persona availability.
	#ensureClock(): void {
		if (this.#clockInterval) return;
		this.#now = Date.now();
		this.#clockInterval = window.setInterval(() => {
			this.#now = Date.now();
		}, 1000);
	}

	// Selects a contact and remembers the choice in the session.
	selectContact(contactId: string): void {
		this.activeContactId = contactId;
		session.setActivePersona(contactId);
	}

	// Updates the notes and schedules a debounced save.
	setNotes(value: string): void {
		this.notes = value;
		if (this.#notesSaveTimer) window.clearTimeout(this.#notesSaveTimer);
		this.#notesSaveTimer = window.setTimeout(() => {
			this.#notesSaveTimer = null;
			this.#saveNotesNow();
		}, NOTES_SAVE_DEBOUNCE_MS);
	}

	// Saves the notes immediately and cancels any pending debounced save.
	flushNotes(): void {
		if (this.#notesSaveTimer) {
			window.clearTimeout(this.#notesSaveTimer);
			this.#notesSaveTimer = null;
		}
		this.#saveNotesNow();
	}

	// Writes the current notes to storage for the active run.
	#saveNotesNow(): void {
		const id = session.runId;
		if (!id) return;
		saveNotes(id, this.notes);
	}

	// Stops timers, clears notes and the run, and navigates home.
	endSimulation(): void {
		if (this.#notesSaveTimer) {
			window.clearTimeout(this.#notesSaveTimer);
			this.#notesSaveTimer = null;
		}
		this.#stopClock();
		if (session.runId) clearNotes(session.runId);
		session.clearRun();
		goto("/");
	}

	// Stops the clock interval.
	#stopClock(): void {
		if (this.#clockInterval) window.clearInterval(this.#clockInterval);
		this.#clockInterval = null;
	}

	// Sends a trimmed message to the active contact, returning whether it was sent. The composer handles every other check.
	sendMessage(rawMessage: string): boolean {
		const message = rawMessage.trim();
		const personaId = this.activeContactId;
		if (!message || !personaId || !session.runId) return false;
		this.#runSend(session.runId as Id<"runs">, personaId, message);
		return true;
	}

	// Saves the message and starts its reply on the server, toasting if it is rejected.
	async #runSend(
		runId: Id<"runs">,
		personaId: string,
		message: string,
	): Promise<void> {
		try {
			const { replyId } = await getConvexClient().mutation(
				api.turn.sendMessage,
				{
					runId,
					personaId,
					message,
				},
			);
			this.#awaitedReplyId = replyId;
		} catch (err) {
			const error = studentErrorData(err);
			if (
				error?.code === STUDENT_ERROR.RUN_EXPIRED ||
				error?.code === STUDENT_ERROR.RUN_NOT_FOUND
			) {
				this.endSimulation();
				return;
			}
			notify(error?.message ?? "Message failed. Please try again.");
		}
	}
}

// Creates a new RunStore.
export function createRunStore(): RunStore {
	return new RunStore();
}
