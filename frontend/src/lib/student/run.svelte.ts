import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { ApiError, apiFetch, streamChat } from "../api/client.js";
import { session } from "../session.svelte.js";
import type {
	ChatMessage,
	Contact,
	NotesPayload,
	RunState,
	SendMessagePayload,
	SharedFile,
	StartSimulationPayload,
	StreamEvent,
	TurnMeta,
} from "../types.js";
import {
	type MappedContact,
	mapContact,
	normalizeHistories,
} from "./Helpers.js";

const notify = (message: string) => toast(message, { duration: 4000 });

// How long to wait after the last keystroke before persisting notes, so
// typing doesn't fire a write per character. flushNotes() bypasses this.
const NOTES_SAVE_DEBOUNCE_MS = 800;

type StreamingTurn = {
	personaId: string;
	messages: ChatMessage[];
};

class RunStore {
	raw = $state<RunState | null>(null);
	loadError = $state("");
	activeContactId = $state<string | null>(null);
	streamingTurn = $state<StreamingTurn | null>(null);
	notes = $state("");
	isSending = $state(false);

	#initialized = false;
	#notesInitialized = false;
	#notesSaveTimer: ReturnType<typeof setTimeout> | null = null;
	#seenContacts = new Set<string>();
	#seenFiles = new Set<string>();
	#seenInitialized = false;
	#expiryInterval: ReturnType<typeof setInterval> | null = null;

