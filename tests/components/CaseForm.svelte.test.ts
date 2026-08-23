// Client project: CaseForm is the largest file in the frontend and the main
// case-authoring surface. These tests drive it through
// @testing-library/svelte + user-event, stubbing every endpoint it touches,
// and focus on the validation gate, the save/load paths, dirty tracking,
// persona add/remove cascades, and import — not the markup.
//
// Everything CaseForm touches (admin roster, case load, case create/update)
// goes through Convex now, so convex-svelte is mocked here rather than MSW.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import CaseForm from "../../src/lib/components/CaseForm.svelte";
import { session } from "../../src/lib/session.svelte.js";
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

function makeAdminRow(overrides: Partial<AdminRow> = {}): AdminRow {
	return {
		_id: "admin-1",
		email: "admin@wisc.edu",
		name: "Admin One",
		role: "admin",
		...overrides,
	};
}

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

// The shape api/cases:getForEdit returns: a raw Convex case doc (camelCase scalars,
// snake_case `structure` -- see convex/models/cases.ts) plus a flattened
// collaboratorAdminIds list.
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

// Loading a case (edit or template mode) goes through getConvexClient().query -- stub it to
// respond only to the matching caseId, same way a real query would 404/reject otherwise.
function stubLoadCase(doc: ConvexCaseDoc) {
	mockClientQuery.mockImplementation(
		async (_ref: unknown, args: { caseId: string }) => {
			if (args.caseId !== doc._id) throw new Error("Case not found.");
			return doc;
		},
	);
}

// Replaces the old MSW-based POST/PUT /api/cases stubs: case creation and update now go
// through Convex's create/update mutations (see submitCase.ts). Update's args always carry
// a `caseId`, create's never do -- that's how the two are told apart here.
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

// Mirrors what the /admin/cases/new and /admin/cases/[id]/edit route files
// pass CaseForm — editCaseId here stands in for those routes' page.params.id.
function renderForm(
	props: { editCaseId?: string | null; templateId?: string | null } = {},
) {
	const { editCaseId = null, templateId = null } = props;
	return render(CaseForm, {
		props: {
			mode: editCaseId ? "edit" : "create",
			caseId: editCaseId,
			templateId,
		},
	});
}

