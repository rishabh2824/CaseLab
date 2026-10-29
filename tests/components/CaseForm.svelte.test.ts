import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import type { FunctionReturnType } from "convex/server";
import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeNavigate, goto } from "$app/navigation";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import CaseForm from "../../src/lib/components/CaseForm.svelte";
import type { AdminRow, PersonaPayload } from "../../src/lib/types.js";
import { convexFake } from "../support/convexFake.svelte.js";
import {
	makePersonaPayload as makeBasePersonaPayload,
	makePersona,
	makeReferral,
} from "../support/factories.js";

const getForEdit = convexFake.clientQuery(api.cases.getForEdit);
const getTemplate = convexFake.clientQuery(api.cases.getTemplate);
const createCase = convexFake.mutation(api.cases.create);
const updateCase = convexFake.mutation(api.cases.update);

// Sets the admin roster the collaborator picker subscribes to.
function setRoster(rows: AdminRow[]) {
	convexFake.setQueryData(
		api.admins.listAll,
		rows.map((row) => ({ ...row, _creationTime: 0 })),
	);
}

let currentViewer: AdminRow | null = null;

vi.mock("#lib/adminViewer.js", () => ({
	getViewerContext: () => ({
		data: currentViewer,
		error: undefined,
		isLoading: false,
		isStale: false,
	}),
}));

// Builds an admin row with defaults and optional overrides.
function makeAdminRow(
	overrides: Partial<Omit<AdminRow, "_id">> & { _id?: string } = {},
): AdminRow {
	return {
		_id: "admin-1",
		email: "admin@wisc.edu",
		name: "Admin One",
		role: "admin",
		...overrides,
	} as AdminRow;
}

// Builds a persona payload named Mary with optional overrides.
function makePersonaPayload(
	overrides: Partial<PersonaPayload> = {},
): PersonaPayload {
	return makeBasePersonaPayload({
		id: "p1",
		name: "Mary",
		role: "CFO",
		...overrides,
	});
}

type ConvexCaseDoc = FunctionReturnType<typeof api.cases.getForEdit>;

// Builds a case document with defaults and optional overrides.
function makeCaseDoc(
	overrides: Partial<Omit<ConvexCaseDoc, "_id" | "ownerAdminId">> & {
		_id?: string;
		ownerAdminId?: string;
	} = {},
): ConvexCaseDoc {
	return {
		_creationTime: 0,
		isTemplate: false,
		name: "Sterling Industries",
		accessCode: "sterling",
		brief: "Reduce costs.",
		commonInformation: "Background.",
		duration: 45,
		structure: {
			personas: [makePersonaPayload()],
			referrals: [],
			roots: ["p1"],
		},
		collaborators: [],
		canEdit: true,
		teachingNotesUrl: null,
		...overrides,
		_id: (overrides._id ?? "case-7") as Id<"cases">,
		ownerAdminId: (overrides.ownerAdminId ?? "1") as Id<"admins">,
	};
}

// Stubs the case query to return the given case for its id and throw for any other.
function stubLoadCase(doc: ConvexCaseDoc) {
	getForEdit.mockImplementation(async ({ caseId }) => {
		if (caseId !== doc._id) throw new Error("Case not found.");
		return doc;
	});
}

// Stubs the create and update mutations and records the requests made.
function stubMutations() {
	const createRequests: Record<string, unknown>[] = [];
	const updateRequests: Record<string, unknown>[] = [];
	createCase.mockImplementation(async (args) => {
		createRequests.push(args);
		return { caseId: "convex-case-1" as Id<"cases"> };
	});
	updateCase.mockImplementation(async (args) => {
		updateRequests.push(args);
		return { caseId: args.caseId };
	});
	return { createRequests, updateRequests };
}

// Renders the case form in create, edit or template mode with an optional viewer.
function renderForm(
	props: {
		editCaseId?: string | null;
		templateId?: string | null;
		viewer?: AdminRow | null;
	} = {},
) {
	const { editCaseId = null, templateId = null, viewer = null } = props;
	currentViewer = viewer;
	return render(CaseForm, {
		props: {
			mode: editCaseId ? "edit" : "create",
			caseId: editCaseId,
			templateId,
		},
	});
}