	caseData = $derived(this.raw?.case ?? null);
	contacts = $derived<MappedContact[]>(
		(this.raw?.contacts ?? []).map(mapContact),
	);
	sharedFiles = $derived<SharedFile[]>(this.raw?.shared_files ?? []);
	serverHistories = $derived<Record<string, ChatMessage[]>>(
		normalizeHistories(this.raw?.histories ?? {}),
	);
	messagesByPersona = $derived<Record<string, ChatMessage[]>>(
		this.streamingTurn
			? {
					...this.serverHistories,
					[this.streamingTurn.personaId]: this.streamingTurn.messages,
				}
			: this.serverHistories,
	);
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
			this.selectedContact?.available && !this.selectedContact?.chatEnded,
		),
	);
	totalDurationSeconds = $derived(
		typeof this.caseData?.simulation_duration === "number"
			? this.caseData.simulation_duration * 60
			: null,
	);

	// Establishes a run exactly once: resume a persisted runId, else start
	// from the access code, else bail home.
	async init(): Promise<void> {
		if (this.#initialized) return;
		this.#initialized = true;
		if (session.runId) {
			await this.refresh(session.runId);
		} else if (session.accessCode) {
			await this.startSession(session.accessCode);
		} else {
			goto("/");
		}
	}

	async startSession(code: string): Promise<void> {
		try {
			const fresh = await apiFetch<RunState>("/api/simulations/start", {
				method: "POST",
				body: { access_code: code } satisfies StartSimulationPayload,
			});
			this.raw = fresh;
			session.startRun({
				runId: fresh.run_id,
				accessCode: code,
				startTime: Date.now(),
			});
			this.#afterLoad();
		} catch {
			goto("/");
		}
	}

	async refresh(runId: string): Promise<void> {
		try {
			const data = await apiFetch<RunState>(`/api/simulations/${runId}`);
			this.raw = data;
			this.#afterLoad();
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				this.#handleExpired();
			} else {
				this.loadError =
					(err instanceof Error && err.message) ||
					"Failed to load the simulation.";
			}
		}
	}

	#afterLoad(): void {
		if (!this.#notesInitialized && this.raw?.notes !== undefined) {
			this.notes = this.raw.notes;
			this.#notesInitialized = true;
		}
		if (this.activeContactId == null) {
			const rows = this.raw?.contacts ?? [];
			const first = rows[0];
			if (first) this.activeContactId = this.raw?.active_persona_id || first.id;
		}
		this.#diffAndNotify();
		this.#ensureExpiryWatch();
	}

	// Notifies on newly-unlocked contacts / newly-shared files by diffing
	// against what's already been surfaced (never fires for the initial roster).
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

	#handleExpired(): void {
		session.setRunId("");
		this.activeContactId = null;
		if (session.accessCode) this.startSession(session.accessCode);
		else goto("/");
	}

	// Auto-ends the run once the case's configured duration elapses.
	#ensureExpiryWatch(): void {
		if (this.#expiryInterval) return;
		// Captured once into a local so the closure below keeps TypeScript's
		// `number` narrowing — totalDurationSeconds derives from case data
		// that's fixed for the run's lifetime, so this matches the original's
		// per-tick `this.totalDurationSeconds` read in practice.
		const totalDurationSeconds = this.totalDurationSeconds;
		if (typeof totalDurationSeconds !== "number") return;
		const start = session.startTime ?? Date.now();
		const checkExpiry = () => {
			const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
			if (elapsed >= totalDurationSeconds) {
				if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
				this.#expiryInterval = null;
				this.endSimulation();
			}
		};
		checkExpiry();
		this.#expiryInterval = window.setInterval(checkExpiry, 1000);
	}

	selectContact(contactId: string): void {
		this.activeContactId = contactId;
	}

	setNotes(value: string): void {
		this.notes = value;
		if (this.#notesSaveTimer) window.clearTimeout(this.#notesSaveTimer);
		this.#notesSaveTimer = window.setTimeout(() => {
			this.#notesSaveTimer = null;
			this.#saveNotesNow();
		}, NOTES_SAVE_DEBOUNCE_MS);
	}

	// Saves immediately, skipping the debounce — call on blur so a click away
	// from the textarea doesn't leave an edit unsaved.
	flushNotes(): void {
		if (this.#notesSaveTimer) {
			window.clearTimeout(this.#notesSaveTimer);
			this.#notesSaveTimer = null;
		}
		this.#saveNotesNow();
	}

	async #saveNotesNow(): Promise<void> {
		const id = session.runId;
		if (!id) return;
		try {
			await apiFetch(`/api/simulations/${id}/notes`, {
				method: "PUT",
				body: { notes: this.notes } satisfies NotesPayload,
			});
		} catch (err) {
			console.error(err);
			notify("Could not save your notes. Please try again.");
		}
	}

	endSimulation(): void {
		this.flushNotes();
		session.clearRun();
		goto("/");
	}

	// Folds a turn's meta (unlocked contacts, shared files, chat-state) into
	// raw so it shows immediately; mutated in place since raw is deep $state.
	applyMeta(personaId: string, meta: TurnMeta): void {
		if (!this.raw) return;
		if (meta.new_contacts?.length) {
			const existing = new Set(this.raw.contacts.map((c) => c.id));
			for (const c of meta.new_contacts) {
				if (existing.has(c.id)) continue;
				// NewContact never carries `available` (see types.ts) — a
				// freshly-unlocked contact is available immediately.
				this.raw.contacts.push({ ...c, available: true });
			}
		}
		const target = this.raw.contacts.find((c) => c.id === personaId);
		if (target) {
			target.chat_ended = meta.chat_ended ?? target.chat_ended;
			target.chat_end_reason = meta.chat_end_reason ?? target.chat_end_reason;
			target.warning_count = meta.warning_count ?? target.warning_count;
		}
		if (meta.shared_files?.length) {
			const existingFiles = new Set(
				this.raw.shared_files.map((f) => f.file_id),
			);
			for (const f of meta.shared_files) {
				if (existingFiles.has(f.file_id)) continue;
				this.raw.shared_files.push(f);
			}
		}
		this.#diffAndNotify();
	}

	// Overwrites a persona's history — used to commit a completed turn.
	commitHistory(personaId: string, messages: ChatMessage[]): void {
		if (!this.raw) return;
		if (!this.raw.histories) this.raw.histories = {};
		this.raw.histories[personaId] = messages;
	}

	// Returns true when the message was accepted (all guards passed), so the
	// caller can clear its input exactly when the send actually starts. The
	// streaming work itself runs fire-and-forget — not awaited here — so this
	// stays synchronous, same as the old mutation's immediate `.mutate()`.
	sendMessage(rawMessage: string): boolean {
		const message = (rawMessage ?? "").trim();
		const activeContactId = this.activeContactId;
		if (!session.runId || !activeContactId || !message) return false;
		if (!this.activePersonaAvailable || this.isSending) return false;
		this.#runSend(activeContactId, message);
		return true;
	}

	async #runSend(personaId: string, message: string): Promise<void> {
		const priorMessages = this.serverHistories[personaId] ?? [];
		const overlayMessages = (streamedText: string): ChatMessage[] => [
			...priorMessages,
			{ role: "user", content: message },
			{ role: "assistant", content: streamedText },
		];

		this.streamingTurn = { personaId, messages: overlayMessages("") };
		this.isSending = true;
		let streamed = "";
		let receivedDone = false;
		let streamError: Error | null = null;
		try {
			await streamChat(`/api/simulations/${session.runId}/message`, {
				body: { persona_id: personaId, message } satisfies SendMessagePayload,
				onEvent: (event: StreamEvent) => {
					switch (event.type) {
						case "meta":
							this.applyMeta(personaId, event.data);
							break;
						case "delta":
							streamed += event.data.text ?? "";
							if (this.streamingTurn?.personaId === personaId) {
								this.streamingTurn = {
									personaId,
									messages: overlayMessages(streamed),
								};
							}
							break;
						case "done":
							receivedDone = true;
							if (Array.isArray(event.data.history))
								this.commitHistory(personaId, event.data.history);
							break;
						case "error":
							streamError = new Error(
								event.data.detail || "The reply could not be generated.",
							);
							break;
					}
				},
			});
			if (streamError) throw streamError;
			// No `done` frame (e.g. the connection closed cleanly mid-reply):
			// keep what streamed rather than losing it.
			if (!receivedDone)
				this.commitHistory(personaId, overlayMessages(streamed));
		} catch (err) {
			console.error(err);
			// The user's turn is kept (the server recorded it before streaming
			// began); the un-generated assistant reply is dropped.
			this.commitHistory(personaId, [
				...priorMessages,
				{ role: "user", content: message },
			]);
			if (
				err instanceof Error &&
				err.message === "This conversation has ended."
			) {
				const target = this.raw?.contacts?.find((c) => c.id === personaId);
				if (target) {
					target.chat_ended = true;
					target.chat_end_reason = target.chat_end_reason || "harassment";
				}
			} else {
				notify(
					(err instanceof Error && err.message) ||
						"Message failed. Please try again.",
				);
			}
		} finally {
			this.streamingTurn = null;
			this.isSending = false;
		}
	}
}

export const run = new RunStore();
