import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Id } from "#convex/dataModel.js";
import { appError, ERROR_CODE } from "#shared/errors.js";
import { ACCESS_CODE_CONFLICT } from "#shared/rules.js";
import type { PersonaPayload } from "../../../../src/lib/types.js";
import {
	createCase,
	field,
	fillValidCase,
	getForEdit,
	makeCaseDoc,
	makePersonaPayload,
	openTab,
	renderForm,
	saveButton,
	setRoster,
	stubLoadCase,
	stubMutations,
	updateCase,
	waitForLoadedCase,
} from "./support.js";

vi.mock(
	"#lib/adminViewer.js",
	async () => (await import("./viewerMock.js")).adminViewerModule,
);

describe("CaseForm", () => {
	beforeEach(() => {
		setRoster([]);
	});

	afterEach(() => {
		if (vi.isFakeTimers()) vi.useRealTimers();
	});

	describe("create mode — validation", () => {
		// Tests that submitting an empty create form shows required-field errors and sends no request.
		it("renders empty and surfaces required-field errors instead of sending a request", async () => {
			await renderForm();

			await expect.element(field("Case name")).toHaveValue("");
			await expect
				.element(page.getByText("Case name is required."))
				.not.toBeInTheDocument();

			document.querySelector("form")?.requestSubmit();

			const list = page.getByRole("list", { name: "Things to fix" });
			await expect.element(list).toBeVisible();
			expect(
				list
					.getByRole("button")
					.elements()
					.map((item) => item.textContent?.trim()),
			).toEqual([
				"Case name is required.",
				"Student brief is required.",
				"Access code is required.",
				"Add at least one persona.",
			]);
			await expect
				.element(field("Case name"))
				.toHaveAccessibleDescription("Case name is required.");
			await expect.element(page.getByText("4 things to fix")).toBeVisible();
			expect(createCase).not.toHaveBeenCalled();
			expect(updateCase).not.toHaveBeenCalled();
		});

		// Tests that editing and clearing one field only reveals that field's error, and marks it invalid for assistive tech.
		it("only shows the error of the field being edited, until the form is submitted", async () => {
			await renderForm();

			await field("Case name").fill("a");
			await field("Case name").clear();

			await expect
				.element(page.getByText("Case name is required."))
				.toBeVisible();
			await expect
				.element(field("Case name"))
				.toHaveAttribute("aria-invalid", "true");
			await expect
				.element(page.getByText("Student brief is required."))
				.not.toBeInTheDocument();
			await expect
				.element(field("Student brief"))
				.not.toHaveAttribute("aria-invalid");
		});
	});

	describe("create mode — valid submit", () => {
		// Tests that a valid create form sends the expected payload and reports success.
		it("sends the expected payload and reports success", async () => {
			const { createRequests } = stubMutations();
			await renderForm();

			await fillValidCase();

			await saveButton().click();

			await vi.waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});
			expect(createRequests).toHaveLength(1);
			expect(createRequests[0]?.name).toBe("Sterling Industries");
			expect(
				(
					createRequests[0]?.structure as
						| { personas: PersonaPayload[] }
						| undefined
				)?.personas[0]?.name,
			).toBe("Mary");
		});
	});

	describe("edit mode", () => {
		// Tests that edit mode loads the case into the form and saves it through updateCase.
		it("loads the case into the form and saves it via the Convex updateCase mutation", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			const { updateRequests } = stubMutations();
			await renderForm({ editCaseId: doc._id });

			await waitForLoadedCase();
			await openTab("Case Information");
			await expect
				.element(field("Case name"))
				.toHaveValue("Sterling Industries");
			await expect.element(field("Student brief")).toHaveValue("Reduce costs.");
			await expect.element(field("Access code")).toHaveValue("sterling");

			await saveButton().click();

			await vi.waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case updated successfully.",
				);
			});
			expect(updateRequests).toHaveLength(1);
			expect(updateRequests[0]?.caseId).toBe(doc._id);
		});

		// Tests that a save the server refuses for another reason is reported as a toast.
		it("reports a failed save as a toast", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			updateCase.mockRejectedValue(
				appError(ERROR_CODE.INVALID_CASE, "Something went wrong."),
			);
			await renderForm({ editCaseId: doc._id });
			await waitForLoadedCase();

			await expect.element(saveButton()).toBeEnabled();
			await saveButton().click();

			await vi.waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Something went wrong.",
				);
			});
		});

		// Tests that a taken access code shows on its field and clears as soon as the code changes.
		it("shows a taken access code on the field until it changes", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			updateCase.mockRejectedValue(
				appError(ERROR_CODE.ACCESS_CODE_TAKEN, ACCESS_CODE_CONFLICT),
			);
			await renderForm({ editCaseId: doc._id });
			await waitForLoadedCase();
			await expect.element(saveButton()).toBeEnabled();

			await openTab("Case Information");
			await saveButton().click();

			const code = field("Access code");
			await expect
				.element(code)
				.toHaveAccessibleDescription(ACCESS_CODE_CONFLICT);

			await userEvent.type(code, "x");
			await expect.element(code).not.toHaveAttribute("aria-invalid");
			await expect
				.element(page.getByText("1 thing to fix"))
				.not.toBeInTheDocument();
		});

		// Tests that an older case that fails today's rules shows what to fix as soon as it opens.
		it("lists an older case's problems as soon as it opens", async () => {
			const doc = makeCaseDoc({
				structure: {
					personas: [makePersonaPayload({ knownFacts: "" })],
					referrals: [],
				},
			});
			stubLoadCase(doc);
			await renderForm({ editCaseId: doc._id });

			await expect.element(page.getByText("1 thing to fix")).toBeVisible();
			await expect
				.element(field("Persona instructions"))
				.toHaveAccessibleDescription(
					"Add instructions for Mary. Personas can only answer from these, the brief and the background.",
				);
		});

		// Tests that the case is reloaded from the server after a successful update.
		it("reloads the case from the server after a successful update", async () => {
			const doc = makeCaseDoc();
			let queryCalls = 0;
			getForEdit.mockImplementation(async ({ caseId }) => {
				queryCalls += 1;
				if (caseId !== doc._id) throw new Error("Case not found.");
				return queryCalls === 1
					? doc
					: { ...doc, name: "Sterling Industries (saved)" };
			});
			const { updateRequests } = stubMutations();
			await renderForm({ editCaseId: doc._id });
			await waitForLoadedCase();

			await saveButton().click();
			await vi.waitFor(() => expect(updateRequests).toHaveLength(1));
			await openTab("Case Information");

			await expect
				.element(field("Case name"))
				.toHaveValue("Sterling Industries (saved)");
			expect(updateRequests).toHaveLength(1);
			expect(queryCalls).toBe(2);
		});
	});

	describe("teaching notes", () => {
		// Tests that an edited case shows a download link for its notes and sends the file along when saved.
		it("shows the saved notes as a download link and keeps them on save", async () => {
			const notes = {
				storageId: "s1" as Id<"_storage">,
				fileName: "notes.pdf",
			};
			const doc = makeCaseDoc({
				teachingNotes: notes,
				teachingNotesUrl: "https://files.test/notes.pdf",
			});
			stubLoadCase(doc);
			const { updateRequests } = stubMutations();
			await renderForm({ editCaseId: doc._id });

			await waitForLoadedCase();
			await openTab("Case Information");
			await expect
				.element(page.getByRole("link", { name: "notes.pdf" }))
				.toHaveAttribute("href", "https://files.test/notes.pdf");

			await saveButton().click();
			await vi.waitFor(() => expect(updateRequests).toHaveLength(1));
			expect(updateRequests[0]?.teachingNotes).toEqual(notes);
		});

		// Tests that Remove clears the notes so they are not sent on save.
		it("removes the notes when Remove is clicked", async () => {
			const doc = makeCaseDoc({
				teachingNotes: { storageId: "s1" as Id<"_storage">, fileName: "n.pdf" },
				teachingNotesUrl: "https://files.test/n.pdf",
			});
			stubLoadCase(doc);
			const { updateRequests } = stubMutations();
			await renderForm({ editCaseId: doc._id });
			await waitForLoadedCase();
			await openTab("Case Information");
			await expect
				.element(page.getByRole("link", { name: "n.pdf" }))
				.toBeVisible();

			await page.getByRole("button", { name: "Remove teaching notes" }).click();
			await expect
				.element(page.getByRole("link", { name: "n.pdf" }))
				.not.toBeInTheDocument();

			await saveButton().click();
			await vi.waitFor(() => expect(updateRequests).toHaveLength(1));
			expect(updateRequests[0]?.teachingNotes).toBeUndefined();
		});

		// Tests that a newly chosen file is named in the form before saving.
		it("names a newly chosen file", async () => {
			await renderForm();

			await field("Teaching notes").upload(new File(["x"], "fresh.docx"));

			await expect
				.element(page.getByText("Selected: fresh.docx"))
				.toBeVisible();
		});
	});
});