// Fills the create form with a valid case: case info plus one root persona.
async function fillValidCase(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("Case name"), "Sterling Industries");
	await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
	await user.type(screen.getByLabelText("Access code"), "sterling");
	await user.click(screen.getByRole("button", { name: "+ Add root persona" }));
	await user.type(screen.getByLabelText("Persona name"), "Mary");
	await user.type(screen.getByLabelText("Title/Role"), "CFO");
}

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
			const { container } = renderForm();

			expect(screen.getByLabelText("Case name")).toHaveValue("");
			expect(
				screen.queryByText("Case name is required."),
			).not.toBeInTheDocument();

			const form = container.querySelector("form") as HTMLFormElement;
			await fireEvent.submit(form);

			expect(
				await screen.findByText("Case name is required."),
			).toBeInTheDocument();
			expect(
				screen.getByText("Initial brief is required."),
			).toBeInTheDocument();
			expect(screen.getByText("Access code is required.")).toBeInTheDocument();
			expect(
				screen.getByText("At least 1 persona is required"),
			).toBeInTheDocument();
			expect(createCase).not.toHaveBeenCalled();
			expect(updateCase).not.toHaveBeenCalled();
		});

		// Tests that editing and clearing one field only reveals that field's error, and marks it invalid for assistive tech.
		it("only shows the error of the field being edited, until the form is submitted", async () => {
			const user = userEvent.setup();
			renderForm();

			const name = screen.getByLabelText("Case name");
			await user.type(name, "a");
			await user.clear(name);

			expect(screen.getByText("Case name is required.")).toBeInTheDocument();
			expect(name).toHaveAttribute("aria-invalid", "true");
			expect(
				screen.queryByText("Initial brief is required."),
			).not.toBeInTheDocument();
			expect(screen.getByLabelText("Initial brief")).not.toHaveAttribute(
				"aria-invalid",
			);
		});
	});

	describe("create mode — valid submit", () => {
		// Tests that a valid create form sends the expected payload and reports success.
		it("sends the expected payload and reports success", async () => {
			const { createRequests } = stubMutations();
			const user = userEvent.setup();
			renderForm();

			await fillValidCase(user);

			await user.click(screen.getByRole("button", { name: "Submit" }));

			await waitFor(() => {
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
			const user = userEvent.setup();
			renderForm({ editCaseId: doc._id });

			expect(
				await screen.findByDisplayValue("Sterling Industries"),
			).toBeInTheDocument();
			expect(screen.getByDisplayValue("Reduce costs.")).toBeInTheDocument();
			expect(screen.getByDisplayValue("sterling")).toBeInTheDocument();
			expect(screen.getByDisplayValue("Mary")).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(
				await screen.findByText("Case updated successfully."),
			).toBeInTheDocument();
			expect(updateRequests).toHaveLength(1);
			expect(updateRequests[0]?.caseId).toBe(doc._id);
		});

		// Tests that a failed save in edit mode shows an inline error.
		it("surfaces a save failure inline", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			updateCase.mockRejectedValue(new Error("Access code already in use."));
			const user = userEvent.setup();
			renderForm({ editCaseId: doc._id });
			await screen.findByDisplayValue("Sterling Industries");

			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled(),
			);
			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(
				await screen.findByText("Access code already in use."),
			).toBeInTheDocument();
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
			const user = userEvent.setup();
			renderForm({ editCaseId: doc._id });
			await screen.findByDisplayValue("Sterling Industries");

			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(
				await screen.findByDisplayValue("Sterling Industries (saved)"),
			).toBeInTheDocument();
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
			const user = userEvent.setup();
			renderForm({ editCaseId: doc._id });

			const link = await screen.findByRole("link", { name: "notes.pdf" });
			expect(link).toHaveAttribute("href", "https://files.test/notes.pdf");

			await user.click(screen.getByRole("button", { name: "Submit" }));
			await waitFor(() => expect(updateRequests).toHaveLength(1));
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
			const user = userEvent.setup();
			renderForm({ editCaseId: doc._id });
			await screen.findByRole("link", { name: "n.pdf" });

			await user.click(
				screen.getByRole("button", { name: "Remove teaching notes" }),
			);
			expect(screen.queryByRole("link", { name: "n.pdf" })).toBeNull();

			await user.click(screen.getByRole("button", { name: "Submit" }));
			await waitFor(() => expect(updateRequests).toHaveLength(1));
			expect(updateRequests[0]?.teachingNotes).toBeUndefined();
		});

		// Tests that a newly chosen file is named in the form before saving.
		it("names a newly chosen file", async () => {
			const user = userEvent.setup();
			renderForm();

			await user.upload(
				screen.getByLabelText("Teaching notes"),
				new File(["x"], "fresh.docx"),
			);

			expect(screen.getByText("Selected: fresh.docx")).toBeInTheDocument();
		});
	});

	describe("view-only case", () => {
		// Tests that a case shared for reading shows a banner, locks the fields and offers no Submit.
		it("locks the form and hides Submit for a view-only collaborator", async () => {
			const doc = makeCaseDoc({ canEdit: false });
			stubLoadCase(doc);
			renderForm({ editCaseId: doc._id });

			expect(
				await screen.findByDisplayValue("Sterling Industries"),
			).toBeDisabled();
			expect(screen.getByText(/View only:/)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
		});

		// Tests that an editable case shows none of that.
		it("shows no banner and keeps Submit for an editor", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			renderForm({ editCaseId: doc._id });

			expect(
				await screen.findByDisplayValue("Sterling Industries"),
			).toBeEnabled();
			expect(screen.queryByText(/View only:/)).toBeNull();
			expect(
				screen.getByRole("button", { name: "Submit" }),
			).toBeInTheDocument();
		});
	});

	describe("template mode", () => {
		// Tests that a template loads through getTemplate and seeds a new case with no access code.
		it("seeds the form from the template without an access code", async () => {
			const {
				accessCode: _accessCode,
				ownerAdminId: _owner,
				...template
			} = makeCaseDoc();
			getTemplate.mockResolvedValue(template);
			const { createRequests } = stubMutations();
			const user = userEvent.setup();
			renderForm({ templateId: template._id });

			expect(
				await screen.findByDisplayValue("Sterling Industries"),
			).toBeInTheDocument();
			expect(screen.getByDisplayValue("Mary")).toBeInTheDocument();
			expect(screen.getByLabelText("Access code")).toHaveValue("");
			expect(getTemplate).toHaveBeenCalledWith({ caseId: template._id });

			await user.type(screen.getByLabelText("Access code"), "fresh");
			await user.click(screen.getByRole("button", { name: "Submit" }));
			await waitFor(() => expect(createRequests).toHaveLength(1));
			expect(createRequests[0]?.accessCode).toBe("fresh");
		});
	});

	describe("concurrent saves", () => {
		// Tests that a second submit during an in-flight save reuses it instead of calling the mutation again.
		it("reuses the in-flight save instead of issuing a second mutation call", async () => {
			let resolveMutation:
				| ((value: { caseId: Id<"cases"> }) => void)
				| undefined;
			createCase.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveMutation = resolve;
					}),
			);
			const user = userEvent.setup();
			renderForm();

			await fillValidCase(user);

			await user.click(screen.getByRole("button", { name: "Submit" }));
			const guard = vi.mocked(beforeNavigate).mock.calls.at(-1)?.[0];
			if (!guard) throw new Error("expected a beforeNavigate callback");
			guard({
				to: { url: new URL("http://localhost/admin") },
				cancel: vi.fn(),
			} as never);
			await user.click(
				await screen.findByRole("button", { name: "Save changes" }),
			);

			resolveMutation?.({ caseId: "convex-case-1" as Id<"cases"> });
			await waitFor(() =>
				expect(goto).toHaveBeenCalledWith(new URL("http://localhost/admin")),
			);

			expect(createCase).toHaveBeenCalledTimes(1);
			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});
		});

		// Tests that every field, not just Submit, is disabled while a save is in flight.
		it("disables every field, not just Submit, while a save is in flight", async () => {
			let resolveMutation:
				| ((value: { caseId: Id<"cases"> }) => void)
				| undefined;
			createCase.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveMutation = resolve;
					}),
			);
			const user = userEvent.setup();
			renderForm();

			await fillValidCase(user);

			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(screen.getByLabelText("Case name")).toBeDisabled();
			expect(screen.getByLabelText("Persona name")).toBeDisabled();
			expect(
				screen.getByRole("button", { name: "Export template" }),
			).toBeDisabled();

			resolveMutation?.({ caseId: "convex-case-1" as Id<"cases"> });
			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});

			expect(screen.getByLabelText("Case name")).not.toBeDisabled();
		});
	});

	describe("unsaved-changes navigation guard", () => {
		const target = new URL("http://localhost/admin");

		// Returns the form's beforeNavigate callback, and a helper that fires it and reports whether it cancelled.
		function navigationGuard(): () => boolean {
			const callback = vi.mocked(beforeNavigate).mock.calls.at(-1)?.[0];
			if (!callback) throw new Error("expected a beforeNavigate callback");
			return () => {
				const cancel = vi.fn();
				callback({ to: { url: target }, cancel } as never);
				return cancel.mock.calls.length > 0;
			};
		}

		// Tests that a clean form lets navigation through and a dirty one holds it behind the dialog.
		it("lets a clean navigation through and holds a dirty one behind the dialog", async () => {
			const user = userEvent.setup();
			renderForm();
			const navigate = navigationGuard();

			expect(navigate()).toBe(false);

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			expect(navigate()).toBe(true);
			expect(
				await screen.findByText("You have unsaved changes"),
			).toBeInTheDocument();
			expect(goto).not.toHaveBeenCalled();
		});

		// Tests that cancelling the dialog stays on the page and keeps the guard active.
		it("stays put when the dialog is cancelled", async () => {
			const user = userEvent.setup();
			renderForm();
			const navigate = navigationGuard();
			await user.type(screen.getByLabelText("Case name"), "Sterling");
			navigate();

			await user.click(await screen.findByRole("button", { name: "Cancel" }));

			await waitFor(() =>
				expect(
					screen.queryByText("You have unsaved changes"),
				).not.toBeInTheDocument(),
			);
			expect(goto).not.toHaveBeenCalled();
			expect(navigate()).toBe(true);
		});

		// Tests that discarding continues the held navigation and stops re-blocking.
		it("continues the navigation after Discard changes, without re-blocking it", async () => {
			const user = userEvent.setup();
			renderForm();
			const navigate = navigationGuard();
			await user.type(screen.getByLabelText("Case name"), "Sterling");
			navigate();

			await user.click(
				await screen.findByRole("button", { name: "Discard changes" }),
			);

			expect(goto).toHaveBeenCalledWith(target);
			expect(navigate()).toBe(false);
		});

		// Tests that a failed save keeps the user on the page with the error shown.
		it("shows the error and stays when the save fails", async () => {
			const user = userEvent.setup();
			renderForm();
			const navigate = navigationGuard();
			await user.type(screen.getByLabelText("Case name"), "Sterling");
			navigate();

			await user.click(
				await screen.findByRole("button", { name: "Save changes" }),
			);

			const dialog = await screen.findByRole("alertdialog");
			expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
			expect(goto).not.toHaveBeenCalled();
		});
	});

	describe("persona add/remove", () => {
		// Tests that adding a root persona appends a new persona card.
		it("adding a root persona appends a card", async () => {
			const user = userEvent.setup();
			renderForm();

			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(0);
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(1);
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(2);
		});

		// Tests that removing a root also removes referrals into it and any persona left unreachable.
		it("removing a root also removes referral edges into it, dropping a persona that becomes unreachable", async () => {
			const user = userEvent.setup();
			renderForm();

			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(1);

			await user.click(screen.getByRole("button", { name: "+ Add referral" }));
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(2);

			const [rootRemoveButton] = screen.getAllByRole("button", {
				name: "Remove",
			});
			if (!rootRemoveButton) throw new Error("expected a Remove button");
			await user.click(rootRemoveButton);

			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(0);
		});
	});

	describe("import", () => {
		// Tests that import is offered in create mode.
		it("is offered in create mode (no source case)", () => {
			renderForm();
			expect(
				screen.getByRole("button", { name: "Import template" }),
			).toBeInTheDocument();
		});

		// Tests that import is not offered in edit mode.
		it("is not offered in edit mode", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			renderForm({ editCaseId: doc._id });
			await screen.findByDisplayValue("Sterling Industries");
			expect(
				screen.queryByRole("button", { name: "Import template" }),
			).not.toBeInTheDocument();
		});

		// Tests that importing a hand-edited export is rejected without touching the form.
		it("rejects a hand-edited export file and leaves the form untouched", async () => {
			const root = makePersona({
				id: "root1",
				name: "Original Root",
				role: "Lead",
				availabilityMinutes: 45,
			});
			const referred = makePersona({
				id: "ref1",
				name: "Original Referred",
				role: "Assistant",
			});
			const html = buildHTMLForm({
				caseName: "Original Case",
				accessCode: "CODE1",
				simulationDurationMinutes: 30,
				initialBrief: "Original brief",
				commonInformation: "Original background",
				personas: [root, referred],
				referrals: [makeReferral("root1", "ref1", "always")],
				roots: ["root1"],
			});
			const tweaked = html
				.replaceAll("Original Case", "Tweaked Case")
				.replace(">45</textarea>", ">not-a-number</textarea>");
			const file = new File([tweaked], "export.html", { type: "text/html" });
			const user = userEvent.setup();
			const { container } = renderForm();

			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await user.upload(fileInput, file);

			expect(
				await screen.findByText(/Simulation duration/),
			).toBeInTheDocument();
			expect(
				screen.queryByDisplayValue("Tweaked Case"),
			).not.toBeInTheDocument();
		});

		// Tests that importing over existing content asks for confirmation and only imports once confirmed.
		it("confirms before replacing existing form content, and only imports after confirming", async () => {
			const html = buildHTMLForm({
				caseName: "Imported Case",
				accessCode: "CODE1",
				simulationDurationMinutes: 30,
				initialBrief: "Imported brief",
				commonInformation: "Imported background",
				personas: [],
				referrals: [],
				roots: [],
			});
			const file = new File([html], "export.html", { type: "text/html" });
			const user = userEvent.setup();
			const { container } = renderForm();

			await user.type(screen.getByLabelText("Case name"), "Existing Case");

			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await user.upload(fileInput, file);

			expect(
				await screen.findByText("Replace everything in this form?"),
			).toBeInTheDocument();
			expect(screen.getByLabelText("Case name")).toHaveValue("Existing Case");

			await user.click(screen.getByRole("button", { name: "Import" }));

			expect(
				await screen.findByDisplayValue("Imported Case"),
			).toBeInTheDocument();
			await waitFor(() =>
				expect(
					screen.queryByText("Replace everything in this form?"),
				).not.toBeInTheDocument(),
			);
		});

		// Tests that cancelling the replace confirmation leaves the existing form content untouched.
		it("cancelling the replace-confirm leaves the existing form content untouched", async () => {
			const html = buildHTMLForm({
				caseName: "Imported Case",
				accessCode: "CODE1",
				simulationDurationMinutes: 30,
				initialBrief: "Imported brief",
				commonInformation: "Imported background",
				personas: [],
				referrals: [],
				roots: [],
			});
			const file = new File([html], "export.html", { type: "text/html" });
			const user = userEvent.setup();
			const { container } = renderForm();

			await user.type(screen.getByLabelText("Case name"), "Existing Case");

			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await user.upload(fileInput, file);
			await screen.findByText("Replace everything in this form?");

			await user.click(screen.getByRole("button", { name: "Cancel" }));

			await waitFor(() =>
				expect(
					screen.queryByText("Replace everything in this form?"),
				).not.toBeInTheDocument(),
			);
			expect(screen.getByLabelText("Case name")).toHaveValue("Existing Case");
		});

		// Tests that importing an unrelated HTML file shows the import error as a toast.
		it("surfaces the import error as a toast for an unrelated HTML file", async () => {
			const file = new File(
				["<html><body><p>hello</p></body></html>"],
				"random.html",
				{ type: "text/html" },
			);
			const user = userEvent.setup();
			const { container } = renderForm();
			const toast = vi.mocked(sonner.toast);

			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await user.upload(fileInput, file);

			await waitFor(() =>
				expect(toast).toHaveBeenCalledWith(
					"This doesn't look like a Case Lab import file.",
				),
			);
		});
	});

	describe("collaborator picker", () => {
		async function openPicker() {
			const user = userEvent.setup();
			await user.click(
				screen.getByRole("button", { name: /Add collaborators/ }),
			);
			return user;
		}

		// Tests that the collaborator picker lists the admin roster from the live subscription.
		it("shows the admin roster from the live Convex subscription in the picker", async () => {
			setRoster([makeAdminRow({ _id: "9", name: "Nina" })]);
			renderForm();

			await openPicker();

			expect(await screen.findByText("Nina")).toBeInTheDocument();
		});

		// Tests that the case owner is excluded from the picker in edit mode, while super admins stay selectable so they can be credited.
		it("excludes the case's owner but offers super admins in edit mode", async () => {
			const doc = makeCaseDoc({ ownerAdminId: "5" });
			stubLoadCase(doc);
			setRoster([
				makeAdminRow({ _id: "5", name: "Owner Olivia", role: "admin" }),
				makeAdminRow({ _id: "6", name: "Super Sam", role: "super" }),
				makeAdminRow({ _id: "7", name: "Rank Rita", role: "admin" }),
			]);
			renderForm({ editCaseId: doc._id });
			await screen.findByDisplayValue("Sterling Industries");

			await openPicker();

			expect(await screen.findByText("Rank Rita")).toBeInTheDocument();
			expect(screen.queryByText("Owner Olivia")).not.toBeInTheDocument();
			expect(screen.getByText("Super Sam")).toBeInTheDocument();
		});

		// Tests that the signed-in admin is excluded from the picker as the effective owner in create mode.
		it("excludes the signed-in admin (admins:viewer) as the effective owner in create mode", async () => {
			setRoster([
				makeAdminRow({ _id: "1", name: "Me", email: "me@wisc.edu" }),
				makeAdminRow({
					_id: "2",
					name: "Rank Rita",
					email: "rita@wisc.edu",
				}),
			]);
			renderForm({
				viewer: makeAdminRow({ _id: "1", name: "Me", email: "me@wisc.edu" }),
			});

			await openPicker();

			expect(await screen.findByText("Rank Rita")).toBeInTheDocument();
			expect(screen.queryByText("Me")).not.toBeInTheDocument();
		});

		// Tests that toggling a collaborator updates the selected-count badge and the submit payload.
		it("toggling a collaborator updates the selected-count badge and is included in the submit payload", async () => {
			const { createRequests } = stubMutations();
			setRoster([makeAdminRow({ _id: "9", name: "Nina" })]);
			const user = userEvent.setup();
			renderForm();

			await fillValidCase(user);

			await openPicker();
			const checkbox = await screen.findByLabelText("Nina");
			await user.click(checkbox);

			expect(screen.getByText("1 selected")).toBeInTheDocument();
			expect(checkbox).toBeChecked();
			await user.selectOptions(
				screen.getByLabelText("Access for Nina"),
				"view",
			);

			await user.click(screen.getByRole("button", { name: "Submit" }));
			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});

			expect(createRequests[0]?.collaborators).toEqual([
				{ adminId: "9", access: "view" },
			]);

			await user.click(checkbox);
			expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
		});
	});
});
