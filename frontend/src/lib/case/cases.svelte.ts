import { apiFetch } from "../api/client.js";
import type {
	CaseDeletedResponse,
	CaseListResponse,
	CaseSummary,
} from "../types.js";

class CasesStore {
	list = $state<CaseSummary[]>([]);
	isLoading = $state(false);
	error = $state("");

	async fetchAll() {
		this.isLoading = true;
		this.error = "";
		try {
			const data = await apiFetch<CaseListResponse>("/api/cases");
			this.list = data?.cases ?? [];
		} catch (err) {
			this.error =
				(err instanceof Error && err.message) || "Failed to load cases.";
		} finally {
			this.isLoading = false;
		}
	}

	async deleteCase(caseId: number) {
		await apiFetch<CaseDeletedResponse>(`/api/cases/${caseId}`, {
			method: "DELETE",
		});
		this.list = this.list.filter((c) => c.id !== caseId);
	}
}

export const cases = new CasesStore();
