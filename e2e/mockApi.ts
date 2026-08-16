// Shared E2E harness: one Convex mock for the entire backend.
//
// The E2E suite runs a production build (with `E2E=true`, see vite.config.ts) against a
// fully-mocked Convex client -- no server, no database, no LLM credentials, no real
// WebSocket. `e2e/support/convexMock.svelte.ts` is swapped in for `convex-svelte` at build
// time; it reads reactive query data from a Node-bridged in-memory store and forwards every
// mutation/action call here via `window.__e2eConvexCall`. A call to a function this file
// hasn't registered a handler for throws an explicit "no mock registered" error (queries)
// or rejects the same way (mutations/actions) -- a missing stub shows up as a loud, specific
// failure instead of a silent hang or a stale-data false pass.
import type { Page } from "@playwright/test";
import type { AdminRole } from "../src/lib/constants.js";
import { ADMIN_ROLE } from "../src/lib/constants.js";
import type { Persona, ReferralEdge } from "../src/lib/types.js";
import {
	makeContact,
	makePersonaPayload,
	makeRunState,
} from "../tests/support/fixtures.js";

export type QueryEntry = { data: unknown } | { error: string };

export type QuerySeed = { name: string; args: unknown } & (
	| { data: unknown; error?: undefined }
	| { error: string; data?: undefined }
);

export type ConvexHandlerCtx = {
	page: Page;
	setQuery: (name: string, args: unknown, entry: QueryEntry) => Promise<void>;
};

// args/return vary per Convex function -- mirrors the old Handler type's own deliberately-
// untyped body context.
export type ConvexHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: see comment above
	args: any,
	ctx: ConvexHandlerCtx,
) => unknown | Promise<unknown>;

export type MockApiConfig = {
	// Seeded once via page.addInitScript, before the app's own top-level code runs -- so it's
	// in place for the very first render AND survives a page.reload() (a fresh JS context
	// re-runs the init script) without needing to be re-pushed by hand. Use the returned
	// `setQuery` helper (or a mutation handler's own ctx.setQuery) for anything that needs to
	// change reactively mid-test.
	queries?: QuerySeed[];
	// Keyed by Convex function name, e.g. "api/cases:create" -- NOT prefixed with a method,
	// unlike the old REST route map, since Convex has no HTTP verb to key on.
	mutations?: Record<string, ConvexHandler>;
	actions?: Record<string, ConvexHandler>;
};

export async function mockApi(
	page: Page,
	config: MockApiConfig,
): Promise<void> {
	const { queries = [], mutations = {}, actions = {} } = config;

	await page.addInitScript((seed) => {
		(window as unknown as { __e2eConvexSeed: unknown }).__e2eConvexSeed = seed;
	}, queries);

	const setQuery = async (
		name: string,
		args: unknown,
		entry: QueryEntry,
	): Promise<void> => {
		await page.evaluate(
			([n, a, e]) => {
				(
					window as unknown as {
						__e2eConvex?: {
							setQuery: (n: string, a: unknown, e: QueryEntry) => void;
						};
					}
				).__e2eConvex?.setQuery(n, a, e);
			},
			[name, args, entry] as const,
		);
	};

	await page.exposeFunction(
		"__e2eConvexCall",
		async (kind: "mutation" | "action", name: string, args: unknown) => {
			const table = kind === "mutation" ? mutations : actions;
			const handler = table[name];
			if (!handler) {
				throw new Error(`E2E: no mock registered for ${kind} ${name}`);
			}
			return await handler(args, { page, setQuery });
		},
	);
}

// Pushes (or overwrites) one query's data outside of a mutation handler -- e.g. seeding
// state after navigation, or from a test's own top-level code rather than a handler's ctx.
export async function pushQuery(
	page: Page,
	name: string,
	args: unknown,
	entry: QueryEntry,
): Promise<void> {
	await page.evaluate(
		([n, a, e]) => {
			(
				window as unknown as {
					__e2eConvex?: {
						setQuery: (n: string, a: unknown, e: QueryEntry) => void;
					};
				}
			).__e2eConvex?.setQuery(n, a, e);
		},
		[name, args, entry] as const,
	);
}

// --- admin sign-in ----------------------------------------------------------

export { ADMIN_ROLE };

// admin/+layout.ts gates purely on `session.adminRole` (sessionStorage's "caseLabSession"
// key, see src/lib/session.svelte.ts) -- it does NOT re-query Convex's api/admins:viewer on
// every admin page load (that only happens once, during the real Google-OAuth sign-in flow
// on the landing page, which AdminAuth.svelte mounts lazily and no E2E test here ever
// triggers). So faking "already signed in as admin" only needs this same session key seeded
// directly, exactly like the old REST-era harness did -- nothing Convex-specific to mock.
export async function signInAsAdmin(
	page: Page,
	{
		role = ADMIN_ROLE.ADMIN,
		email = "admin@wisc.edu",
	}: { role?: AdminRole; email?: string } = {},
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
}

// --- student-flow fixtures ---------------------------------------------------

export const contact = (overrides: Parameters<typeof makeContact>[0] = {}) =>
	makeContact({ id: "mary", role: "Chief Financial Officer", ...overrides });

