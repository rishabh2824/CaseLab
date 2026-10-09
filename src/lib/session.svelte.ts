const STORAGE_KEY = "caseLabSession";

export interface PersistedSession {
	runId: string;
	startTime: number | null;
	activePersonaId: string;
}

const defaults: PersistedSession = Object.freeze({
	runId: "",
	startTime: null,
	activePersonaId: "",
});

// Validates a stored session blob field by field, defaulting anything missing or malformed.
function normalizePersisted(value: unknown): PersistedSession {
	if (typeof value !== "object" || value === null) return defaults;
	const v = value as Record<string, unknown>;
	return {
		runId: typeof v.runId === "string" ? v.runId : defaults.runId,
		startTime:
			typeof v.startTime === "number" ? v.startTime : defaults.startTime,
		activePersonaId:
			typeof v.activePersonaId === "string"
				? v.activePersonaId
				: defaults.activePersonaId,
	};
}

// Reads the session from sessionStorage, falling back to defaults on missing or bad data.
function readPersisted(): PersistedSession {
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
	startTime = $state<number | null>(initial.startTime);
	activePersonaId = $state<string>(initial.activePersonaId);

	// Writes the current session to sessionStorage.
	#persist() {
		const persisted: PersistedSession = {
			runId: this.runId,
			startTime: this.startTime,
			activePersonaId: this.activePersonaId,
		};
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
	}

	// Begins a run in the session, defaulting the start time to now and clearing the active persona.
	startRun({ runId, startTime }: { runId: string; startTime?: number | null }) {
		this.runId = runId ?? "";
		this.startTime = startTime ?? Date.now();
		this.activePersonaId = "";
		this.#persist();
	}

	// Remembers which persona is selected.
	setActivePersona(personaId: string) {
		this.activePersonaId = personaId;
		this.#persist();
	}

	// Clears all run fields from the session.
	clearRun() {
		this.runId = "";
		this.startTime = null;
		this.activePersonaId = "";
		this.#persist();
	}
}

export const session = new SessionStore();
