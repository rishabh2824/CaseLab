import { apiFetch } from "../api/client.js";
import type { Api } from "../types.js";

// Module-level singleton, so this outlives any one TemplatePicker mount —
// "choose a template" and "choose a case to edit" are separate routes that
// each mount TemplatePicker fresh, but they read the same case list, which
// doesn't change on its own between them.
class CasesStore {
	list = $state<Api<"CaseSummary">[]>([]);
	isLoading = $state(false);
	error = $state("");
	#loaded = false;
	#inFlight: Promise<void> | null = null;

	// Cached after the first successful load — TemplatePicker's onMount calls
	// this unconditionally every time it mounts, which used to mean a full
	// case-list re-fetch on every navigation into either route. deleteCase
	// below keeps the cache correct for deletes by updating `list` in place;
	// CaseForm.svelte calls invalidate() after a create/update so the next
	// fetchAll() picks up the change instead of serving stale cached data.
	async fetchAll(): Promise<void> {
		if (this.#inFlight) return this.#inFlight;
		if (this.#loaded) return;
		this.#inFlight = this.#load();
		try {
			await this.#inFlight;
		} finally {
			this.#inFlight = null;
		}
	}

	invalidate(): void {
		this.#loaded = false;
	}

	async #load(): Promise<void> {
		this.isLoading = true;
		this.error = "";
		try {
			const data = await apiFetch<Api<"CaseListResponse">>("/api/cases");
			this.list = data?.cases ?? [];
			this.#loaded = true;
		} catch (err) {
			this.error =
				(err instanceof Error && err.message) || "Failed to load cases.";
		} finally {
			this.isLoading = false;
		}
	}

	async deleteCase(caseId: number) {
		await apiFetch<Api<"CaseDeletedResponse">>(`/api/cases/${caseId}`, {
			method: "DELETE",
		});
		this.list = this.list.filter((c) => c.id !== caseId);
	}
}

export const cases = new CasesStore();
