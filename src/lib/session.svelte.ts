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

// Reads the session this tab wrote to sessionStorage, falling back to defaults if it's missing or unparseable.
function readPersisted(): PersistedSession {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return defaults;
		return (JSON.parse(raw) as PersistedSession | null) ?? defaults;
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
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
		} catch {
			// Storage can be unavailable (private mode, quota); the run still works until the tab reloads.
		}
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
