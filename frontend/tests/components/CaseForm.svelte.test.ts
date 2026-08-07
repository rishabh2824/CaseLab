// Client project: CaseForm is the largest file in the frontend and the main
// case-authoring surface. These tests drive it through
// @testing-library/svelte + user-event, stubbing every endpoint it touches
// with MSW, and focus on the validation gate, the save/conflict paths, dirty
// tracking, persona add/remove cascades, and import — not the markup.
//
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http, type JsonBodyType } from "msw";
import * as sonner from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import CaseForm from "../../src/lib/components/CaseForm.svelte";
import { ADMIN_ROLE } from "../../src/lib/constants.js";
import { session } from "../../src/lib/session.svelte.js";
import type { Api } from "../../src/lib/types.js";
import { unsavedGuard } from "../../src/lib/unsavedGuard.svelte.js";
import {
	makeAdminOut,
	makeCaseDetail as makeBaseCaseDetail,
	makePersonaPayload as makeBasePersonaPayload,
	makePersona,
	makeReferral,
} from "../support/fixtures.js";
import { server } from "../support/msw.js";

function makePersonaPayload(
	overrides: Partial<Api<"PersonaPayload">> = {},
): Api<"PersonaPayload"> {
	return makeBasePersonaPayload({
		id: "p1",
		name: "Mary",
		role: "CFO",
		...overrides,
	});
}

function makeCaseDetail(
	overrides: Partial<Api<"CaseDetail">> = {},
): Api<"CaseDetail"> {
	return makeBaseCaseDetail({
		id: 7,
		access_code: "ABC123",
		brief: "Reduce costs.",
		common_information: "Background.",
		simulation_duration: 45,
		personas: [makePersonaPayload()],
		referrals: [],
		roots: ["p1"],
		version: 3,
		owner_admin_id: 1,
		collaborator_admin_ids: [],
		...overrides,
	});
}

function stubGetCase(detail: Api<"CaseDetail">) {
	server.use(
		http.get("*/api/cases/:id", ({ params }) => {
			if (String(params.id) !== String(detail.id)) {
				return HttpResponse.json({ detail: "Not found" }, { status: 404 });
			}
			return HttpResponse.json({
				case: detail,
			} satisfies Api<"CaseDetailResponse">);
		}),
	);
}

function stubVersion(id: number, version: number) {
	server.use(
		http.get(`*/api/cases/${id}/version`, () =>
			HttpResponse.json({ version } satisfies Api<"CaseVersionResponse">),
		),
	);
}

function stubCreate() {
	const requests: Api<"CasePayload">[] = [];
	server.use(
		http.post("*/api/cases", async ({ request }) => {
			requests.push((await request.json()) as Api<"CasePayload">);
			return HttpResponse.json({
				case_id: 1,
			} satisfies Api<"CaseCreatedResponse">);
		}),
	);
	return requests;
}

