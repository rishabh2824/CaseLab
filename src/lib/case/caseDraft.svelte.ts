import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api.js";
import { getCaseInfoErrors } from "../../../convex/lib/caseRules.js";
import type {
	CollaboratorPayload,
	FileRefPayload,
} from "../../../convex/models/cases.js";
import type { CaseInfo } from "../types.js";
import { hasFieldErrors } from "./draft.js";
import type { BuildHTMLFormInput } from "./exportCase.js";
import { CaseGraph } from "./graph.svelte.js";
import type { ImportedCaseData } from "./importCase.js";
import type { SubmitCaseInput } from "./submitCase.js";

// What the form loads from the server: a case opened for editing, or a template to copy.
export type LoadableCase =
	| FunctionReturnType<typeof api.cases.getForEdit>
	| FunctionReturnType<typeof api.cases.getTemplate>;

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
	teachingNotes = $state<File | FileRefPayload | null>(null);
	// Where the saved teaching notes can be downloaded, when editing a case that has them.
	teachingNotesUrl = $state<string | null>(null);
	collaborators = $state<CollaboratorPayload[]>([]);
	// False when the loaded case is only shared with the viewer for reading.
	canEdit = $state(true);
	readonly graph = new CaseGraph();
	showErrors = $state(false);
	// Case information fields the user has typed in, keyed by their error name.
	touched = $state<Record<string, boolean>>({});

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
	#fields(): CaseInfo {
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
				teachingNotes: this.teachingNotes,
				collaborators: this.collaborators,
				personas: this.graph.personas,
				referrals: this.graph.referrals,
			},
			fileReplacer,
		);
	}

	// Records the current values as the clean baseline for dirty tracking.
	markSaved(): void {
		this.#baseline = this.#snapshot();
	}

	// Turns on display of every field's validation errors.
	revealErrors(): void {
		this.showErrors = true;
	}

	// Marks one case information field as edited, so only its own error shows before a submit.
	touch(field: string): void {
		this.touched[field] = true;
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

	// Fills the draft from a case loaded from the server and marks it clean. A template gets no access code, teaching notes or collaborators.
	load(loaded: LoadableCase, { isEditMode }: { isEditMode: boolean }): void {
		// Only a case opened for editing has an access code, teaching notes and collaborators.
		const editing = isEditMode && "canEdit" in loaded ? loaded : null;
		this.caseName = loaded.name;
		this.initialBrief = loaded.brief;
		this.commonInformation = loaded.commonInformation;
		this.simulationDurationMinutes = loaded.duration ?? null;
		this.accessCode = editing?.accessCode ?? "";
		// The form edits missing values as null, so the snapshot taken below matches what an edit produces.
		this.graph.load({
			personas: loaded.structure.personas.map((persona) => ({
				...persona,
				profilePhoto: persona.profilePhoto ?? null,
				availabilityMinutes: persona.availabilityMinutes ?? null,
			})),
			referrals: loaded.structure.referrals,
		});
		this.teachingNotes = editing?.teachingNotes ?? null;
		this.teachingNotesUrl = editing?.teachingNotesUrl ?? null;
		this.canEdit = editing?.canEdit ?? true;
		if (editing) this.collaborators = editing.collaborators;
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
		});
		this.revealErrors();
	}

	// The values the HTML export needs.
	exportInput(): BuildHTMLFormInput {
		return {
			...this.#fields(),
			personas: this.graph.personas,
			referrals: this.graph.referrals,
		};
	}

	// The values submitCase needs to create the case, or to update it when editCaseId is set.
	submitInput(editCaseId: string | null): SubmitCaseInput {
		return {
			editCaseId,
			...this.#fields(),
			personas: this.graph.personas,
			referrals: this.graph.referrals,
			teachingNotes: this.teachingNotes,
			collaborators: this.collaborators,
		};
	}
}
