// Shared E2E harness: one interceptor for the entire backend.
//
// The E2E suite runs a production build against a fully-mocked API — no server,
// no database, no LLM credentials. Rather than registering a `page.route` per
// endpoint (which silently lets an un-stubbed call fall through to a real
// socket and hang), everything under `/api/` goes through ONE route here and is
// dispatched by `METHOD /path`. Anything unmatched is failed with a 599 and a
// body naming the route, so a missing stub shows up as an obvious, immediate
// test failure instead of a timeout.

import type { Page, Route } from "@playwright/test";
import type { Api } from "../src/lib/types.js";
import {
	makeAdminOut,
	makeCaseDetail,
	makeContact,
	makePersonaPayload,
	makeRunState,
} from "../tests/support/fixtures.js";
import { sseBody } from "../tests/support/sse.js";

export { type SseFrame, sseBody } from "../tests/support/sse.js";

export type JsonBody = unknown;

export type HandlerResult =
	| { json: JsonBody; status?: number }
	| { sse: string }
	| { status: number; json?: JsonBody };

// `route` is exposed so a handler can do something the shortcuts cannot (abort
// the request, delay it, inspect headers). `body` is the parsed request body.
export type Handler = (context: {
	route: Route;
	url: URL;
	body: unknown;
}) => HandlerResult | Promise<HandlerResult> | void | Promise<void>;

// Keys look like "POST /api/cases" or "GET /api/cases/:id" — `:name` matches a
// single path segment.
export type Handlers = Record<string, Handler>;

function matches(pattern: string, method: string, pathname: string): boolean {
	const [patternMethod, patternPath] = pattern.split(" ");
	if (patternMethod !== method) return false;
	const patternParts = patternPath.split("/");
	const pathParts = pathname.split("/");
	if (patternParts.length !== pathParts.length) return false;
	return patternParts.every(
		(part, i) => part.startsWith(":") || part === pathParts[i],
	);
}

export async function mockApi(page: Page, handlers: Handlers): Promise<void> {
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();

		let body: unknown;
		try {
			body = request.postDataJSON();
		} catch {
			body = undefined;
		}

		const key = Object.keys(handlers).find((pattern) =>
			matches(pattern, method, url.pathname),
		);
		if (!key) {
			await route.fulfill({
				status: 599,
				contentType: "application/json",
				body: JSON.stringify({
					detail: `E2E: no mock registered for ${method} ${url.pathname}`,
				}),
			});
			return;
		}

		const result = await handlers[key]({ route, url, body });
		// A handler that fulfilled the route itself returns nothing.
		if (!result) return;
		if ("sse" in result) {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: result.sse,
			});
			return;
		}
		await route.fulfill({
			status: result.status ?? 200,
			contentType: "application/json",
			body: JSON.stringify(result.json ?? {}),
		});
	});
}

// --- SSE ------------------------------------------------------------------

// One complete, successful turn: the reply split across two `delta` frames (so
// the incremental renderer is genuinely exercised), then `meta`, then `done`.
// DoneFrame carries only `reply` (see backend/models/simulation_runtime.py) —
// the client reconstructs the committed turn locally from that plus what it
// already had (run.svelte.ts's overlayMessages()), so this mock doesn't need
// to echo the user's message or any prior history back.
export function turn(
	reply: string,
	{ meta = {} }: { meta?: Record<string, unknown> } = {},
): string {
	const split = Math.ceil(reply.length / 2);
	return sseBody([
		{ event: "delta", data: { text: reply.slice(0, split) } },
		{ event: "delta", data: { text: reply.slice(split) } },
		{
			event: "meta",
			data: {
				new_contacts: [],
				shared_files: [],
				chat_ended: false,
				chat_end_reason: null,
				warning_count: 0,
				...meta,
			},
		},
		{ event: "done", data: { reply } },
	]);
}

// --- fixtures -------------------------------------------------------------

export const ADMIN_ROLE = { SUPER: 1, ADMIN: 2 } as const;

// The admin route guards (src/lib/auth.ts's requireAdmin/requireSuperAdmin)
// confirm the session against GET /api/admin/me on every admin route load —
// no Google Identity round trip, which E2E cannot perform anyway, so this
// stubs that check directly. Seeding sessionStorage too means a test that
// renders admin UI before that fetch resolves still sees the right role.
// Registered as its own page.route (after mockApi's catch-all, so it wins —
// Playwright runs routes in reverse registration order) rather than folded
// into the Handlers map, since callers register mockApi() before calling this.
export async function signInAsAdmin(
	page: Page,
	{
		role = ADMIN_ROLE.ADMIN,
		email = "admin@wisc.edu",
	}: { role?: number; email?: string } = {},
): Promise<void> {
	await page.addInitScript(
		([adminRole, adminEmail]) => {
			sessionStorage.setItem(
				"caseLabSession",
				JSON.stringify({
					adminRole,
					adminEmail,
					runId: "",
					accessCode: "",
					startTime: null,
				}),
			);
		},
		[role, email] as const,
	);
	await page.route("**/api/admin/me", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ admin_id: 1, role, email, name: null }),
		});
	});
}

const marysPersona = () =>
	makePersonaPayload({
		id: "mary",
		name: "Mary",
		role: "Chief Financial Officer",
		known_facts: "The vendor is Acme.",
		personality_traits: "Direct.",
	});

export const contact = (overrides: Partial<Api<"ContactOut">> = {}) =>
	makeContact({ id: "mary", role: "Chief Financial Officer", ...overrides });

export const runState = (overrides: Partial<Api<"RunStateResponse">> = {}) =>
	makeRunState({ run_id: "testrun123", ...overrides });

export const caseDetail = (overrides: Partial<Api<"CaseDetail">> = {}) =>
	makeCaseDetail({
		personas: [marysPersona()],
		roots: ["mary"],
		...overrides,
	});

// The trimmed-down shape /api/cases (CaseListResponse) and the template/edit
// pickers render — deliberately smaller than caseDetail's, matching CaseSummary.
export const caseSummary = (overrides: Record<string, unknown> = {}) => ({
	id: 1,
	case_name: "Sterling Industries",
	access_code: "STERLING",
	...overrides,
});

export const adminOut = (overrides: Partial<Api<"AdminOut">> = {}) =>
	makeAdminOut({ role: ADMIN_ROLE.ADMIN, ...overrides });

// GET /api/cases/demo — same persona/referral shape as caseDetail, minus the
// id/version/ownership fields a demo case doesn't have.
export const demoCaseDetail = (
	overrides: Partial<
		Omit<
			Api<"CaseDetail">,
			"id" | "version" | "owner_admin_id" | "collaborator_admin_ids"
		>
	> = {},
) => {
	const { id, version, owner_admin_id, collaborator_admin_ids, ...rest } =
		caseDetail(overrides);
	return rest;
};

// GET /api/simulations/{id}/export — feeds the student PDF export.
export const exportResponse = (overrides: Record<string, unknown> = {}) => ({
	case: { id: 1, case_name: "Sterling Industries" },
	personas: [
		{
			id: "mary",
			name: "Mary",
			role: "Chief Financial Officer",
			messages: [],
		},
	],
	...overrides,
});
