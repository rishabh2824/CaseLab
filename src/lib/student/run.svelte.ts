import { makeFunctionReference } from "convex/server";
import { getConvexClient, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { resolveConvexSiteUrl } from "../convexUrl.js";
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
const getTurnStreamRef = makeFunctionReference<"query">(
	"api/turn:getTurnStream",
);
const startTurnRef = makeFunctionReference<"mutation">("api/turn:start");

import type {
	ExportSimulationOut,
	RunStateOut,
} from "../../../convex/services/simulations.js";
import type { TurnStreamOut } from "../../../convex/services/turn.js";

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
	// Flipped by #ensureExpiryWatch once the case's configured duration elapses -- folded into
	// activePersonaAvailable below so the composer disables in place instead of the student
	// being kicked out (see #ensureExpiryWatch's own comment).
	timeExpired = $state(false);

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
	// Set by #runSend, cleared once the sent turn settles or fails -- see the constructor's
	// effect below. Deliberately not "the history grew by N": a flagged message is never
	// stored (services/turn.ts's appendUserMessage), so a boundary reply grows the history by
	// one, not two, and any count-based check leaves the composer disabled until a reload.
	// $state, not a plain field: the effect below reads #sendingPersonaId, and a plain
	// field write is invisible to Svelte -- the effect would run once at construction
	// (when it's still null) and never again, so #runSend setting it later would silently
	// never trigger the recheck.
	#sendingPersonaId = $state<string | null>(null);

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
	// The turn this tab is driving (it won /turn-stream's claim -- see #drive) and the reply
	// read off its HTTP response so far. $state, not plain fields: streamingPreview and
	// #turnQuery's args read them.
	#driven = $state<{ personaId: string; streamId: string } | null>(null);
	#drivenText = $state("");
	#attemptedStreams = new Set<string>();
	// The active persona's latest turn (see convex/services/turn.ts's getTurnStream). The
	// persisted reply text is only requested when this tab isn't driving that turn -- a driving
	// tab reads it off its own HTTP stream, so its subscription only re-runs on status changes.
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
	// The turn that was current when #runSend started -- so the failure effect below doesn't
	// mistake an earlier turn's "error" for the new one's before the new turn replaces it.
	#sentOverStreamId: string | null = null;

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
	// The active persona's in-progress reply -- off this tab's own HTTP stream when it's driving
	// the turn, else the persisted copy. Null once the turn has settled (its reply is in
	// activeMessages, swapped in by the same server transaction) or failed, so callers don't
	// need to check status themselves.
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
		// Starts generating any turn on the active persona that no tab has claimed yet -- the one
		// this tab just sent, or one a closed/reloaded tab sent but never got to start. If
		// several tabs try, /turn-stream lets exactly one through (see #drive).
		$effect(() => {
			const turn = this.#turn;
			const personaId = this.activeContactId;
			if (!turn?.claimable || !personaId) return;
			if (this.#attemptedStreams.has(turn.streamId)) return;
			this.#attemptedStreams.add(turn.streamId);
			void this.#drive(personaId, turn.streamId);
		});
		// Clears isSending once the turn this tab sent ends: settled (the reply -- a normal or a
		// boundary one -- is persisted, in the same transaction that sets the flag, so it's already
		// in activeMessages), or failed ("error", or "timeout" from the component's own sweep of
		// a turn whose generation died), which also notifies. Scoped to the currently-viewed
		// contact, matching #turnQuery's own scope -- if the student switches away from the
		// persona they just messaged before the turn ends, this won't observe it there.
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
		this.activeContactId = null;
		// A restart gets a brand-new run_id, whose own (empty) notes need
		// re-seeding from storage below — otherwise the just-expired run's
		// notes would keep showing under the new one.
		this.notes = "";
		this.#notesInitialized = false;
		this.#seenInitialized = false;
		// timeExpired belongs to whichever run set it -- without resetting it here, a
		// replacement run would start with messaging already disabled. And since this can fire
		// (via "Run not found."/"Run expired.") before the OLD run's own #ensureExpiryWatch
		// interval ever got a chance to fire and self-clear, defensively clear it here too --
		// same orphaned-timer concern endSimulation() below already guards against, just for
		// this path instead of the manual-end one.
		this.timeExpired = false;
		if (this.#expiryInterval) window.clearInterval(this.#expiryInterval);
		this.#expiryInterval = null;
		if (session.accessCode) this.startSession(session.accessCode);
		else goto("/");
	}

	// Marks the run read-only once the case's configured duration elapses -- messaging is
	// disabled (activePersonaAvailable folds timeExpired in) but the student stays in the chat:
	// history, notes, and the PDF export all keep working. This intentionally matches
	// startTurn's own `c.duration` gate (convex/services/turn.ts) exactly, not run.expiresAt's
	// padded value (services/simulations.ts's computeExpiresAt) -- the backend already keeps
	// the run row alive for an extra grace period past this point specifically so reads/export
	// survive after sending stops, and #handleExpired's existing reaction to a genuine "Run
	// expired."/"Run not found." error is what ends that grace window, unchanged by this.
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
	// persona unavailable, message too long). Generation starts once #turnQuery shows the new
	// turn as claimable (see the effect that calls #drive), the reply streams in via
	// streamingPreview, the final persisted message arrives via #historyQuery, and updated
	// contacts/shared files arrive via the live getSimulationState subscription (raw) --
	// nothing here needs to patch any of that in by hand.
	async #runSend(personaId: string, message: string): Promise<void> {
		const runId = session.runId;
		// personaId is always activeContactId at the moment sendMessage calls this (see its
		// own body), so #historyQuery and #turn -- both keyed on activeContactId -- are already
		// this exact persona's data.
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
			notify(
				(err instanceof Error && err.message) ||
					"Message failed. Please try again.",
			);
		}
	}

	// Generates a claimed turn via /turn-stream (convex/http.ts) and reads the reply straight
	// off the response. The body is sent as a plain string, so fetch labels it text/plain --
	// that keeps this a CORS "simple" request with no preflight round trip before the reply
	// can start. A 409 (another tab claimed the turn first) or a dropped connection isn't a
	// failed turn -- generation carries on server-side either way -- so this tab just falls
	// back to following the persisted copy, via #turnQuery's withText.
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

export function createRunStore(): RunStore {
	return new RunStore();
}
