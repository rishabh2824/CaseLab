import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeNavigate } from "$app/navigation";
import { VIEWER_CONTEXT_KEY } from "../../src/lib/adminViewer.js";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import CaseForm from "../../src/lib/components/CaseForm.svelte";
import type {
	AdminRow,
	PersonaPayload,
	ReferralEdge,
} from "../../src/lib/types.js";
import { unsavedGuard } from "../../src/lib/unsavedGuard.svelte.js";
import {
	makePersonaPayload as makeBasePersonaPayload,
	makePersona,
	makeReferral,
} from "../support/fixtures.js";

const mockUseQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientMutation = vi.fn();
const mockClientAction = vi.fn();

vi.mock("convex-svelte", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
	getConvexClient: () => ({
		query: mockClientQuery,
		mutation: mockClientMutation,
		action: mockClientAction,
	}),
}));

// Builds the Svelte context map that provides the signed-in admin viewer.
function viewerContext(
	data: AdminRow | null = null,
): Map<typeof VIEWER_CONTEXT_KEY, unknown> {
	return new Map([
		[
			VIEWER_CONTEXT_KEY,
			{ data, error: undefined, isLoading: false, isStale: false },
		],
	]);
}

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

type ConvexCaseDoc = {
	_id: string;
	name: string;
	brief: string;
	commonInformation?: string;
	duration?: number;
	accessCode?: string;
	ownerAdminId: string;
	structure: {
		personas: PersonaPayload[];
		referrals: ReferralEdge[];
		roots: string[];
	};
	collaboratorAdminIds?: string[];
};

// Builds a case document with defaults and optional overrides.
function makeCaseDoc(overrides: Partial<ConvexCaseDoc> = {}): ConvexCaseDoc {
	return {
		_id: "case-7",
		name: "Sterling Industries",
		accessCode: "sterling",
		brief: "Reduce costs.",
		commonInformation: "Background.",
		duration: 45,
		ownerAdminId: "1",
		structure: {
			personas: [makePersonaPayload()],
			referrals: [],
			roots: ["p1"],
		},
		collaboratorAdminIds: [],
		...overrides,
	};
}

// Stubs the case query to return the given case for its id and throw for any other.
function stubLoadCase(doc: ConvexCaseDoc) {
	mockClientQuery.mockImplementation(
		async (_ref: unknown, args: { caseId: string }) => {
			if (args.caseId !== doc._id) throw new Error("Case not found.");
			return doc;
		},
	);
}

// Stubs the create and update mutations and records the requests made.
function stubMutations() {
	const createRequests: Record<string, unknown>[] = [];
	const updateRequests: Record<string, unknown>[] = [];
	mockClientMutation.mockImplementation(
		async (_ref: unknown, args: Record<string, unknown>) => {
			if ("caseId" in args) {
				updateRequests.push(args);
				return { caseId: args.caseId };
			}
			createRequests.push(args);
			return { caseId: "convex-case-1" };
		},
	);
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
	return render(CaseForm, {
		props: {
			mode: editCaseId ? "edit" : "create",
			caseId: editCaseId,
			templateId,
		},
		context: viewerContext(viewer),
	});
}

