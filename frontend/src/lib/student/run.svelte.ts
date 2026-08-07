import { getContext, setContext } from "svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import {
	ApiError,
	apiFetch,
	StreamInterruptedError,
	streamChat,
} from "../api/client.js";
import { session } from "../session.svelte.js";
import type {
	Api,
	Contact,
	RunState,
	SharedFile,
	StreamEvent,
	TurnMeta,
} from "../types.js";

const notify = (message: string) => toast(message, { duration: 4000 });

// How long to wait after the last keystroke before persisting notes, so
// typing doesn't fire a write per character. flushNotes() bypasses this.
const NOTES_SAVE_DEBOUNCE_MS = 800;

// Notes are scratch text, last-write-wins, and never needed on another device
// or after this tab closes — kept purely client-side (never sent to the
// backend) so autosaving them can't contend with reply persistence for the
// simulations row's write lock (services/simulation/run_store.py's
// SELECT ... FOR UPDATE) the way a PUT .../notes call used to. sessionStorage,
// not localStorage: session.svelte.ts already keys `session.runId` itself off
// sessionStorage (gone on tab close), so notes share that same lifetime
// instead of outliving the very id needed to look them up.
const NOTES_STORAGE_PREFIX = "caselab:notes:";

function notesStorageKey(runId: string): string {
	return `${NOTES_STORAGE_PREFIX}${runId}`;
}

function loadNotes(runId: string): string {
	try {
		return sessionStorage.getItem(notesStorageKey(runId)) ?? "";
	} catch {
		return "";
	}
}

function saveNotes(runId: string, notes: string): void {
	try {
		sessionStorage.setItem(notesStorageKey(runId), notes);
	} catch {
		// Storage full or unavailable (e.g. private browsing) — notes just
		// won't persist across reloads. Not worth interrupting typing over.
	}
}

function clearNotes(runId: string): void {
	try {
		sessionStorage.removeItem(notesStorageKey(runId));
	} catch {
		// Best-effort cleanup only.
	}
}

type StreamingTurn = {
	personaId: string;
	messages: Api<"ChatMessage">[];
};

let pendingRunState: RunState | null = null;

export function stashPendingRunState(state: RunState): void {
	pendingRunState = state;
}

export class RunStore {
	raw = $state<RunState | null>(null);
	loadError = $state("");
	activeContactId = $state<string | null>(null);
	streamingTurn = $state<StreamingTurn | null>(null);
	notes = $state("");
	isSending = $state(false);

	#initialized = false;
	#notesInitialized = false;
	#notesSaveTimer: number | null = null;
	#seenContacts = new Set<string>();
	#seenFiles = new Set<string>();
	#seenInitialized = false;
	#expiryInterval: number | null = null;

	caseData = $derived(this.raw?.case ?? null);
	contacts = $derived<Contact[]>(this.raw?.contacts ?? []);
	sharedFiles = $derived<SharedFile[]>(this.raw?.shared_files ?? []);
	serverHistories = $derived<Record<string, Api<"ChatMessage">[]>>(
		this.raw?.histories ?? {},
	);
	messagesByPersona = $derived<Record<string, Api<"ChatMessage">[]>>(
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
			this.selectedContact?.available && !this.selectedContact?.chat_ended,
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
		if (session.runId && pendingRunState?.run_id === session.runId) {
			this.raw = pendingRunState;
			pendingRunState = null;
			this.#afterLoad();
		} else if (session.runId) {
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
				body: { access_code: code } satisfies Api<"StartSimulationPayload">,
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
		if (!this.#notesInitialized && session.runId) {
			this.notes = loadNotes(session.runId);
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
		const expiredRunId = session.runId;
		if (expiredRunId) clearNotes(expiredRunId);
		session.setRunId("");
		this.activeContactId = null;
		// A restart gets a brand-new run_id, whose own (empty) notes need
		// re-seeding from storage below — otherwise the just-expired run's
		// notes would keep showing under the new one.
		this.notes = "";
		this.#notesInitialized = false;
		if (session.accessCode) this.startSession(session.accessCode);
		else goto("/");
	}

	// Auto-ends the run once the case's configured duration elapses.
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

	#saveNotesNow(): void {
		const id = session.runId;
		if (!id) return;
		saveNotes(id, this.notes);
	}

	endSimulation(): void {
		// No point flushing a final write here just to delete it on the next
		// line — cancel whatever's pending and go straight to clearing.
		if (this.#notesSaveTimer) {
			window.clearTimeout(this.#notesSaveTimer);
			this.#notesSaveTimer = null;
		}
		if (session.runId) clearNotes(session.runId);
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
	commitHistory(personaId: string, messages: Api<"ChatMessage">[]): void {
		if (!this.raw) return;
		if (!this.raw.histories) this.raw.histories = {};
		this.raw.histories[personaId] = messages;
	}

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
		const overlayMessages = (streamedText: string): Api<"ChatMessage">[] => [
			...priorMessages,
			{ role: "user", content: message },
			{ role: "assistant", content: streamedText },
		];

		this.streamingTurn = { personaId, messages: overlayMessages("") }
		const messages = this.streamingTurn.messages;
		const assistantMessage = messages[messages.length - 1];
		if (!assistantMessage) {
			throw new Error("Streaming turn was not initialized with a placeholder reply.");
		}
		this.isSending = true;
		let streamed = "";
		let receivedDone = false;
		let streamError: Error | null = null;
		let streamErrorCode: string | undefined;
		try {
			await streamChat(`/api/simulations/${session.runId}/message`, {
				body: {
					persona_id: personaId,
					message,
				} satisfies Api<"SendMessagePayload">,
				onEvent: (event: StreamEvent) => {
					switch (event.type) {
						case "meta":
							this.applyMeta(personaId, event.data);
							break;
						case "delta":
							streamed += event.data.text ?? "";
							if (this.streamingTurn?.personaId === personaId) {
								assistantMessage.content = streamed;
							}
							break;
						case "done":
							receivedDone = true;
							this.commitHistory(
								personaId,
								overlayMessages(event.data.reply ?? ""),
							);
							break;
						case "error":
							streamError = new Error(
								event.data.detail || "The reply could not be generated.",
							);
							streamErrorCode = event.data.code ?? undefined;
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
			if (err instanceof StreamInterruptedError) {
				await this.refresh(session.runId);
				notify("Connection interrupted. Reconnected to check for a reply.");
			} else {
				this.commitHistory(personaId, [
					...priorMessages,
					{ role: "user", content: message },
				]);
				if (streamErrorCode === "conversation_ended") {
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
			}
		} finally {
			this.streamingTurn = null;
			this.isSending = false;
		}
	}
}

const RUN_CONTEXT_KEY = Symbol("run-store");

export function setRunStore(): RunStore {
	const store = new RunStore();
	setContext(RUN_CONTEXT_KEY, store);
	return store;
}

export function getRunStore(): RunStore {
	return getContext(RUN_CONTEXT_KEY);
}