describe("CaseForm", () => {
	beforeEach(() => {
		mockUseQuery.mockReset();
		mockClientQuery.mockReset();
		mockClientMutation.mockReset();
		mockClientAction.mockReset();
		// Safe default roster (empty, already loaded) — collaborator-picker tests
		// below override this with their own fixture list before rendering.
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
		it("renders empty and surfaces required-field errors instead of sending a request", async () => {
			const { container } = renderForm();

			expect(screen.getByLabelText("Case name")).toHaveValue("");
			expect(
				screen.queryByText("Case name is required."),
			).not.toBeInTheDocument();

			// The Submit button is disabled while the form is invalid (which it
			// always is when blank), so a real click can never fire it — dispatch
			// the submit event directly, the same way pressing Enter in a field
			// would if the button weren't disabled.
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

			expect(
				await screen.findByText("Case saved successfully."),
			).toBeInTheDocument();
			expect(createRequests).toHaveLength(1);
			expect(createRequests[0]?.name).toBe("Sterling Industries");
			expect(
				(createRequests[0]?.personas as PersonaPayload[] | undefined)?.[0]
					?.name,
			).toBe("Mary");
		});
	});

	describe("edit mode", () => {
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
	});

	describe("dirty tracking", () => {
		it("starts clean, becomes dirty on typing, and clean again after a successful save", async () => {
			const { createRequests } = stubMutations();
			const user = userEvent.setup();
			renderForm();

			// This gates AdminTopBar's unsaved-changes prompt, so it's worth
			// pinning at each transition rather than just the end state.
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

			await screen.findByText("Case saved successfully.");
			expect(unsavedGuard.isDirty).toBe(false);
			expect(createRequests).toHaveLength(1);
		});
	});

	describe("persona add/remove", () => {
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

		it("removing a root also removes referral edges into it, dropping a persona that becomes unreachable", async () => {
			const user = userEvent.setup();
			renderForm();

			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(1);

			// Referring out creates the second persona (reachableFrom's territory —
			// see draft.test.ts for the helper itself; this pins the observable
			// outcome in the actual form).
			await user.click(screen.getByRole("button", { name: "+ Add referral" }));
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(2);

			// The root's own "Remove" (in CaseForm's own summary) is first in DOM
			// order; the nested referral-edge "Remove" (inside the root's
			// PersonaFields) comes after it — index [0] reliably targets the root.
			const [rootRemoveButton] = screen.getAllByRole("button", {
				name: "Remove",
			});
			if (!rootRemoveButton) throw new Error("expected a Remove button");
			await user.click(rootRemoveButton);

			// Both the root and the persona only reachable through it are gone.
			expect(screen.queryAllByLabelText("Persona name")).toHaveLength(0);
		});
	});

	describe("import", () => {
		it("is offered in create mode (no source case)", () => {
			renderForm();
			expect(
				screen.getByRole("button", { name: "Import template" }),
			).toBeInTheDocument();
		});

		it("is not offered in edit mode", async () => {
			const doc = makeCaseDoc();
			stubLoadCase(doc);
			renderForm({ editCaseId: doc._id });
			await screen.findByDisplayValue("Sterling Industries");
			expect(
				screen.queryByRole("button", { name: "Import template" }),
			).not.toBeInTheDocument();
		});

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
				// replaceAll: "Original Case" also appears in the <title> tag, which
				// the test doesn't care about — only the case_name field's value
				// (read via getByDisplayValue below) actually matters.
				.replaceAll("Original Case", "Tweaked Case")
				// The root's availability_minutes field renders as exactly "45" —
				// corrupting it to non-numeric text exercises parseNumberField's
				// warning path (see importCase.ts) without hand-building HTML.
				.replace(">45\n    </textarea>", ">not-a-number\n    </textarea>");
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

			// Existing content in the form is what makes the import destructive —
			// an empty form (the earlier test) skips the confirm dialog entirely.
			await user.type(screen.getByLabelText("Case name"), "Existing Case");

			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await user.upload(fileInput, file);

			expect(
				await screen.findByText("Replace everything in this form?"),
			).toBeInTheDocument();
			// Not yet applied — confirming is still pending.
			expect(screen.getByLabelText("Case name")).toHaveValue("Existing Case");

			await user.click(screen.getByRole("button", { name: "Import" }));

			expect(
				await screen.findByDisplayValue("Imported Case"),
			).toBeInTheDocument();
			expect(
				screen.queryByText("Replace everything in this form?"),
			).not.toBeInTheDocument();
		});

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
		afterEach(() => {
			session.clearAdmin();
		});

		async function openPicker() {
			const user = userEvent.setup();
			await user.click(
				screen.getByRole("button", { name: /Add collaborators/ }),
			);
			return user;
		}

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

		it("excludes the signed-in admin (matched by email) as the effective owner in create mode", async () => {
			session.setAdmin({
				adminRole: "admin",
				adminEmail: "me@wisc.edu",
			});
			mockUseQuery.mockReturnValue({
				data: [
					makeAdminRow({ _id: "1", name: "Me", email: "me@wisc.edu" }),
					makeAdminRow({ _id: "2", name: "Rank Rita", email: "rita@wisc.edu" }),
				],
				isLoading: false,
				error: undefined,
			});
			renderForm();

			await openPicker();

			expect(await screen.findByText("Rank Rita")).toBeInTheDocument();
			expect(screen.queryByText("Me")).not.toBeInTheDocument();
		});

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

			// bits-ui's floating-ui positioning leaves the popover content
			// `visibility: hidden` in jsdom (it never resolves a real layout), and
			// getByRole excludes invisible elements — so this looks the checkbox
			// up by its (visibility-blind) implicit label text instead.
			await openPicker();
			const checkbox = await screen.findByLabelText("Nina");
			await user.click(checkbox);

			expect(screen.getByText("1 selected")).toBeInTheDocument();
			expect(checkbox).toBeChecked();

			await user.click(screen.getByRole("button", { name: "Submit" }));
			await screen.findByText("Case saved successfully.");

			expect(createRequests[0]?.collaboratorAdminIds).toEqual(["9"]);

			// Unchecking removes it again.
			await user.click(checkbox);
			expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
		});
	});
});
