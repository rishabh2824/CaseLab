import type { FunctionReturnType } from "convex/server";
import { getFunctionName } from "convex/server";
import { toast } from "svelte-sonner";
import { describe, expect, it } from "vitest";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { ERROR_CODE } from "#shared/errors.js";
import { CaseFormStore } from "../../src/lib/case/caseFormStore.svelte.js";
import {
	clientAppError,
	clientServerError,
} from "../support/convexClientErrors.js";
import { convexFake } from "../support/convexFake.svelte.js";
import { makePersonaPayload } from "../support/factories.js";

const getForEdit = convexFake.clientQuery(api.cases.getForEdit);
const getTemplate = convexFake.clientQuery(api.cases.getTemplate);
const updateCase = convexFake.mutation(api.cases.update);
const createCase = convexFake.mutation(api.cases.create);

const CASE_ID = "case-1" as Id<"cases">;

// Builds a valid case as the server returns it for editing.
function savedCase(): FunctionReturnType<typeof api.cases.getForEdit> {
	return {
		_id: CASE_ID,
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
		collaborators: [],
	};
}

describe("a case that fails to load", () => {
	// Tests that a failed edit load is reported, and the form stops showing it as loading.
	it("reports a failed edit load", async () => {
		getForEdit.mockRejectedValue(
			clientServerError(getFunctionName(api.cases.getForEdit), "Q"),
		);
		const form = new CaseFormStore(true);
		expect(form.isLoading).toBe(true);

		await form.load(CASE_ID, true);

		expect(form.loadError).toBe("Failed to load case for editing.");
		expect(form.isLoading).toBe(false);
		expect(form.ownerAdminId).toBeNull();
	});

	// Tests that a failed template load is reported with its own message.
	it("reports a failed template load", async () => {
		getTemplate.mockRejectedValue(
			clientServerError(getFunctionName(api.cases.getTemplate), "Q"),
		);
		const form = new CaseFormStore(true);

		await form.load(CASE_ID, false);

		expect(form.loadError).toBe("Failed to load case template.");
		expect(form.isLoading).toBe(false);
	});

	// Tests that the server's own message, such as a missing case, is shown instead of the generic one.
	it("shows the server's message when it gives one", async () => {
		getForEdit.mockRejectedValue(
			clientAppError(
				getFunctionName(api.cases.getForEdit),
				ERROR_CODE.CASE_NOT_FOUND,
				"Case not found.",
				"Q",
			),
		);
		const form = new CaseFormStore(true);

		await form.load(CASE_ID, true);

		expect(form.loadError).toBe("Case not found.");
	});

	// Tests that saving straight after a failed load cannot overwrite the stored case with the blank form.
	it("refuses to save the blank form over the case", async () => {
		getForEdit.mockRejectedValue(new Error("offline"));
		const form = new CaseFormStore(true);
		await form.load(CASE_ID, true);

		const result = await form.save(CASE_ID);

		expect(result.ok).toBe(false);
		expect(updateCase).not.toHaveBeenCalled();
		expect(createCase).not.toHaveBeenCalled();
	});

	// Tests that a retried load clears the earlier error.
	it("clears the error when a later load works", async () => {
		getForEdit.mockRejectedValueOnce(new Error("offline"));
		getForEdit.mockResolvedValueOnce(savedCase());
		const form = new CaseFormStore(true);
		await form.load(CASE_ID, true);
		expect(form.loadError).not.toBe("");

		await form.load(CASE_ID, true);

		expect(form.loadError).toBe("");
		expect(form.draft.name).toBe("Sterling");
		expect(form.ownerAdminId).toBe("admin-1");
	});
});

describe("reloading after a save", () => {
	// Tests that a save that worked still counts as saved when reloading the case afterwards fails.
	it("keeps the save and marks the form clean when the reload fails", async () => {
		getForEdit.mockResolvedValueOnce(savedCase());
		updateCase.mockResolvedValue({ caseId: CASE_ID });
		const form = new CaseFormStore(true);
		await form.load(CASE_ID, true);
		form.draft.name = "Sterling (renamed)";
		expect(form.draft.isDirty).toBe(true);
		getForEdit.mockRejectedValueOnce(new Error("offline"));

		const result = await form.save(CASE_ID);

		expect(result).toEqual({ ok: true, caseId: CASE_ID });
		expect(updateCase).toHaveBeenCalledOnce();
		expect(updateCase.mock.calls[0]![0]).toMatchObject({
			caseId: CASE_ID,
			name: "Sterling (renamed)",
		});
		expect(toast).toHaveBeenCalledWith("Case updated successfully.");
		expect(form.draft.isDirty).toBe(false);
		expect(form.draft.name).toBe("Sterling (renamed)");
		expect(form.loadError).toBe("");
		expect(form.isSubmitting).toBe(false);
	});
});
