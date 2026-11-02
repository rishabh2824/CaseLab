import { getConvexClient } from "convex-svelte";
import { toast } from "svelte-sonner";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { appErrorData, ERROR_CODE } from "#shared/errors.js";
import { normalizeAccessCode } from "#shared/rules.js";
import { getErrorMessage } from "../errors.js";
import { CaseDraft } from "./caseDraft.svelte.js";
import { submitCase } from "./submitCase.js";

export type SaveResult =
	| { ok: true; caseId: string }
	| { ok: false; error: string };

// Loads a case into a CaseDraft and saves it back, tracking the loading and saving state the case form shows.
export class CaseFormStore {
	readonly draft = new CaseDraft();
	// The saved owner of the case being edited, once loaded.
	ownerAdminId = $state<string | null>(null);
	isLoading = $state(false);
	loadError = $state("");
	isSubmitting = $state(false);

	#inFlightSave: Promise<SaveResult> | null = null;

	// hasSource is true when a case or template is about to load into the draft; otherwise the blank draft is already clean.
	constructor(hasSource: boolean) {
		this.isLoading = hasSource;
		if (!hasSource) this.draft.markSaved();
	}

	// Loads a case (edit) or template (copy) from the server into the draft and marks it clean.
	async #fetch(id: string, isEditMode: boolean): Promise<void> {
		const client = getConvexClient();
		const caseId = id as Id<"cases">;
		if (isEditMode) {
			const loadedCase = await client.query(api.cases.getForEdit, { caseId });
			this.draft.load(loadedCase, { isEditMode });
			this.ownerAdminId = loadedCase.ownerAdminId;
		} else {
			this.draft.load(await client.query(api.cases.getTemplate, { caseId }), {
				isEditMode,
			});
		}
	}

	// Loads the source case into the draft, recording a failure in loadError.
	async load(id: string, isEditMode: boolean): Promise<void> {
		this.isLoading = true;
		this.loadError = "";
		try {
			await this.#fetch(id, isEditMode);
		} catch (err) {
			this.loadError = getErrorMessage(
				err,
				isEditMode
					? "Failed to load case for editing."
					: "Failed to load case template.",
			);
		} finally {
			this.isLoading = false;
		}
	}

	// Saves the draft as a new case, or over editCaseId. Reuses the save already in flight if there is one.
	save(editCaseId: string | null): Promise<SaveResult> {
		this.#inFlightSave ??= this.#runSave(editCaseId).finally(() => {
			this.#inFlightSave = null;
		});
		return this.#inFlightSave;
	}

	// Validates and submits the draft, then updates its baseline.
	async #runSave(editCaseId: string | null): Promise<SaveResult> {
		const { draft } = this;
		draft.revealErrors();
		if (draft.issues.length > 0) {
			return { ok: false, error: `This case still has ${draft.issuesLabel}.` };
		}
		this.loadError = "";
		this.isSubmitting = true;
		try {
			const { caseId } = await submitCase(draft.submitInput(editCaseId));
			toast(
				editCaseId !== null
					? "Case updated successfully."
					: "Case saved successfully.",
			);
			if (editCaseId !== null) {
				try {
					await this.#fetch(editCaseId, true);
				} catch {
					draft.markSaved();
				}
			} else {
				draft.markSaved();
			}
			return { ok: true, caseId };
		} catch (err) {
			const message = getErrorMessage(err, "Failed to save the case.");
			if (appErrorData(err)?.code === ERROR_CODE.ACCESS_CODE_TAKEN) {
				draft.takenAccessCode = normalizeAccessCode(draft.accessCode);
			}
			return { ok: false, error: message };
		} finally {
			this.isSubmitting = false;
		}
	}
}