export const runState = (overrides: Parameters<typeof makeRunState>[0] = {}) =>
	makeRunState({
		run_id: "testrun123",
		contacts: [contact()],
		active_persona_id: "mary",
		...overrides,
	});

export type ChatMessage = { role: "user" | "assistant"; content: string };

// Builds a "mutation api/turn:start" handler emulating one full turn against the reactive
// query split the real backend uses (see run.svelte.ts's comments on #historyQuery/
// #streamingPreviewQuery/#runStateQuery): persists the user's message immediately (mirrors
// startTurn's synchronous insert before scheduling runTurn), then pushes a streaming preview
// and finally the persisted assistant reply -- or, for `reply: null`, pushes only a
// streaming-preview error and never persists a reply, for testing a failed turn.
// `nextRunState`, if given, is pushed to api/simulations:get once the turn completes -- the
// Convex equivalent of the old SSE `meta` frame's new_contacts/shared_files/chat_ended,
// which now simply live on the run document itself (see services/turn.ts's applyDecisions
// comment) instead of a separate side-channel.
export function turnHandler({
	reply,
	history = [],
	nextRunState,
	partialText,
}: {
	reply: string | null;
	history?: ChatMessage[];
	nextRunState?: ReturnType<typeof runState>;
	// Only meaningful when reply is null: an in-progress preview pushed before the error,
	// to prove the reducer discards partial streamed text rather than committing it.
	partialText?: string;
}): ConvexHandler {
	return async (args, { setQuery }) => {
		const { runId, personaId, message } = args as {
			runId: string;
			personaId: string;
			message: string;
		};
		const withUser: ChatMessage[] = [
			...history,
			{ role: "user", content: message },
		];
		await setQuery(
			"api/simulations:getPersonaHistory",
			{ runId, personaId },
			{ data: withUser },
		);

		if (reply === null) {
			if (partialText) {
				await setQuery(
					"api/turn:getStreamingPreview",
					{ runId, personaId },
					{ data: { status: "streaming", text: partialText } },
				);
			}
			await setQuery(
				"api/turn:getStreamingPreview",
				{ runId, personaId },
				{ data: { status: "error", text: "" } },
			);
			return;
		}

		const split = Math.ceil(reply.length / 2);
		await setQuery(
			"api/turn:getStreamingPreview",
			{ runId, personaId },
			{ data: { status: "streaming", text: reply.slice(0, split) } },
		);
		const withReply: ChatMessage[] = [
			...withUser,
			{ role: "assistant", content: reply },
		];
		await setQuery(
			"api/simulations:getPersonaHistory",
			{ runId, personaId },
			{ data: withReply },
		);
		await setQuery(
			"api/turn:getStreamingPreview",
			{ runId, personaId },
			{ data: { status: "done", text: "" } },
		);
		if (nextRunState) {
			await setQuery("api/simulations:get", { runId }, { data: nextRunState });
		}
	};
}

// --- admin case-authoring fixtures --------------------------------------------

// Matches the `structure.personas[]` shape services/cases.ts's buildStructure writes and
// draft.ts's normalizePersona reads back -- snake_case, mirroring the still-untouched
// CaseGraph/CaseGraphEditor frontend (see convex/models/cases.ts's own comment).
export const personaEntry = (
	overrides: Partial<Persona> = {},
): Partial<Persona> => ({
	id: "mary",
	name: "Mary",
	role: "Chief Financial Officer",
	profile_photo: null,
	known_facts: "The vendor is Acme.",
	personality_traits: "Direct.",
	availability_minutes: null,
	files: [],
	...overrides,
});

export const referralEntry = (
	overrides: Partial<ReferralEdge> = {},
): ReferralEdge => ({
	from_id: "",
	to_id: "",
	conditions: "",
	...overrides,
});

// A Convex `cases` document as api/cases:get / getForEdit / listAll return it -- `_id`/
// `name`/`accessCode`/`structure`, not the old REST era's `id`/`case_name`/`access_code`.
// `collaboratorAdminIds` is only ever present on getForEdit's response (see its own comment
// in convex/api/cases.ts) -- omit it for listAll/get seeds.
export const caseDoc = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	_id: "case1",
	_creationTime: 0,
	name: "Sterling Industries",
	brief: "Reduce office supply costs.",
	commonInformation: "",
	duration: null,
	accessCode: "sterling",
	ownerAdminId: "admin1",
	structure: {
		personas: [personaEntry()],
		referrals: [],
		roots: ["mary"],
	},
	...overrides,
});

// A Convex `admins` document as api/admins:listAll / create return it -- `_id`/`role`
// ("super" | "admin" string literals, see convex/models/admin.ts), not the old numeric
// ADMIN_ROLE enum (that stays frontend-only, for session/route-gating -- see constants.ts).
export const adminDoc = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	_id: "admin1",
	_creationTime: 0,
	email: "admin@wisc.edu",
	name: undefined,
	role: "admin",
	...overrides,
});

// Re-exported so spec files that only need a bare persona payload (not a full structure
// entry) can build one without reaching into fixtures.ts directly.
export { makePersonaPayload };
