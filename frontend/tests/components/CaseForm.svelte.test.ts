// Client project: CaseForm is the largest file in the frontend and the main
// case-authoring surface. These tests drive it through
// @testing-library/svelte + user-event, stubbing every endpoint it touches
// with MSW, and focus on the validation gate, the save/conflict paths, dirty
// tracking, persona add/remove cascades, and import — not the markup.
//
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import CaseForm from "../../src/lib/components/CaseForm.svelte";
import type { Api } from "../../src/lib/types.js";
import { useUnsavedGuard } from "../../src/lib/unsavedGuard.svelte.js";
import { makePersona, makeReferral } from "../support/fixtures.js";
import { server } from "../support/msw.js";

function makePersonaOut(
	overrides: Partial<Api<"PersonaOut">> = {},
): Api<"PersonaOut"> {
	return {
		id: "p1",
		name: "Mary",
		role: "CFO",
		profile_photo: null,
		known_facts: "",
		personality_traits: "",
		availability_minutes: null,
		files: [],
		...overrides,
	};
}

function makeCaseDetail(
	overrides: Partial<Api<"CaseDetail">> = {},
): Api<"CaseDetail"> {
	return {
		id: 7,
		case_name: "Sterling Industries",
		access_code: "ABC123",
		initial_brief: "Reduce costs.",
		common_information: "Background.",
		simulation_duration: 45,
		personas: [makePersonaOut()],
		referrals: [],
		roots: ["p1"],
		version: 3,
		owner_admin_id: 1,
		collaborator_admin_ids: [],
		...overrides,
	};
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

function renderForm(
	props: { editCaseId?: string | null; templateId?: string | null } = {},
) {
	return render(CaseForm, { props });
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
			const updateRequests = stubUpdate(detail.id);
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

			stubVersion(detail.id, detail.version + 1);
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
			const unsavedGuard = useUnsavedGuard();
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

		it("surfaces the import error message for an unrelated HTML file", async () => {
			const file = new File(
				["<html><body><p>hello</p></body></html>"],
				"random.html",
				{ type: "text/html" },
			);
			const user = userEvent.setup();
			const { container } = renderForm();

			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await user.upload(fileInput, file);

			expect(
				await screen.findByText(
					"This doesn't look like a Case Lab import file.",
				),
			).toBeInTheDocument();
		});
	});
});
