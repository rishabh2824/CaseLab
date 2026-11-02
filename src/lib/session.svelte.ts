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

// Reads the session this tab wrote to sessionStorage, falling back to defaults if there is none.
function readPersisted(): PersistedSession {
	const raw = sessionStorage.getItem(STORAGE_KEY);
	return raw ? (JSON.parse(raw) as PersistedSession) : defaults;
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

	// Begins a run in the session, clearing the active persona.
	startRun({ runId, startTime }: { runId: string; startTime: number }) {
		this.runId = runId;
		this.startTime = startTime;
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