describe("CaseForm", () => {
	beforeEach(() => {
		mockUseQuery.mockReset();
		mockClientQuery.mockReset();
		mockClientMutation.mockReset();
		mockClientAction.mockReset();
		mockUseQuery.mockReturnValue({
			data: [],
			isLoading: false,
			error: undefined,
		});
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
			expect(mockClientMutation).not.toHaveBeenCalled();
		});
	});

	describe("create mode — valid submit", () => {
		// Tests that a valid create form sends the expected payload and reports success.
		it("sends the expected payload and reports success", async () => {
			const { createRequests } = stubMutations();
			const user = userEvent.setup();
			renderForm();

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "sterling");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");

			await user.click(screen.getByRole("button", { name: "Submit" }));

			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});
			expect(createRequests).toHaveLength(1);
			expect(createRequests[0]?.name).toBe("Sterling Industries");
			expect(
				(createRequests[0]?.personas as PersonaPayload[] | undefined)?.[0]
					?.name,
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
			mockClientMutation.mockRejectedValue(
				new Error("Access code already in use."),
			);
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
			mockClientQuery.mockImplementation(
				async (_ref: unknown, args: { caseId: string }) => {
					queryCalls += 1;
					if (args.caseId !== doc._id) throw new Error("Case not found.");
					return queryCalls === 1
						? doc
						: { ...doc, name: "Sterling Industries (saved)" };
				},
			);
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

	describe("concurrent saves", () => {
		// Tests that a second submit during an in-flight save reuses it instead of calling the mutation again.
		it("reuses the in-flight save instead of issuing a second mutation call", async () => {
			let resolveMutation: ((value: unknown) => void) | undefined;
			mockClientMutation.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveMutation = resolve;
					}),
			);
			const user = userEvent.setup();
			renderForm();

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "sterling");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");

			await user.click(screen.getByRole("button", { name: "Submit" }));
			const secondSave = unsavedGuard.save();

			resolveMutation?.({ caseId: "convex-case-1" });
			const secondResult = await secondSave;

			expect(mockClientMutation).toHaveBeenCalledTimes(1);
			expect(secondResult).toEqual({ ok: true });
			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});
		});

		// Tests that every field, not just Submit, is disabled while a save is in flight.
		it("disables every field, not just Submit, while a save is in flight", async () => {
			let resolveMutation: ((value: unknown) => void) | undefined;
			mockClientMutation.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveMutation = resolve;
					}),
			);
			const user = userEvent.setup();
			renderForm();

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "sterling");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");

			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(screen.getByLabelText("Case name")).toBeDisabled();
			expect(screen.getByLabelText("Persona name")).toBeDisabled();
			expect(
				screen.getByRole("button", { name: "Export template" }),
			).toBeDisabled();

			resolveMutation?.({ caseId: "convex-case-1" });
			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});

			expect(screen.getByLabelText("Case name")).not.toBeDisabled();
		});
	});

	describe("dirty tracking", () => {
		// Tests that the form starts clean, turns dirty on typing and is clean again after saving.
		it("starts clean, becomes dirty on typing, and clean again after a successful save", async () => {
			const { createRequests } = stubMutations();
			const user = userEvent.setup();
			renderForm();

			expect(unsavedGuard.isDirty).toBe(false);

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			expect(unsavedGuard.isDirty).toBe(true);

			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "sterling");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");
			await user.click(screen.getByRole("button", { name: "Submit" }));

			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});
			expect(unsavedGuard.isDirty).toBe(false);
			expect(createRequests).toHaveLength(1);
		});
	});

	describe("unsaved-changes navigation guard", () => {
		// Tests that a dirty navigation is cancelled, and allowed through once the changes are discarded.
		it("cancels a dirty navigation, but lets navigation through once discarded instead of re-blocking it", async () => {
			const user = userEvent.setup();
			renderForm();

			const guardCallback = vi.mocked(beforeNavigate).mock.calls.at(-1)?.[0];
			if (!guardCallback) throw new Error("expected a beforeNavigate callback");

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			expect(unsavedGuard.isDirty).toBe(true);

			const firstCancel = vi.fn();
			guardCallback({
				to: { url: new URL("http://localhost/admin") },
				cancel: firstCancel,
			} as never);
			expect(firstCancel).toHaveBeenCalledTimes(1);
			expect(unsavedGuard.showModal).toBe(true);

			await unsavedGuard.discard();
			expect(unsavedGuard.isDirty).toBe(false);

			const secondCancel = vi.fn();
			guardCallback({
				to: { url: new URL("http://localhost/admin") },
				cancel: secondCancel,
			} as never);
			expect(secondCancel).not.toHaveBeenCalled();
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

		// Tests that importing a modified export populates the form and shows its warnings.
		it("populates the form and surfaces warnings from a modified export file", async () => {
			const root = makePersona({
				id: "root1",
				name: "Original Root",
				role: "Lead",
				availability_minutes: 45,
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
				await screen.findByDisplayValue("Tweaked Case"),
			).toBeInTheDocument();
			expect(screen.getByText(/issue.*to review/i)).toBeInTheDocument();
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
			expect(
				screen.queryByText("Replace everything in this form?"),
			).not.toBeInTheDocument();
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

			expect(
				screen.queryByText("Replace everything in this form?"),
			).not.toBeInTheDocument();
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
			mockUseQuery.mockReturnValue({
				data: [makeAdminRow({ _id: "9", name: "Nina" })],
				isLoading: false,
				error: undefined,
			});
			renderForm();

			await openPicker();

			expect(await screen.findByText("Nina")).toBeInTheDocument();
		});

		// Tests that SUPER admins and the case owner are excluded from the picker in edit mode.
		it("excludes SUPER admins and the case's owner from the selectable list in edit mode", async () => {
			const doc = makeCaseDoc({ ownerAdminId: "5" });
			stubLoadCase(doc);
			mockUseQuery.mockReturnValue({
				data: [
					makeAdminRow({ _id: "5", name: "Owner Olivia", role: "admin" }),
					makeAdminRow({ _id: "6", name: "Super Sam", role: "super" }),
					makeAdminRow({ _id: "7", name: "Rank Rita", role: "admin" }),
				],
				isLoading: false,
				error: undefined,
			});
			renderForm({ editCaseId: doc._id });
			await screen.findByDisplayValue("Sterling Industries");

			await openPicker();

			expect(await screen.findByText("Rank Rita")).toBeInTheDocument();
			expect(screen.queryByText("Owner Olivia")).not.toBeInTheDocument();
			expect(screen.queryByText("Super Sam")).not.toBeInTheDocument();
		});

		// Tests that the signed-in admin is excluded from the picker as the effective owner in create mode.
		it("excludes the signed-in admin (api/admins:viewer) as the effective owner in create mode", async () => {
			mockUseQuery.mockReturnValue({
				data: [
					makeAdminRow({ _id: "1", name: "Me", email: "me@wisc.edu" }),
					makeAdminRow({
						_id: "2",
						name: "Rank Rita",
						email: "rita@wisc.edu",
					}),
				],
				isLoading: false,
				error: undefined,
			});
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
			mockUseQuery.mockReturnValue({
				data: [makeAdminRow({ _id: "9", name: "Nina" })],
				isLoading: false,
				error: undefined,
			});
			const user = userEvent.setup();
			renderForm();

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "sterling");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");

			await openPicker();
			const checkbox = await screen.findByLabelText("Nina");
			await user.click(checkbox);

			expect(screen.getByText("1 selected")).toBeInTheDocument();
			expect(checkbox).toBeChecked();

			await user.click(screen.getByRole("button", { name: "Submit" }));
			await waitFor(() => {
				expect(vi.mocked(sonner.toast)).toHaveBeenCalledWith(
					"Case saved successfully.",
				);
			});

			expect(createRequests[0]?.collaboratorAdminIds).toEqual(["9"]);

			await user.click(checkbox);
			expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
		});
	});
});