function stubUpdate(
	id: number,
	respond: (body: Api<"CaseUpdatePayload">) => {
		status: number;
		body: JsonBodyType;
	} = () => ({
		status: 200,
		body: { case_id: id },
	}),
) {
	const requests: Api<"CaseUpdatePayload">[] = [];
	server.use(
		http.put(`*/api/cases/${id}`, async ({ request }) => {
			const body = (await request.json()) as Api<"CaseUpdatePayload">;
			requests.push(body);
			const { status, body: responseBody } = respond(body);
			return HttpResponse.json(responseBody, { status });
		}),
	);
	return requests;
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
		// Never actually opened in these tests (that's the collaborator-picker
		// popover), but stubbed unconditionally since MSW's onUnhandledRequest:
		// "error" would otherwise punish any test that happens to trigger it.
		server.use(http.get("*/api/admin/admins", () => HttpResponse.json([])));
	});

	afterEach(() => {
		if (vi.isFakeTimers()) vi.useRealTimers();
	});

	describe("create mode — validation", () => {
		it("renders empty and surfaces required-field errors instead of sending a request", async () => {
			let createSeen = false;
			server.use(
				http.post("*/api/cases", () => {
					createSeen = true;
					return HttpResponse.json({ case_id: 1 });
				}),
			);
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
			expect(createSeen).toBe(false);
		});
	});

	describe("create mode — valid submit", () => {
		it("sends the expected payload with no expected_version and reports success", async () => {
			const requests = stubCreate();
			const user = userEvent.setup();
			renderForm();

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "ABC123");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");

			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(
				await screen.findByText("Case saved successfully."),
			).toBeInTheDocument();
			expect(requests).toHaveLength(1);
			expect(requests[0]).not.toHaveProperty("expected_version");
			expect(requests[0]?.case_name).toBe("Sterling Industries");
			expect(requests[0]?.personas?.[0]?.name).toBe("Mary");
		});
	});

	describe("edit mode", () => {
		it("loads the case into the form and its submit includes the loaded expected_version", async () => {
			const detail = makeCaseDetail();
			stubGetCase(detail);
			const updateRequests = stubUpdate(detail.id as number);
			const user = userEvent.setup();
			renderForm({ editCaseId: String(detail.id) });

			expect(
				await screen.findByDisplayValue("Sterling Industries"),
			).toBeInTheDocument();
			expect(screen.getByDisplayValue("Reduce costs.")).toBeInTheDocument();
			expect(screen.getByDisplayValue("ABC123")).toBeInTheDocument();
			expect(screen.getByDisplayValue("Mary")).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(
				await screen.findByText("Case updated successfully."),
			).toBeInTheDocument();
			expect(updateRequests).toHaveLength(1);
			expect(updateRequests[0]?.expected_version).toBe(detail.version);
		});

		it("shows the conflict modal (not a generic error) on a 409 version_conflict response", async () => {
			const detail = makeCaseDetail();
			stubGetCase(detail);
			server.use(
				http.put(`*/api/cases/${detail.id}`, () =>
					HttpResponse.json(
						{
							detail: {
								message: "This case was updated by someone else.",
								code: "version_conflict",
							},
						},
						{ status: 409 },
					),
				),
			);
			const user = userEvent.setup();
			renderForm({ editCaseId: String(detail.id) });
			await screen.findByDisplayValue("Sterling Industries");

			// The fields render before the loaded version arrives, and Submit
			// stays disabled until it does (CaseForm can't send a PUT without an
			// expected_version). Waiting on the button rather than on a field is
			// what makes this deterministic.
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled(),
			);
			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(
				await screen.findByText("This case was updated by someone else"),
			).toBeInTheDocument();
			// handleSubmit ignores performSave's return value entirely on the
			// conflict path, so the generic inline-error paragraph must stay empty
			// — the modal is the only surfaced error, not a duplicate message.
			expect(screen.queryByText("Upload failed.")).not.toBeInTheDocument();
		});

		it("detects a concurrent save via the background version poll and shows the conflict modal", async () => {
			// Fake timers must be installed *before* the component mounts: the
			// polling $effect's setInterval(..., 12000) is armed once, right when
			// isLoadingSource first clears, and only a timer scheduled while fake
			// timers are active can later be fast-forwarded by
			// advanceTimersByTimeAsync — installing them after mount would leave
			// that interval running on the real clock, unreachable by fake time.
			vi.useFakeTimers();
			const detail = makeCaseDetail();
			stubGetCase(detail);
			renderForm({ editCaseId: String(detail.id) });
			// findBy*'s own retry loop is MutationObserver-driven, not timer-driven,
			// so it still resolves as soon as the (real, microtask-scheduled) fetch
			// response updates the DOM — unaffected by the fake clock above.
			await screen.findByDisplayValue("Sterling Industries");

			stubVersion(detail.id as number, (detail.version as number) + 1);
			await vi.advanceTimersByTimeAsync(12000);

			expect(
				await screen.findByText("This case was updated by someone else"),
			).toBeInTheDocument();
		});

		it("surfaces the server's detail message inline for a non-conflict failure", async () => {
			const detail = makeCaseDetail();
			stubGetCase(detail);
			server.use(
				http.put(`*/api/cases/${detail.id}`, () =>
					HttpResponse.json(
						{ detail: "Access code already in use." },
						{ status: 400 },
					),
				),
			);
			const user = userEvent.setup();
			renderForm({ editCaseId: String(detail.id) });
			await screen.findByDisplayValue("Sterling Industries");

			// Same as the conflict test above: Submit is disabled until the
			// loaded version arrives, which lands after the fields do.
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
			const requests = stubCreate();
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
			await user.type(screen.getByLabelText("Access code"), "ABC123");
			await user.click(
				screen.getByRole("button", { name: "+ Add root persona" }),
			);
			await user.type(screen.getByLabelText("Persona name"), "Mary");
			await user.type(screen.getByLabelText("Title/Role"), "CFO");
			await user.click(screen.getByRole("button", { name: "Submit" }));

			await screen.findByText("Case saved successfully.");
			expect(unsavedGuard.isDirty).toBe(false);
			expect(requests).toHaveLength(1);
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
			const detail = makeCaseDetail();
			stubGetCase(detail);
			renderForm({ editCaseId: String(detail.id) });
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

		it("does not fetch the admin roster until the picker is opened, and only fetches it once", async () => {
			let fetchCount = 0;
			server.use(
				http.get("*/api/admin/admins", () => {
					fetchCount += 1;
					return HttpResponse.json([makeAdminOut({ id: 9, name: "Nina" })]);
				}),
			);
			renderForm();

			expect(fetchCount).toBe(0);

			const user = await openPicker();
			await screen.findByText("Nina");
			expect(fetchCount).toBe(1);

			// Close and reopen: already loaded, so no second fetch.
			await user.keyboard("{Escape}");
			await user.click(
				screen.getByRole("button", { name: /Add collaborators/ }),
			);
			await screen.findByText("Nina");
			expect(fetchCount).toBe(1);
		});

		it("excludes SUPER admins and the case's owner from the selectable list in edit mode", async () => {
			const detail = makeCaseDetail({ owner_admin_id: 5 });
			stubGetCase(detail);
			server.use(
				http.get("*/api/admin/admins", () =>
					HttpResponse.json([
						makeAdminOut({
							id: 5,
							name: "Owner Olivia",
							role: ADMIN_ROLE.ADMIN,
						}),
						makeAdminOut({ id: 6, name: "Super Sam", role: ADMIN_ROLE.SUPER }),
						makeAdminOut({ id: 7, name: "Rank Rita", role: ADMIN_ROLE.ADMIN }),
					]),
				),
			);
			renderForm({ editCaseId: String(detail.id) });
			await screen.findByDisplayValue("Sterling Industries");

			await openPicker();

			expect(await screen.findByText("Rank Rita")).toBeInTheDocument();
			expect(screen.queryByText("Owner Olivia")).not.toBeInTheDocument();
			expect(screen.queryByText("Super Sam")).not.toBeInTheDocument();
		});

		it("excludes the signed-in admin (matched by email) as the effective owner in create mode", async () => {
			session.setAdmin({
				adminRole: ADMIN_ROLE.ADMIN,
				adminEmail: "me@wisc.edu",
			});
			server.use(
				http.get("*/api/admin/admins", () =>
					HttpResponse.json([
						makeAdminOut({ id: 1, name: "Me", email: "me@wisc.edu" }),
						makeAdminOut({ id: 2, name: "Rank Rita", email: "rita@wisc.edu" }),
					]),
				),
			);
			renderForm();

			await openPicker();

			expect(await screen.findByText("Rank Rita")).toBeInTheDocument();
			expect(screen.queryByText("Me")).not.toBeInTheDocument();
		});

		it("toggling a collaborator updates the selected-count badge and is included in the submit payload", async () => {
			const requests = stubCreate();
			server.use(
				http.get("*/api/admin/admins", () =>
					HttpResponse.json([makeAdminOut({ id: 9, name: "Nina" })]),
				),
			);
			const user = userEvent.setup();
			renderForm();

			await user.type(
				screen.getByLabelText("Case name"),
				"Sterling Industries",
			);
			await user.type(screen.getByLabelText("Initial brief"), "Reduce costs.");
			await user.type(screen.getByLabelText("Access code"), "ABC123");
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

			expect(requests[0]?.collaborator_admin_ids).toEqual([9]);

			// Unchecking removes it again.
			await user.click(checkbox);
			expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
		});
	});
});
