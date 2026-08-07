import { browser } from "$app/environment";
import { ADMIN_ROLE } from "./constants.js";
import type { Api } from "./types.js";

const STORAGE_KEY = "caseLabSession";

export interface PersistedSession {
	adminRole: Api<"AdminRole"> | null;
	adminEmail: string;
	runId: string;
	accessCode: string;
	startTime: number | null;
}

const defaults: PersistedSession = Object.freeze({
	adminRole: null,
	adminEmail: "",
	runId: "",
	accessCode: "",
	startTime: null,
});

const isAdminRole = (value: unknown): value is Api<"AdminRole"> =>
	value === ADMIN_ROLE.SUPER || value === ADMIN_ROLE.ADMIN;

function normalizePersisted(value: unknown): PersistedSession {
	if (typeof value !== "object" || value === null) return defaults;
	const v = value as Record<string, unknown>;
	return {
		adminRole: isAdminRole(v.adminRole) ? v.adminRole : defaults.adminRole,
		adminEmail:
			typeof v.adminEmail === "string" ? v.adminEmail : defaults.adminEmail,
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
	adminRole = $state<Api<"AdminRole"> | null>(initial.adminRole);
	adminEmail = $state<string>(initial.adminEmail);
	runId = $state<string>(initial.runId);
	accessCode = $state<string>(initial.accessCode);
	startTime = $state<number | null>(initial.startTime);

	#persist() {
		if (!browser) return;
		const persisted: PersistedSession = {
			adminRole: this.adminRole,
			adminEmail: this.adminEmail,
			runId: this.runId,
			accessCode: this.accessCode,
			startTime: this.startTime,
		};
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
	}

	setAdmin({
		adminRole,
		adminEmail,
	}: {
		adminRole: Api<"AdminRole"> | null;
		adminEmail: string;
	}) {
		this.adminRole = adminRole ?? null;
		this.adminEmail = adminEmail ?? "";
		this.#persist();
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

	// Clear a student run (keeps admin session).
	clearRun() {
		this.runId = "";
		this.accessCode = "";
		this.startTime = null;
		this.#persist();
	}

	// Clear the admin UI state
	clearAdmin() {
		this.adminRole = null;
		this.adminEmail = "";
		this.#persist();
	}
}

export const session = new SessionStore();
