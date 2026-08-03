// Polls for a concurrent save while a case is open for editing (no
// WebSocket/live-push exists in this app — see services/cases.py's
// getCaseVersion).
import { ApiError, apiFetch } from "../api/client.js";
import type { Api } from "../types.js";

const POLL_INTERVAL_MS = 12000;

export type UseCaseVersionPollParams = {
	caseId: () => string | null;
	isLoadingSource: () => boolean;
};

class CaseVersionPoll {
	loadedVersion = $state<number | null>(null);
	showConflictModal = $state(false);

	#caseId: () => string | null;

	constructor(params: UseCaseVersionPollParams) {
		this.#caseId = params.caseId;
		// Only active once the case has actually finished loading, so it never
		// fires against a not-yet-populated loadedVersion.
		$effect(() => {
			const currentCaseId = params.caseId();
			if (!currentCaseId || params.isLoadingSource()) return;
			const intervalId = window.setInterval(async () => {
				if (this.showConflictModal) return;
				try {
					const { version } = await apiFetch<Api<"CaseVersionResponse">>(
						`/api/cases/${currentCaseId}/version`,
					);
					if (this.loadedVersion !== null && version !== this.loadedVersion) {
						this.showConflictModal = true;
					}
				} catch (err) {
					// A 401 means the session is gone (logged out / expired elsewhere) —
					// retrying every 12s forever would just spam the backend with an
					// admin who's never coming back to this tab. Stop polling; anything
					// else (network blip, 5xx) is transient, so keep retrying.
					if (err instanceof ApiError && err.status === 401) {
						window.clearInterval(intervalId);
					}
				}
			}, POLL_INTERVAL_MS);
			return () => window.clearInterval(intervalId);
		});
	}

	setLoadedVersion(version: number | null): void {
		this.loadedVersion = version;
	}

	// A successful edit-mode save just incremented the row's version by
	// exactly 1 server-side (that's the whole optimistic-lock mechanism —
	// see services/cases.py::updateCase). Without this, loadedVersion stays
	// stale and the next version-poll tick falsely detects a "conflict"
	// against the admin's own save.
	bumpVersion(): void {
		if (this.loadedVersion !== null) this.loadedVersion += 1;
	}

	// "Keep editing" — leaves every form field untouched, just quietly adopts
	// the current version so the next save's optimistic-lock check succeeds
	// instead of 409ing again. Not an auto-resubmit; the admin saves manually.
	async handleKeepEditing(): Promise<void> {
		this.showConflictModal = false;
		const currentCaseId = this.#caseId();
		if (!currentCaseId) return;
		try {
			const { version } = await apiFetch<Api<"CaseVersionResponse">>(
				`/api/cases/${currentCaseId}/version`,
			);
			this.loadedVersion = version;
		} catch {
			// If this fails, the next save just 409s again and re-shows the modal.
		}
	}
}

export function useCaseVersionPoll(
	params: UseCaseVersionPollParams,
): CaseVersionPoll {
	return new CaseVersionPoll(params);
}
