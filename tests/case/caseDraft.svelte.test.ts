import { describe, expect, it } from "vitest";
import {
	CaseDraft,
	type LoadableCase,
} from "../../src/lib/case/caseDraft.svelte.js";
import { makePersonaPayload } from "../support/fixtures.js";

// Builds a case as the server returns it for editing, with one root persona.
function loadable(overrides: Partial<LoadableCase> = {}): LoadableCase {
	return {
		name: "Sterling",
		brief: "Cut costs.",
		commonInformation: "Background.",
		duration: 30,
		accessCode: "sterling",
		structure: {
			personas: [makePersonaPayload({ id: "a", name: "Mary", role: "CFO" })],
			referrals: [],
			roots: ["a"],
		},
		collaboratorAdminIds: ["admin-2"],
		...overrides,
	};
}

describe("CaseDraft", () => {
	// Tests that a new draft is clean until the first change, and clean again after markSaved.
	it("is clean at first, dirty after an edit, and clean again once marked saved", () => {
		const draft = new CaseDraft();
		draft.markSaved();
		expect(draft.isDirty).toBe(false);

		draft.caseName = "Changed";
		expect(draft.isDirty).toBe(true);

		draft.markSaved();
		expect(draft.isDirty).toBe(false);
	});

	// Tests that a draft that was never marked saved (a case still loading) is never dirty.
	it("is not dirty before it has a baseline", () => {
		const draft = new CaseDraft();
		draft.caseName = "Typed while loading";
		expect(draft.isDirty).toBe(false);
	});

	// Tests that every kind of edit counts: fields, collaborators and the persona graph.
	it.each([
		["a case field", (d: CaseDraft) => (d.initialBrief = "New brief")],
		["the duration", (d: CaseDraft) => (d.simulationDurationMinutes = 45)],
		[
			"a collaborator",
			(d: CaseDraft) => d.collaboratorAdminIds.push("admin-3"),
		],
		["a persona", (d: CaseDraft) => (d.graph.personas[0]!.name = "Renamed")],
	])("becomes dirty when %s changes", (_label, edit) => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: true });
		expect(draft.isDirty).toBe(false);

		edit(draft);

		expect(draft.isDirty).toBe(true);
	});

	// Tests that loading for editing keeps the access code and collaborators and starts clean with errors revealed.
	it("loads a case for editing in full and starts clean", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: true });

		expect(draft.caseName).toBe("Sterling");
		expect(draft.accessCode).toBe("sterling");
		expect(draft.simulationDurationMinutes).toBe(30);
		expect(draft.collaboratorAdminIds).toEqual(["admin-2"]);
		expect(draft.graph.personas).toHaveLength(1);
		expect(draft.showErrors).toBe(true);
		expect(draft.isDirty).toBe(false);
	});

	// Tests that loading a template copies the content but not the access code or collaborators.
	it("loads a template without its access code or collaborators", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: false });

		expect(draft.caseName).toBe("Sterling");
		expect(draft.accessCode).toBe("");
		expect(draft.collaboratorAdminIds).toEqual([]);
	});

	// Tests that an imported file replaces the content but leaves the draft dirty, so it still has to be saved.
	it("applies an import and stays dirty", () => {
		const draft = new CaseDraft();
		draft.markSaved();

		draft.applyImport({
			caseName: "Imported",
			accessCode: "imported",
			simulationDurationMinutes: null,
			initialBrief: "Brief",
			commonInformation: "",
			personas: [],
			referrals: [],
			roots: [],
		});

		expect(draft.caseName).toBe("Imported");
		expect(draft.showErrors).toBe(true);
		expect(draft.isDirty).toBe(true);
	});

	// Tests that hasContent reports whether anything worth confirming before a replace is in the draft.
	it("reports content only once something meaningful is entered", () => {
		const draft = new CaseDraft();
		expect(draft.hasContent).toBe(false);

		draft.caseName = "   ";
		expect(draft.hasContent).toBe(false);

		draft.accessCode = "code";
		expect(draft.hasContent).toBe(true);
	});

	// Tests that validation covers the case fields and the persona graph together.
	it("has errors until the case fields and the persona graph are valid", () => {
		const draft = new CaseDraft();
		expect(draft.hasErrors).toBe(true);

		draft.load(loadable(), { isEditMode: true });
		expect(draft.hasErrors).toBe(false);

		draft.accessCode = "Not Valid 1";
		expect(draft.errors.accessCode).toBeTruthy();
		expect(draft.hasErrors).toBe(true);
	});

	// Tests that the submit and export inputs carry the same field values.
	it("builds the submit and export inputs from the same fields", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: true });

		const submit = draft.submitInput("case-1");
		const exported = draft.exportInput();

		expect(submit).toMatchObject({
			editCaseId: "case-1",
			caseName: "Sterling",
			initialBrief: "Cut costs.",
			commonInformation: "Background.",
			simulationDurationMinutes: 30,
			accessCode: "sterling",
			roots: ["a"],
			collaboratorAdminIds: ["admin-2"],
		});
		expect(exported).toMatchObject({
			caseName: submit.caseName,
			accessCode: submit.accessCode,
			simulationDurationMinutes: submit.simulationDurationMinutes,
		});
	});
});
