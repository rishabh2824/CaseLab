import { getConvexClient, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { personaAvailability } from "#shared/availability.js";
import { appErrorData, ERROR_CODE } from "#shared/errors.js";
import { goto } from "$app/navigation";
import { getErrorMessage } from "../errors.js";
import { session } from "../session.svelte.js";
import type { ChatMessage, Contact, SharedFile } from "../types.js";

export type DisplayContact = Contact & {
	available: boolean;
	expiresIn: number | null;
};

// Shows a short toast with the message.
const notify = (message: string) => toast(message, { duration: 4000 });

// The sessionStorage key a run's notes are kept under, so they survive a reload of the tab.
const notesKey = (runId: string) => `caselab:notes:${runId}`;

export class RunStore {
	loadError = $state("");
	activeContactId = $state<string | null>(null);
	// Read once here: the key is only the run id, which is already known when the store is created.
	notes = $state(
		session.runId
			? (sessionStorage.getItem(notesKey(session.runId)) ?? "")
			: "",
	);

	#seenContacts = new Set<string>();
	#seenFiles = new Set<string>();
	#seenInitialized = false;
	// The one clock everything time-based derives from, ticking once a second.
	#now = $state(Date.now());

	#runStateQuery = useQuery(api.runs.get, () =>
		session.runId ? { runId: session.runId as Id<"runs"> } : "skip",
	);
	#historyQuery = useQuery(api.runs.getPersonaHistory, () =>
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
	// When the in-flight reply was sent and when it may appear, null without a response delay. Kept as two numbers so they only change when the reply does.
	replySentAt = $derived(
		this.isSending ? (this.#history?.reply?.sentAt ?? null) : null,
	);
	replyDeliverAt = $derived(
		this.isSending ? (this.#history?.reply?.deliverAt ?? null) : null,
	);
	// The student's last message to the active contact, when generating its reply failed. It stays until they send again.
	failedMessage = $derived(this.#history?.failedMessage ?? null);

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
				expiresIn: availability.expiresIn,
			};
		}),
	);
	sharedFiles = $derived<SharedFile[]>(this.raw?.sharedFiles ?? []);
	activeMessages = $derived<ChatMessage[]>(this.#history?.messages ?? []);
	activeContact = $derived(
		this.contacts.find((c) => c.id === this.activeContactId) ?? null,
	);
	totalDurationSeconds = $derived(
		typeof this.caseData?.duration === "number"
			? this.caseData.duration * 60
			: null,
	);
	timeExpired = $derived(
		this.totalDurationSeconds !== null &&
			this.elapsedSeconds >= this.totalDurationSeconds,
	);
	activePersonaAvailable = $derived(
		!this.timeExpired &&
			this.activeContact?.available === true &&
			!this.activeContact.chatEnded,
	);

	// The store is built while the component initialises, so these effects live and die with it.
	constructor() {
		$effect(() => {
			const err = this.#runStateQuery.error;
			if (!err) {
				this.loadError = "";
				return;
			}
			// Reads never look at the clock, so an expired run only shows up as not found once it is destroyed.
			if (appErrorData(err)?.code === ERROR_CODE.RUN_NOT_FOUND) {
				this.endSimulation();
			} else {
				this.loadError = getErrorMessage(err, "Failed to load the simulation.");
			}
		});
		$effect(() => {
			if (this.raw) this.#afterLoad();
		});
		// The one-second clock that drives elapsed time, expiry and persona availability.
		$effect(() => {
			this.#now = Date.now();
			const interval = window.setInterval(() => {
				this.#now = Date.now();
			}, 1000);
			return () => window.clearInterval(interval);
		});
	}

	// Goes home if there is no run to resume. Never starts a new run itself: a simulation that has
	// ended stays ended, and a new one only begins when the student enters an access code.
	init(): void {
		if (!session.runId) goto("/");
	}

	// Restores the selected contact after the run loads, then updates notifications.
	#afterLoad(): void {
		if (this.activeContactId == null) {
			const rows = this.contacts;
			const remembered = rows.find((c) => c.id === session.activePersonaId);
			const first = remembered ?? rows.find((c) => c.available) ?? rows[0];
			if (first) this.activeContactId = first.id;
		}
		this.#diffAndNotify();
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

	// Selects a contact and remembers the choice in the session.
	selectContact(contactId: string): void {
		this.activeContactId = contactId;
		session.setActivePersona(contactId);
	}

	// Updates the notes and saves them to the tab's storage.
	setNotes(value: string): void {
		this.notes = value;
		if (session.runId) sessionStorage.setItem(notesKey(session.runId), value);
	}

	// Clears the notes and the run, and navigates home.
	endSimulation(): void {
		if (session.runId) sessionStorage.removeItem(notesKey(session.runId));
		session.clearRun();
		goto("/");
	}

	// Sends a trimmed message to the active contact and resolves to whether the server accepted it, toasting if it did not. The composer handles every other check.
	async sendMessage(rawMessage: string): Promise<boolean> {
		const message = rawMessage.trim();
		const personaId = this.activeContactId;
		if (!message || !personaId || !session.runId) return false;
		try {
			await getConvexClient().mutation(api.turns.sendMessage, {
				runId: session.runId as Id<"runs">,
				personaId,
				message,
			});
			return true;
		} catch (err) {
			const error = appErrorData(err);
			if (
				error?.code === ERROR_CODE.RUN_EXPIRED ||
				error?.code === ERROR_CODE.RUN_NOT_FOUND
			) {
				this.endSimulation();
			} else {
				notify(error?.message ?? "Message failed. Please try again.");
			}
			return false;
		}
	}
}

// Creates a new RunStore.
export function createRunStore(): RunStore {
	return new RunStore();
}
