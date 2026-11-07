import type { FunctionReturnType } from "convex/server";
import { expect, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import CaseForm from "../../../../src/lib/components/case/CaseForm.svelte";
import type { AdminRow, PersonaPayload } from "../../../../src/lib/types.js";
import { convexFake } from "../../../support/convexFake.svelte.js";
import { makePersonaPayload as makeBasePersonaPayload } from "../../../support/factories.js";
import { viewerState } from "./viewerMock.js";

// Shared by the CaseForm test files: the typed fake backend, builders for cases and admins, ways to fill the form in, and helpers for the persona diagram.

export const getForEdit = convexFake.clientQuery(api.cases.getForEdit);
export const getTemplate = convexFake.clientQuery(api.cases.getTemplate);
export const createCase = convexFake.mutation(api.cases.create);
export const updateCase = convexFake.mutation(api.cases.update);

// Sets the admin roster the collaborator picker subscribes to.
export function setRoster(rows: AdminRow[]) {
	convexFake.setQueryData(api.admins.listAll, rows);
}

// Builds an admin row with defaults and optional overrides.
export function makeAdminRow(
	overrides: Partial<Omit<AdminRow, "_id">> & { _id?: string } = {},
): AdminRow {
	return {
		_id: "admin-1",
		_creationTime: 0,
		email: "admin@wisc.edu",
		name: "Admin One",
		role: "admin",
		...overrides,
	} as AdminRow;
}

// Builds a persona payload named Mary with optional overrides.
export function makePersonaPayload(
	overrides: Partial<PersonaPayload> = {},
): PersonaPayload {
	return makeBasePersonaPayload({
		id: "p1",
		name: "Mary",
		role: "CFO",
		...overrides,
	});
}

export type ConvexCaseDoc = FunctionReturnType<typeof api.cases.getForEdit>;

// Builds a case document with defaults and optional overrides.
export function makeCaseDoc(
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
export function stubLoadCase(doc: ConvexCaseDoc) {
	getForEdit.mockImplementation(async ({ caseId }) => {
		if (caseId !== doc._id) throw new Error("Case not found.");
		return doc;
	});
}

// Stubs the create and update mutations and records the requests made.
export function stubMutations() {
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

// A form field found by its exact label. Locators match part of a label by default, which would also catch "Profile photo" when looking for "File".
export const field = (label: string) =>
	page.getByLabelText(label, { exact: true });

export const saveButton = () => page.getByRole("button", { name: "Save case" });

// Opens one of the form's tabs.
export const openTab = (name: string) =>
	page.getByRole("tab", { name }).click();

// Renders the case form in create, edit or template mode with an optional viewer.
export function renderForm(
	props: {
		editCaseId?: string | null;
		templateId?: string | null;
		viewer?: AdminRow | null;
	} = {},
) {
	const { editCaseId = null, templateId = null, viewer = null } = props;
	viewerState.current = viewer;
	return render(CaseForm, {
		source: editCaseId
			? { kind: "edit", id: editCaseId }
			: templateId
				? { kind: "template", id: templateId }
				: { kind: "new" },
	});
}

// Waits until an edited case has loaded, which shows as its first persona (Mary) in the editor.
export async function waitForLoadedCase() {
	await expect.element(field("Persona name")).toHaveValue("Mary");
}

// Fills the create form with a valid case: case info plus one root persona.
export async function fillValidCase() {
	await field("Case name").fill("Sterling Industries");
	await field("Student brief").fill("Reduce costs.");
	await field("Access code").fill("sterling");
	await openTab("AI Personas");
	await page.getByRole("button", { name: "+ Add starting persona" }).click();
	await field("Persona name").fill("Mary");
	await field("Title/Role").fill("CFO");
	await field("Persona instructions").fill("Approved the budget.");
}

// The persona diagram, which is the real Svelte Flow canvas.
const diagram = () =>
	page.elementLocator(document.querySelector(".svelte-flow")!);

// A persona's box in the diagram, found by the name it shows.
export const diagramNode = (name: string) =>
	diagram().getByText(name, { exact: true });

// How many persona boxes the diagram shows.
export const diagramNodeCount = () =>
	document.querySelectorAll(".svelte-flow__node").length;

// Clicks a referral's arrow. The arrow is a thin line with no area of its own to aim at, so the click is sent to the arrow itself.
export function clickArrow(fromId: string, toId: string) {
	const arrow = document.querySelector(
		`.svelte-flow__edge[data-id="${fromId}->${toId}"]`,
	);
	if (!arrow) throw new Error(`No arrow from ${fromId} to ${toId}.`);
	arrow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

// Drags from one persona's dot to a point on another persona's box, the way a mouse does: press, many small moves, release. The box's drop zone only exists once a drag is under way, so the moves cannot be skipped.
export async function dragArrow(
	fromId: string,
	toId: string,
	options: { across?: number } = {},
) {
	const handle = document.querySelector(
		`.svelte-flow__node[data-id="${fromId}"] .svelte-flow__handle.source`,
	);
	const target = document.querySelector(
		`.svelte-flow__node[data-id="${toId}"]`,
	);
	if (!handle || !target) throw new Error("Both personas must be on screen.");
	const start = handle.getBoundingClientRect();
	const end = target.getBoundingClientRect();
	const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
	const to = {
		x: end.x + end.width * (options.across ?? 0.75),
		y: end.y + end.height / 2,
	};
	const mouse = (type: string, point: { x: number; y: number }) => ({
		type,
		init: { clientX: point.x, clientY: point.y, bubbles: true, button: 0 },
	});
	const nextFrame = () =>
		new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

	const down = mouse("mousedown", from);
	handle.dispatchEvent(new MouseEvent(down.type, down.init));
	const steps = 15;
	for (let step = 1; step <= steps; step++) {
		const point = {
			x: from.x + ((to.x - from.x) * step) / steps,
			y: from.y + ((to.y - from.y) * step) / steps,
		};
		const move = mouse("mousemove", point);
		document.dispatchEvent(new MouseEvent(move.type, move.init));
		await nextFrame();
	}
	const up = mouse("mouseup", to);
	document.dispatchEvent(new MouseEvent(up.type, up.init));
	await nextFrame();
}

// Fires the callback the form registered with beforeNavigate, as SvelteKit does on a navigation, and reports whether it was cancelled.
export function navigationGuard(
	beforeNavigateMock: ReturnType<typeof vi.fn>,
	target = new URL("http://localhost/admin"),
): () => boolean {
	const callback = beforeNavigateMock.mock.calls.at(-1)?.[0];
	if (!callback) throw new Error("expected a beforeNavigate callback");
	return () => {
		const cancel = vi.fn();
		callback({ to: { url: target }, cancel } as never);
		return cancel.mock.calls.length > 0;
	};
}
