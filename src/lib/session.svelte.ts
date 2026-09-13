import { browser } from "$app/environment";

const STORAGE_KEY = "caseLabSession";

// Student-run identity only -- there used to be an admin identity here too
// (adminRole/adminEmail, set from api/admins:viewer on sign-in), but nothing
// actually needed a sessionStorage-backed copy of it: the one real reader
// (admin/+page.svelte's "Manage admins" gate) now subscribes to that same
// live query directly, the same way admin/admins/+page.svelte's own gate
// already did (see its comment on why a stored copy is unreliable there --
// one tick behind the query, and still null on a cold reload).
export interface PersistedSession {
	runId: string;
	accessCode: string;
	startTime: number | null;
}

const defaults: PersistedSession = Object.freeze({
	runId: "",
	accessCode: "",
	startTime: null,
});

function normalizePersisted(value: unknown): PersistedSession {
	if (typeof value !== "object" || value === null) return defaults;
	const v = value as Record<string, unknown>;
	return {
		runId: typeof v.runId === "string" ? v.runId : defaults.runId,
		accessCode:
			typeof v.accessCode === "string" ? v.accessCode : defaults.accessCode,
		startTime:
			typeof v.startTime === "number" ? v.startTime : defaults.startTime,
	};
}

function readPersisted(): PersistedSession {
	if (!browser) return defaults;
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return defaults;
		return normalizePersisted(JSON.parse(raw) as unknown);
	} catch {
		return defaults;
	}
}

const initial = readPersisted();

class SessionStore {
	runId = $state<string>(initial.runId);
	accessCode = $state<string>(initial.accessCode);
	startTime = $state<number | null>(initial.startTime);

	#persist() {
		if (!browser) return;
		const persisted: PersistedSession = {
			runId: this.runId,
			accessCode: this.accessCode,
			startTime: this.startTime,
		};
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
	}

	// Called when a student simulation starts
	startRun({
		runId,
		accessCode,
		startTime,
	}: {
		runId: string;
		accessCode: string;
		startTime?: number | null;
	}) {
		this.runId = runId ?? "";
		this.accessCode = accessCode ?? "";
		this.startTime = startTime ?? Date.now();
		this.#persist();
	}

	setRunId(runId: string) {
		this.runId = runId;
		this.#persist();
	}

	// Clear a student run.
	clearRun() {
		this.runId = "";
		this.accessCode = "";
		this.startTime = null;
		this.#persist();
	}
}

export const session = new SessionStore();
