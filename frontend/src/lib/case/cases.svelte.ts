import { apiFetch } from "../api/client.js";
import type { Api } from "../types.js";

class CasesStore {
	list = $state<Api<"CaseSummary">[]>([]);
	isLoading = $state(false);
	error = $state("");

	async fetchAll() {
		this.isLoading = true;
		this.error = "";
		try {
			const data = await apiFetch<Api<"CaseListResponse">>("/api/cases");
			this.list = data?.cases ?? [];
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
