import type { FunctionReturnType } from "convex/server";
import type { api } from "#convex/api.js";
import {
	ACCESS_CODE_CONFLICT,
	type CaseIssue,
	casePath,
	type FieldPath,
	getCaseIssues,
	normalizeAccessCode,
} from "#shared/rules.js";
import type {
	CollaboratorPayload,
	FileRefPayload,
} from "#shared/validators.js";
import type { CaseInfo } from "../types.js";
import type { BuildHTMLFormInput } from "./exportCase.js";
import { pathKey } from "./fieldPath.js";
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
	name = $state("");
	brief = $state("");
	commonInformation = $state("");
	duration = $state<number | null>(null);
	accessCode = $state("");
	teachingNotes = $state<File | FileRefPayload | null>(null);
	// Where the saved teaching notes can be downloaded, when editing a case that has them.
	teachingNotesUrl = $state<string | null>(null);
	collaborators = $state<CollaboratorPayload[]>([]);
	// False when the loaded case is only shared with the viewer for reading.
	canEdit = $state(true);
	readonly graph = new CaseGraph();
	showErrors = $state(false);
	// Case information fields the user has typed in, keyed by pathKey.
	touched = $state<Record<string, boolean>>({});
	// The access code the server last refused as taken. Only the server can know this, so it is held here until the code changes.
	takenAccessCode = $state<string | null>(null);

	#baseline = $state<string | null>(null);

	// Everything stopping this case from saving. Derived, so a problem disappears the moment it is fixed.
	issues: CaseIssue[] = $derived.by(() => {
		const issues = getCaseIssues({
			...this.#fields(),
			personas: this.graph.personas,
			referrals: this.graph.referrals,
		});
		if (normalizeAccessCode(this.accessCode) === this.takenAccessCode) {
			issues.push({
				path: casePath("accessCode"),
				message: ACCESS_CODE_CONFLICT,
			});
		}
		return issues;
	});
	issuesLabel = $derived(
		this.issues.length === 1
			? "1 thing to fix"
			: `${this.issues.length} things to fix`,
	);
	isDirty = $derived(
		this.#baseline !== null && this.#snapshot() !== this.#baseline,
	);

	// The five case information fields, listed once for the snapshot, the export and the submit.
	#fields(): CaseInfo {
		return {
			name: this.name,
			brief: this.brief,
			commonInformation: this.commonInformation,
			duration: this.duration,
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

	// Marks one case information field as edited, so only its own error shows before a save.
	touch(path: FieldPath): void {
		this.touched[pathKey(path)] = true;
	}

	// Returns the problem to show on a field: once the user has edited it, or once errors are revealed form-wide.
	errorFor(path: FieldPath): string | undefined {
		const key = pathKey(path);
		if (!this.showErrors && !this.touched[key]) return undefined;
		return this.issues.find((issue) => pathKey(issue.path) === key)?.message;
	}

	// Whether the form already holds something worth confirming before it is replaced.
	get hasContent(): boolean {
		return Boolean(
			this.name.trim() ||
				this.brief.trim() ||
				this.accessCode.trim() ||
				this.graph.personas.length > 0,
		);
	}

	// Fills the draft from a case loaded from the server and marks it clean. A template has no access code, teaching notes or collaborators, so those stay empty.
	load(loaded: LoadableCase, { isEditMode }: { isEditMode: boolean }): void {
		this.name = loaded.name;
		this.brief = loaded.brief;
		this.commonInformation = loaded.commonInformation;
		this.duration = loaded.duration ?? null;
		// The form edits missing values as null, so the snapshot taken below matches what an edit produces.
		this.graph.load({
			personas: loaded.structure.personas.map((persona) => ({
				...persona,
				profilePhoto: persona.profilePhoto ?? null,
				availabilityMinutes: persona.availabilityMinutes ?? null,
			})),
			referrals: loaded.structure.referrals,
		});
		if (isEditMode && "canEdit" in loaded) {
			this.accessCode = loaded.accessCode;
			this.teachingNotes = loaded.teachingNotes ?? null;
			this.teachingNotesUrl = loaded.teachingNotesUrl;
			this.canEdit = loaded.canEdit;
			this.collaborators = loaded.collaborators;
			// An older case may predate today's rules, so its editor sees what to fix straight away. A template copy has only just started, and a view-only reader can't fix anything.
			if (loaded.canEdit) this.revealErrors();
		}
		this.markSaved();
	}

	// Replaces the draft with an imported case file, leaving it dirty so it still has to be saved.
	applyImport(data: ImportedCaseData): void {
		this.name = data.name;
		this.accessCode = data.accessCode;
		this.brief = data.brief;
		this.commonInformation = data.commonInformation;
		this.duration = data.duration;
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
