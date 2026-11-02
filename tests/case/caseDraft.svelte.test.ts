import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import type { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { ACCESS_CODE_CONFLICT, casePath } from "#shared/rules.js";
import {
	CaseDraft,
	type LoadableCase,
} from "../../src/lib/case/caseDraft.svelte.js";
import { makePersonaPayload } from "../support/factories.js";

type EditableCase = FunctionReturnType<typeof api.cases.getForEdit>;

// Builds a case as the server returns it for editing, with one root persona.
function loadable(overrides: Partial<EditableCase> = {}): LoadableCase {
	return {
		_id: "case-1" as Id<"cases">,
		_creationTime: 0,
		ownerAdminId: "admin-1" as Id<"admins">,
		isTemplate: false,
		canEdit: true,
		teachingNotesUrl: null,
		name: "Sterling",
		brief: "Cut costs.",
		commonInformation: "Background.",
		duration: 30,
		accessCode: "sterling",
		structure: {
			personas: [makePersonaPayload({ id: "a", name: "Mary", role: "CFO" })],
			referrals: [],
		},
		collaborators: [ADMIN_2],
		...overrides,
	};
}

const ADMIN_2 = {
	adminId: "admin-2" as Id<"admins">,
	access: "edit" as const,
};

describe("CaseDraft", () => {
	// Tests that a new draft is clean until the first change, and clean again after markSaved.
	it("is clean at first, dirty after an edit, and clean again once marked saved", () => {
		const draft = new CaseDraft();
		draft.markSaved();
		expect(draft.isDirty).toBe(false);

		draft.name = "Changed";
		expect(draft.isDirty).toBe(true);

		draft.markSaved();
		expect(draft.isDirty).toBe(false);
	});

	// Tests that a draft that was never marked saved (a case still loading) is never dirty.
	it("is not dirty before it has a baseline", () => {
		const draft = new CaseDraft();
		draft.name = "Typed while loading";
		expect(draft.isDirty).toBe(false);
	});

	// Tests that every kind of edit counts: fields, collaborators and the persona graph.
	it.each([
		["a case field", (d: CaseDraft) => (d.brief = "New brief")],
		["the duration", (d: CaseDraft) => (d.duration = 45)],
		[
			"a collaborator",
			(d: CaseDraft) =>
				d.collaborators.push({
					adminId: "admin-3" as Id<"admins">,
					access: "edit",
				}),
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

		expect(draft.name).toBe("Sterling");
		expect(draft.accessCode).toBe("sterling");
		expect(draft.duration).toBe(30);
		expect(draft.collaborators).toEqual([ADMIN_2]);
		expect(draft.graph.personas).toHaveLength(1);
		expect(draft.showErrors).toBe(true);
		expect(draft.isDirty).toBe(false);
	});

	// Tests that a persona saved without a photo or availability limit loads as null, the form's empty value, so editing it back to empty is not a change.
	it("loads missing photo and availability as null and stays clean when an edit is reverted", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: true });

		const persona = draft.graph.personas[0]!;
		expect(persona.profilePhoto).toBeNull();
		expect(persona.availabilityMinutes).toBeNull();

		persona.availabilityMinutes = 30;
		expect(draft.isDirty).toBe(true);
		persona.availabilityMinutes = null;
		expect(draft.isDirty).toBe(false);
	});

	// Tests that a view-only case locks the draft, and that a template or an editable case leaves it editable.
	it("reads canEdit from the loaded case, and stays editable otherwise", () => {
		const viewOnly = new CaseDraft();
		viewOnly.load(loadable({ canEdit: false }), { isEditMode: true });
		expect(viewOnly.canEdit).toBe(false);

		const editable = new CaseDraft();
		editable.load(loadable(), { isEditMode: true });
		expect(editable.canEdit).toBe(true);

		const template = new CaseDraft();
		template.load(loadable({ canEdit: false }), { isEditMode: false });
		expect(template.canEdit).toBe(true);
	});

	// Tests that loading a template copies the content but not the access code or collaborators.
	it("loads a template without its access code or collaborators", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: false });

		expect(draft.name).toBe("Sterling");
		expect(draft.accessCode).toBe("");
		expect(draft.collaborators).toEqual([]);
	});

	// Tests that an imported file replaces the content but leaves the draft dirty, so it still has to be saved.
	it("applies an import and stays dirty", () => {
		const draft = new CaseDraft();
		draft.markSaved();

		draft.applyImport({
			name: "Imported",
			accessCode: "imported",
			duration: null,
			brief: "Brief",
			commonInformation: "",
			personas: [],
			referrals: [],
		});

		expect(draft.name).toBe("Imported");
		expect(draft.showErrors).toBe(true);
		expect(draft.isDirty).toBe(true);
	});

	// Tests that hasContent reports whether anything worth confirming before a replace is in the draft.
	it("reports content only once something meaningful is entered", () => {
		const draft = new CaseDraft();
		expect(draft.hasContent).toBe(false);

		draft.name = "   ";
		expect(draft.hasContent).toBe(false);

		draft.accessCode = "code";
		expect(draft.hasContent).toBe(true);
	});

	// Tests that validation covers the case fields and the persona graph together.
	it("has issues until the case fields and the persona graph are valid", () => {
		const draft = new CaseDraft();
		expect(draft.issues.length).toBeGreaterThan(0);

		draft.load(loadable(), { isEditMode: true });
		expect(draft.issues).toEqual([]);

		draft.accessCode = "Not Valid 1";
		expect(draft.errorFor(casePath("accessCode"))).toBeTruthy();
		expect(draft.issues).toHaveLength(1);
	});

	// Tests that a field's error only shows once it has been edited or errors have been revealed.
	it("holds a field's error back until it is touched or revealed", () => {
		const draft = new CaseDraft();
		expect(draft.errorFor(casePath("name"))).toBeUndefined();

		draft.touch(casePath("name"));
		expect(draft.errorFor(casePath("name"))).toBe("Case name is required.");
		expect(draft.errorFor(casePath("accessCode"))).toBeUndefined();

		draft.revealErrors();
		expect(draft.errorFor(casePath("accessCode"))).toBe(
			"Access code is required.",
		);
	});

	// Tests that a code the server refused stays an issue until it is changed.
	it("keeps a taken access code as an issue until the code changes", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: true });

		draft.takenAccessCode = draft.accessCode.trim();
		expect(draft.issues.map((issue) => issue.message)).toEqual([
			ACCESS_CODE_CONFLICT,
		]);

		draft.accessCode = "different";
		expect(draft.issues).toEqual([]);
	});

	// Tests that only someone who can fix a case sees its problems as soon as it opens.
	it("reveals errors on load only for an editable case", () => {
		const editable = new CaseDraft();
		editable.load(loadable(), { isEditMode: true });
		expect(editable.showErrors).toBe(true);

		const viewOnly = new CaseDraft();
		viewOnly.load(loadable({ canEdit: false }), { isEditMode: true });
		expect(viewOnly.showErrors).toBe(false);

		const templateCopy = new CaseDraft();
		templateCopy.load(loadable(), { isEditMode: false });
		expect(templateCopy.showErrors).toBe(false);
	});

	// Tests that the submit and export inputs carry the same field values.
	it("builds the submit and export inputs from the same fields", () => {
		const draft = new CaseDraft();
		draft.load(loadable(), { isEditMode: true });

		const submit = draft.submitInput("case-1");
		const exported = draft.exportInput();

		expect(submit).toMatchObject({
			editCaseId: "case-1",
			name: "Sterling",
			brief: "Cut costs.",
			commonInformation: "Background.",
			duration: 30,
			accessCode: "sterling",
			collaborators: [ADMIN_2],
		});
		expect(exported).toMatchObject({
			name: submit.name,
			accessCode: submit.accessCode,
			duration: submit.duration,
		});
	});
});
