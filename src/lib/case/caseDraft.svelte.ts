import { getCaseInfoErrors } from "../../../convex/lib/caseRules.js";
import type { CaseStructure } from "../../../convex/models/cases.js";
import { hasFieldErrors } from "./draft.js";
import type { BuildHTMLFormInput } from "./exportCase.js";
import { CaseGraph } from "./graph.svelte.js";
import type { ImportedCaseData } from "./importCase.js";
import type { SubmitCaseInput } from "./submitCase.js";

// The case fields the form loads from the server, for both editing and templating.
export type LoadableCase = {
	name: string;
	brief: string;
	commonInformation: string;
	duration?: number | null;
	accessCode: string;
	structure: CaseStructure;
	collaboratorAdminIds?: string[];
};

// Replaces File values with a small descriptor so the draft can be snapshotted as JSON.
function fileReplacer(_key: string, value: unknown): unknown {
	if (value instanceof File) {
		return {
			name: value.name,
			size: value.size,
			lastModified: value.lastModified,
		};
	}
	return value;
}

// Everything the case form edits: the case fields, its persona graph and the validation and dirty state around them.
export class CaseDraft {
	caseName = $state("");
	initialBrief = $state("");
	commonInformation = $state("");
	simulationDurationMinutes = $state<number | null>(null);
	accessCode = $state("");
	collaboratorAdminIds = $state<string[]>([]);
	readonly graph = new CaseGraph();
	showErrors = $state(false);

	#baseline = $state<string | null>(null);

	errors = $derived(
		getCaseInfoErrors({
			caseName: this.caseName,
			initialBrief: this.initialBrief,
			accessCode: this.accessCode,
			simulationDurationMinutes: this.simulationDurationMinutes,
		}),
	);
	hasErrors = $derived(
		hasFieldErrors(this.errors) || this.graph.validation.hasErrors,
	);
	isDirty = $derived(
		this.#baseline !== null && this.#snapshot() !== this.#baseline,
	);

	// The five case information fields, listed once for the snapshot, the export and the submit.
	#fields() {
		return {
			caseName: this.caseName,
			initialBrief: this.initialBrief,
			commonInformation: this.commonInformation,
			simulationDurationMinutes: this.simulationDurationMinutes,
			accessCode: this.accessCode,
		};
	}

	// Serializes every edited value to a string for change detection.
	#snapshot(): string {
		return JSON.stringify(
			{
				...this.#fields(),
				collaboratorAdminIds: this.collaboratorAdminIds,
				personas: this.graph.personas,
				referrals: this.graph.referrals,
				roots: this.graph.roots,
			},
			fileReplacer,
		);
	}

	// Records the current values as the clean baseline for dirty tracking.
	markSaved(): void {
		this.#baseline = this.#snapshot();
	}

	// Turns on display of field validation errors.
	revealErrors(): void {
		this.showErrors = true;
	}

	// Whether the form already holds something worth confirming before it is replaced.
	get hasContent(): boolean {
		return Boolean(
			this.caseName.trim() ||
				this.initialBrief.trim() ||
				this.accessCode.trim() ||
				this.graph.personas.length > 0,
		);
	}

	// Fills the draft from a case loaded from the server and marks it clean. A template gets no access code or collaborators.
	load(loaded: LoadableCase, { isEditMode }: { isEditMode: boolean }): void {
		this.caseName = loaded.name ?? "";
		this.initialBrief = loaded.brief ?? "";
		this.commonInformation = loaded.commonInformation ?? "";
		this.simulationDurationMinutes = loaded.duration ?? null;
		this.accessCode = isEditMode ? loaded.accessCode : "";
		this.graph.load(loaded.structure);
		if (isEditMode)
			this.collaboratorAdminIds = loaded.collaboratorAdminIds ?? [];
		this.revealErrors();
		this.markSaved();
	}

	// Replaces the draft with an imported case file, leaving it dirty so it still has to be saved.
	applyImport(data: ImportedCaseData): void {
		this.caseName = data.caseName;
		this.accessCode = data.accessCode;
		this.initialBrief = data.initialBrief;
		this.commonInformation = data.commonInformation;
		this.simulationDurationMinutes = data.simulationDurationMinutes;
		this.graph.load({
			personas: data.personas,
			referrals: data.referrals,
			roots: data.roots,
		});
		this.revealErrors();
	}

	// The values the HTML export needs.
	exportInput(): BuildHTMLFormInput {
		return {
			...this.#fields(),
			personas: this.graph.personas,
			referrals: this.graph.referrals,
			roots: this.graph.roots,
		};
	}

	// The values submitCase needs to create the case, or to update it when editCaseId is set.
	submitInput(editCaseId: string | null): SubmitCaseInput {
		return {
			editCaseId,
			...this.#fields(),
			personas: this.graph.personas,
			referrals: this.graph.referrals,
			roots: this.graph.roots,
			collaboratorAdminIds: this.collaboratorAdminIds,
		};
	}
}
