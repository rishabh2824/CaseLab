import { makeFunctionReference } from "convex/server";
import { getConvexClient, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { session } from "../session.svelte.js";
import type { ChatMessage, Contact, SharedFile } from "../types.js";
import { personaAvailability } from "./availability.js";

// Exported so +page.svelte (start) and the student route's +page.svelte (export) can share
// these instead of each re-declaring their own copy.
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
const getStreamingPreviewRef = makeFunctionReference<"query">(
	"api/turn:getStreamingPreview",
);
const startTurnRef = makeFunctionReference<"mutation">("api/turn:start");

import type {
	ExportSimulationOut,
	RunStateOut,
} from "../../../convex/services/simulations.js";
import type { StreamingPreviewOut } from "../../../convex/services/turn.js";

// RunStateOut/ExportSimulationOut as-is, except run_id/case.id come back de-branded to plain
// `string`. Server-side those are Convex's Id<"runs">/Id<"cases">, but the student flow
// deliberately keeps its own function references string-based rather than switching to
// convex's generated `api` object the way the admin panel does -- nothing on the frontend can
// leverage that branding's compile-time table-matching anyway, so keeping it would only mean
// every test fixture constructing a fake run/case id needs an `as Id<...>` cast to satisfy a
// guarantee nothing here actually checks.
export type StartedRun = Omit<RunStateOut, "run_id" | "case"> & {
	run_id: string;
	case: Omit<RunStateOut["case"], "id"> & { id: string };
};
export type ExportRunOut = Omit<ExportSimulationOut, "case"> & {
	case: Omit<ExportSimulationOut["case"], "id"> & { id: string };
};

// A wire Contact plus its live-computed availability -- what RunStore.contacts (below)
// actually exposes. The wire Contact only carries available_at (a fixed minute); available/
// available_in/expires_in are derived from it against RunStore's own ticking clock, not the
// server's, since a query can't push updates on elapsed time alone (see ContactOut's comment
// in convex/services/simulations.ts). Snake_case here, not Availability's own
// camelCase, to match every other wire field on Contact -- the mapping happens once, in
// `contacts` below, the same boundary toContactOut used to own server-side.
export type DisplayContact = Contact & {
	available: boolean;
	available_in: number | null;
	expires_in: number | null;
};

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

export class RunStore {
	loadError = $state("");
	activeContactId = $state<string | null>(null);
	notes = $state("");
	isSending = $state(false);

	#initialized = false;
	#notesInitialized = false;
	#notesSaveTimer: number | null = null;
	#seenContacts = new Set<string>();
	#seenFiles = new Set<string>();
	#seenInitialized = false;
	#expiryInterval: number | null = null;
	// Ticked every 15s by #ensureAvailabilityTick (below) so `contacts` recomputes each
	// persona's availability against a live clock, instead of freezing at whatever it was
	// the last time the run's DATA changed. $state, not a plain field: `elapsedMinutes`
	// (below) reads it, and a plain field write wouldn't be visible to that $derived.
	#nowTick = $state(Date.now());
	#availabilityTickInterval: number | null = null;
	// Set by #runSend, cleared once serverHistories[personaId] grows by 2 past the count
	// captured at send time -- see the constructor's effect below. It takes 2, not 1: the
	// live query observes startTurn's own user-message insert (services/turn.ts) first,
	// before the reply exists, so clearing at +1 turned the input back on (and the guard
	// in sendMessage back off) while the reply was still generating -- confirmed live, not
	// just in theory: the Send button read "Send" instead of showing the typing indicator
	// mid-reply. +2 waits for that user message AND the one assistant message that follows
	// it, whether from a normal reply (applyDecisions) or a boundary reply (applyBoundary) --
	// both insert exactly one.
	// $state, not a plain field: the effect below reads #sendingPersonaId, and a plain
	// field write is invisible to Svelte -- the effect would run once at construction
	// (when it's still null) and never again, so #runSend setting it later would silently
	// never trigger the recheck.
	#sendingPersonaId = $state<string | null>(null);
	#sendingBaseline = 0;

	// The run's live state -- contacts, shared files, case info -- as a reactive Convex
	// subscription, not a one-shot fetch. This is what lets a completed turn (newly-unlocked
	// contact, updated chat-end state) simply appear without this store needing to manually
	// patch anything in after the fact. Carries no message histories -- see
	// convex/services/simulations.ts's RunStateOut comment for why; #historyQuery
	// below is the scoped replacement.
	#runStateQuery = useQuery(getSimulationStateRef, () =>
		session.runId ? { runId: session.runId } : "skip",
	);
	// Reactive subscription scoped to just the active persona's own messages (see
	// convex/services/simulations.ts's getPersonaHistory) -- NOT every visible persona's
	// history, so a turn landing for one persona doesn't re-push every OTHER persona's entire
	// transcript to a client only looking at one of them. The tradeoff: switching to a
	// contact whose history hasn't been subscribed to yet needs this query to resolve first,
	// unlike before when every persona's messages already sat in `raw`.
	#historyQuery = useQuery(getPersonaHistoryRef, () =>
		session.runId && this.activeContactId
			? { runId: session.runId, personaId: this.activeContactId }
			: "skip",
	);
	// Reactive subscription scoped to just the active persona's streamingReplies row (see
	// convex/services/turn.ts's getStreamingPreview) -- NOT the full run state, so runTurn's
	// batched deltas only re-render this one query's subscribers, not everything reading
	// `raw` below.
	#streamingPreviewQuery = useQuery(getStreamingPreviewRef, () =>
		session.runId && this.activeContactId
			? { runId: session.runId, personaId: this.activeContactId }
			: "skip",
	);

	raw = $derived<StartedRun | null>(this.#runStateQuery.data ?? null);
	caseData = $derived(this.raw?.case ?? null);
	// Minutes elapsed since the run started, against RunStore's own ticking clock -- not
	// re-derived from server data, since #nowTick (not `raw`) is what's supposed to drive
	// this. Falls back to 0 (nothing has elapsed) before session.startTime is known, same as
	// a brand-new run's own available_at=0 baseline.
	elapsedMinutes = $derived(
		session.startTime !== null
			? Math.max(0, Math.floor((this.#nowTick - session.startTime) / 60_000))
			: 0,
	);
	// Wire contacts (available_at only) mapped through personaAvailability against the live
	// clock above -- see DisplayContact's comment for why this mapping happens here instead
	// of server-side.
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
	// The active persona's transcript, live from Convex -- see #historyQuery's comment for
	// why this is scoped to just the active persona rather than every visible one.
	activeMessages = $derived<ChatMessage[]>(this.#historyQuery.data ?? []);
	// The active persona's in-progress reply, live from Convex -- null once the row is
	// missing/done/error, so callers don't need to check `status` themselves.
	streamingPreview = $derived<string | null>(
		(this.#streamingPreviewQuery.data as StreamingPreviewOut)?.status ===
			"streaming"
			? ((this.#streamingPreviewQuery.data as StreamingPreviewOut)?.text ??
					null)
			: null,
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

	// $effect.root, not a bare $effect: RunStore owns its reactive lifecycle rather than
	// depending on the call site (createRunStore(), a component's script) already being inside
	// a Svelte effect tree -- a real $effect created outside one throws immediately. This
	// also lets a test construct a RunStore directly with `new RunStore()` and have these
	// still run, the same as they do wired up through a mounted component.
	#dispose = $effect.root(() => {
		// Surfaces a run-not-found/expired/other error from the live subscription -- the
		// equivalent of the old one-shot refresh()'s catch block, just reactive now.
		$effect(() => {
			const err = this.#runStateQuery.error;
			if (!err) {
				// A transient failure (network blip, momentary server error) clears once the
				// subscription recovers on its own -- without this, the banner set below would
				// stay up forever even after a subsequent update succeeds.
				this.loadError = "";
				return;
			}
			if (err.message === "Run not found." || err.message === "Run expired.") {
				this.#handleExpired();
			} else {
				this.loadError = err.message || "Failed to load the simulation.";
			}
		});
		// Runs on every reactive update, not just the first -- #afterLoad's own pieces are
		// each idempotent/guarded (notes load once, activeContactId set once, expiry watch
		// arms once), except #diffAndNotify, which is DESIGNED to run on every update: that's
		// what lets a newly-unlocked contact or shared file notify in real time now, instead
		// of only at the next manual refresh.
		$effect(() => {
			if (this.raw) this.#afterLoad();
		});
		// Clears isSending once the persona being sent to has both its new user message
		// AND a reply persisted -- see #sendingPersonaId's comment for why +2, not +1.
		// Scoped to the currently-viewed contact, matching #historyQuery's own scope (see its
		// comment): if the student switches away from the persona they just messaged before
		// the reply lands, this won't observe it there, the same limitation the error-
		// detection effect below already has.
		$effect(() => {
			const personaId = this.#sendingPersonaId;
			if (!personaId || personaId !== this.activeContactId) return;
			const count = this.#historyQuery.data?.length ?? 0;
			if (count >= this.#sendingBaseline + 2) {
				this.#sendingPersonaId = null;
				this.isSending = false;
			}
		});
		// Clears isSending (and notifies) if runTurn failed server-side instead of ever
		// persisting a reply -- see convex/services/turn.ts's markStreamingError. Without
		// this, a failed turn left isSending stuck true forever: the effect above only ever
		// clears it by observing a new persisted message, and a failed turn never produces
		// one. Scoped to the currently-viewed contact, matching streamingPreview's own scope
		// (see its comment) -- if the student switches away from the persona they just
		// messaged before the reply fails, this won't catch it there, the same pre-existing
		// limitation the effect above has (neither watches a persona once it's no longer
		// active).
		$effect(() => {
			const personaId = this.#sendingPersonaId;
			if (!personaId || personaId !== this.activeContactId) return;
			if (
				(this.#streamingPreviewQuery.data as StreamingPreviewOut)?.status !==
				"error"
			)
				return;
			this.#sendingPersonaId = null;
			this.isSending = false;
			notify(
				"Something went wrong generating a reply. Please resend your message.",
			);
		});
	});

	// Establishes a run exactly once: resume a persisted runId (the reactive query above
	// picks it up automatically), else start from the access code, else bail home.
	async init(): Promise<void> {
		if (this.#initialized) return;
		this.#initialized = true;
		if (session.runId) return;
		if (session.accessCode) {
			await this.startSession(session.accessCode);
		} else {
			goto("/");
		}
	}

	async startSession(code: string): Promise<void> {
		try {
			const fresh = (await getConvexClient().mutation(startSimulationRef, {
				accessCode: code,
			})) as StartedRun;
			session.startRun({
				runId: fresh.run_id,
				accessCode: code,
				startTime: Date.now(),
			});
			// #runStateQuery's reactive subscription (now keyed on session.runId) picks up
			// this exact state within a moment -- no need to assign anything manually.
		} catch {
			goto("/");
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
		this.#ensureAvailabilityTick();
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
		// Released here because the two effects that normally clear it are both scoped to
		// `personaId === activeContactId`, and the very next line nulls activeContactId -- so
		// once a run expires mid-send, neither can ever observe the reply that would have
		// released the guard. #handleExpired then starts a REPLACEMENT run from the stored
		// access code, and without this the student lands in a working new simulation whose
		// composer is permanently disabled, recoverable only by reloading the page.
		this.isSending = false;
		this.#sendingPersonaId = null;
		this.#sendingBaseline = 0;
		this.activeContactId = null;
		// A restart gets a brand-new run_id, whose own (empty) notes need
		// re-seeding from storage below — otherwise the just-expired run's
		// notes would keep showing under the new one.
		this.notes = "";
		this.#notesInitialized = false;
		this.#seenInitialized = false;
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

	// Ticks #nowTick every 15s so `contacts` recomputes availability against a live clock --
	// see #nowTick's own comment for why this is needed at all. 15s, not 1s (unlike
	// #ensureExpiryWatch above): availability changes in whole-minute increments, so
	// finer-grained ticking would only add reactivity churn without the display ever
	// actually showing a difference.
	#ensureAvailabilityTick(): void {
		if (this.#availabilityTickInterval) return;
		this.#availabilityTickInterval = window.setInterval(() => {
			this.#nowTick = Date.now();
		}, 15_000);
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
		// Without this, #ensureExpiryWatch's interval (armed with THIS run's own start/
		// totalDurationSeconds, captured in its closure) keeps ticking after this call
		// navigates away. `session` is a module singleton, so once a later run starts and
		// this orphaned timer's original deadline arrives, it fires endSimulation() again --
		// on the CURRENT run: clearNotes(session.runId) deletes the new run's notes, and
		// session.clearRun() + goto("/") boots the student out of a simulation they're
		// actively in. See destroy()'s comment for why neither window.setInterval nor
		// $effect.root is torn down by component unmount on its own.
		if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
		this.#expiryInterval = null;
		if (session.runId) clearNotes(session.runId);
		session.clearRun();
		goto("/");
	}

	// Tears down this store's reactive subscriptions/effects/timers. Must be called from the
	// hosting component's onDestroy -- unlike a bare $effect (see SimulationClock.svelte's own
	// $effect, which returns a cleanup Svelte runs automatically), neither #dispose
	// ($effect.root's own tree) nor a window.setInterval is torn down by component unmount.
	// Both deliberately outlive it: that's the entire point of $effect.root, and
	// window.setInterval is a browser-level timer with no notion of Svelte's component tree at
	// all. Skipping this call is what let an orphaned #expiryInterval survive navigation and
	// later fire endSimulation() against a subsequent run -- see endSimulation's own comment.
	destroy(): void {
		this.#dispose();
		if (this.#availabilityTickInterval)
			window.clearInterval(this.#availabilityTickInterval);
		if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
		this.#availabilityTickInterval = null;
		this.#expiryInterval = null;
	}

	sendMessage(rawMessage: string): boolean {
		const message = (rawMessage ?? "").trim();
		const activeContactId = this.activeContactId;
		if (!session.runId || !activeContactId || !message) return false;
		if (!this.activePersonaAvailable || this.isSending) return false;
		this.#runSend(activeContactId, message);
		return true;
	}

	// A plain Convex mutation (api/turn:start): it only confirms the message was accepted (or
	// rejects with a plain, user-presentable Error -- rate limited, conversation ended,
	// persona unavailable, message too long). The actual reply streams in via
	// streamingPreview above, the final persisted message arrives via #historyQuery, and
	// updated contacts/shared files arrive via the live getSimulationState subscription (raw)
	// -- nothing here needs to patch any of that in by hand.
	async #runSend(personaId: string, message: string): Promise<void> {
		const runId = session.runId;
		// personaId is always activeContactId at the moment sendMessage calls this (see its
		// own body), so #historyQuery -- keyed on activeContactId -- is already this exact
		// persona's data.
		this.#sendingBaseline = this.#historyQuery.data?.length ?? 0;
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
			notify(
				(err instanceof Error && err.message) ||
					"Message failed. Please try again.",
			);
		}
	}
}

export function createRunStore(): RunStore {
	return new RunStore();
}
