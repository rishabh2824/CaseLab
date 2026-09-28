import { makeFunctionReference } from "convex/server";
import { getConvexClient, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { resolveConvexSiteUrl } from "../convexUrl.js";
import { getErrorMessage } from "../errors.js";
import { session } from "../session.svelte.js";
import type { ChatMessage, Contact, SharedFile } from "../types.js";
import { personaAvailability } from "./availability.js";

export const startSimulationRef = makeFunctionReference<"mutation">(
	"api/simulations:start",
);
export const exportRunRef = makeFunctionReference<"query">(
	"api/simulations:exportRun",
);
const getSimulationStateRef = makeFunctionReference<"query">(
	"api/simulations:get",
);
const getPersonaHistoryRef = makeFunctionReference<"query">(
	"api/simulations:getPersonaHistory",
);
const getTurnStreamRef = makeFunctionReference<"query">(
	"api/turn:getTurnStream",
);
const startTurnRef = makeFunctionReference<"mutation">("api/turn:start");

import {
	STUDENT_ERROR,
	studentErrorData,
} from "../../../convex/lib/studentErrors.js";
import type {
	ExportSimulationOut,
	RunStateOut,
} from "../../../convex/services/simulations.js";
import type { TurnStreamOut } from "../../../convex/services/turn.js";

export type StartedRun = Omit<RunStateOut, "run_id" | "case"> & {
	run_id: string;
	case: Omit<RunStateOut["case"], "id"> & { id: string };
};
export type ExportRunOut = Omit<ExportSimulationOut, "case"> & {
	case: Omit<ExportSimulationOut["case"], "id"> & { id: string };
};

export type DisplayContact = Contact & {
	available: boolean;
	available_in: number | null;
	expires_in: number | null;
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
	isSending = $state(false);
	timeExpired = $state(false);

	#notesInitialized = false;
	#notesSaveTimer: number | null = null;
	#seenContacts = new Set<string>();
	#seenFiles = new Set<string>();
	#seenInitialized = false;
	#expiryInterval: number | null = null;
	#nowTick = $state(Date.now());
	#availabilityTickInterval: number | null = null;
	#sendingPersonaId = $state<string | null>(null);

	#runStateQuery = useQuery(getSimulationStateRef, () =>
		session.runId ? { runId: session.runId } : "skip",
	);
	#historyQuery = useQuery(getPersonaHistoryRef, () =>
		session.runId && this.activeContactId
			? { runId: session.runId, personaId: this.activeContactId }
			: "skip",
	);
	#driven = $state<{ personaId: string; streamId: string } | null>(null);
	#drivenText = $state("");
	#attemptedStreams = new Set<string>();
	#turnQuery = useQuery(getTurnStreamRef, () =>
		session.runId && this.activeContactId
			? {
					runId: session.runId,
					personaId: this.activeContactId,
					withText: this.#driven?.personaId !== this.activeContactId,
				}
			: "skip",
	);
	#turn = $derived((this.#turnQuery.data as TurnStreamOut | undefined) ?? null);
	#sentOverStreamId: string | null = null;

	raw = $derived<StartedRun | null>(this.#runStateQuery.data ?? null);
	caseData = $derived(this.raw?.case ?? null);
	elapsedMinutes = $derived(
		session.startTime !== null
			? Math.max(0, Math.floor((this.#nowTick - session.startTime) / 60_000))
			: 0,
	);
	contacts = $derived<DisplayContact[]>(
		(this.raw?.contacts ?? []).map((contact) => {
			const availability = personaAvailability(
				contact.availability_duration,
				contact.available_at,
				this.elapsedMinutes,
			);
			return {
				...contact,
				available: availability.available,
				available_in: availability.availableIn,
				expires_in: availability.expiresIn,
			};
		}),
	);
	sharedFiles = $derived<SharedFile[]>(this.raw?.shared_files ?? []);
	activeMessages = $derived<ChatMessage[]>(this.#historyQuery.data ?? []);
	streamingPreview = $derived.by<string | null>(() => {
		const turn = this.#turn;
		if (!turn || turn.settled) return null;
		if (turn.status !== "pending" && turn.status !== "streaming") return null;
		return this.#driven?.streamId === turn.streamId
			? this.#drivenText
			: turn.text;
	});
	activeContact = $derived(
		this.contacts.find((c) => c.id === this.activeContactId) ??
			this.contacts[0] ??
			null,
	);
	selectedContact = $derived(
		this.contacts.find((c) => c.id === this.activeContactId) ?? null,
	);
	activePersonaAvailable = $derived(
		Boolean(
			!this.timeExpired &&
				this.selectedContact?.available &&
				!this.selectedContact?.chat_ended,
		),
	);
	totalDurationSeconds = $derived(
		typeof this.caseData?.simulation_duration === "number"
			? this.caseData.simulation_duration * 60
			: null,
	);

	#dispose = $effect.root(() => {
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
			const turn = this.#turn;
			const personaId = this.activeContactId;
			if (!turn?.claimable || !personaId) return;
			if (this.#attemptedStreams.has(turn.streamId)) return;
			this.#attemptedStreams.add(turn.streamId);
			void this.#drive(personaId, turn.streamId);
		});
		$effect(() => {
			const personaId = this.#sendingPersonaId;
			if (!personaId || personaId !== this.activeContactId) return;
			const turn = this.#turn;
			if (!turn || turn.streamId === this.#sentOverStreamId) return;
			const failed = turn.status === "error" || turn.status === "timeout";
			if (!turn.settled && !failed) return;
			this.#sendingPersonaId = null;
			this.isSending = false;
			if (failed)
				notify(
					"Something went wrong generating a reply. Please resend your message.",
				);
		});
	});

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
		this.#ensureExpiryWatch();
		this.#ensureAvailabilityTick();
	}

	// Toasts about contacts and files that appeared since the last update, skipping the initial load.
	#diffAndNotify(): void {
		const rows: Contact[] = this.raw?.contacts ?? [];
		const files: SharedFile[] = this.raw?.shared_files ?? [];
		if (this.#seenInitialized) {
			for (const c of rows) {
				if (!this.#seenContacts.has(c.id))
					notify(`New contact unlocked: ${c.name} (${c.role})`);
			}
			for (const f of files) {
				if (!this.#seenFiles.has(f.file_id))
					notify(`File shared: ${f.file_name}`);
			}
		}
		this.#seenContacts = new Set(rows.map((c) => c.id));
		this.#seenFiles = new Set(files.map((f) => f.file_id));
		this.#seenInitialized = true;
	}

	// Starts the timer that flags the simulation as expired once its duration passes.
	#ensureExpiryWatch(): void {
		if (this.#expiryInterval) return;
		const totalDurationSeconds = this.totalDurationSeconds;
		if (typeof totalDurationSeconds !== "number") return;
		const start = session.startTime ?? Date.now();
		const checkExpiry = () => {
			const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
			if (elapsed >= totalDurationSeconds) {
				if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
				this.#expiryInterval = null;
				this.timeExpired = true;
			}
		};
		checkExpiry();
		this.#expiryInterval = window.setInterval(checkExpiry, 1000);
	}

	// Starts the periodic tick that refreshes persona availability.
	#ensureAvailabilityTick(): void {
		if (this.#availabilityTickInterval) return;
		this.#availabilityTickInterval = window.setInterval(() => {
			this.#nowTick = Date.now();
		}, 15_000);
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
		if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
		this.#expiryInterval = null;
		if (session.runId) clearNotes(session.runId);
		session.clearRun();
		goto("/");
	}

	// Disposes the store's effects and clears its timers.
	destroy(): void {
		this.#dispose();
		if (this.#availabilityTickInterval)
			window.clearInterval(this.#availabilityTickInterval);
		if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
		this.#availabilityTickInterval = null;
		this.#expiryInterval = null;
	}

	// Sends a trimmed message to the active contact if allowed and returns whether it was accepted.
	sendMessage(rawMessage: string): boolean {
		const message = (rawMessage ?? "").trim();
		const activeContactId = this.activeContactId;
		if (!session.runId || !activeContactId || !message) return false;
		if (!this.activePersonaAvailable || this.isSending) return false;
		this.#runSend(activeContactId, message);
		return true;
	}

	// Starts the turn on the server and resets the sending state with a toast if it is rejected.
	async #runSend(personaId: string, message: string): Promise<void> {
		const runId = session.runId;
		this.#sentOverStreamId = this.#turn?.streamId ?? null;
		this.#sendingPersonaId = personaId;
		this.isSending = true;
		try {
			await getConvexClient().mutation(startTurnRef, {
				runId,
				personaId,
				message,
			});
		} catch (err) {
			console.error(err);
			this.#sendingPersonaId = null;
			this.isSending = false;
			notify(getErrorMessage(err, "Message failed. Please try again."));
		}
	}

	// Drives a claimed turn by reading its reply stream so the text shows live.
	async #drive(personaId: string, streamId: string): Promise<void> {
		this.#driven = { personaId, streamId };
		this.#drivenText = "";
		try {
			const response = await fetch(`${resolveConvexSiteUrl()}/turn-stream`, {
				method: "POST",
				body: JSON.stringify({ streamId }),
			});
			if (!response.ok || !response.body)
				throw new Error(`/turn-stream answered ${response.status}`);
			const reader = response.body
				.pipeThrough(new TextDecoderStream())
				.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				if (this.#driven?.streamId === streamId) this.#drivenText += value;
			}
		} catch {
			if (this.#driven?.streamId === streamId) this.#driven = null;
		}
	}
}

// Creates a new RunStore.
export function createRunStore(): RunStore {
	return new RunStore();
}
