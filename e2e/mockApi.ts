import type { Page } from "@playwright/test";
import type { StudentErrorCode } from "../convex/lib/studentErrors.js";
import type { AdminRole, Persona, ReferralEdge } from "../src/lib/types.js";
import {
	makeContact,
	makePersonaPayload,
	makeRunState,
} from "../tests/support/fixtures.js";

export type MockError = string | { code: StudentErrorCode; message: string };

export type QueryEntry = { data: unknown } | { error: MockError };

class MockStudentError extends Error {
	// Creates a mock student error carrying a code and message.
	constructor(
		readonly code: StudentErrorCode,
		message: string,
	) {
		super(message);
	}
}
// Builds a mock student error for a handler to throw.
export const studentError = (code: StudentErrorCode, message: string) =>
	new MockStudentError(code, message);

export type QuerySeed = { name: string; args: unknown } & (
	| { data: unknown; error?: undefined }
	| { error: MockError; data?: undefined }
);

export type ConvexHandlerCtx = {
	page: Page;
	setQuery: (name: string, args: unknown, entry: QueryEntry) => Promise<void>;
};

export type ConvexHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: mock request bodies vary in shape and are read freely by property
	args: any,
	ctx: ConvexHandlerCtx,
) => unknown | Promise<unknown>;

export type MockApiConfig = {
	queries?: QuerySeed[];
	mutations?: Record<string, ConvexHandler>;
	actions?: Record<string, ConvexHandler>;
	turn?: ConvexHandler;
};

// Installs the mock Convex backend on a page: seeds queries and routes mutations, actions and /turn-stream to handlers.
export async function mockApi(
	page: Page,
	config: MockApiConfig,
): Promise<void> {
	const { queries = [], mutations = {}, actions = {}, turn } = config;

	await page.route("**/api/auth/**", (route) => route.abort());

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

	await page.route("**/turn-stream", async (route) => {
		if (!turn) return await route.abort();
		const headers = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Expose-Headers": "X-Stream-Id",
		};
		try {
			const streamId = await turn(route.request().postDataJSON(), {
				page,
				setQuery,
			});
			await route.fulfill({
				headers: { ...headers, "X-Stream-Id": String(streamId) },
				body: "",
			});
		} catch (err) {
			if (!(err instanceof MockStudentError)) throw err;
			await route.fulfill({
				status: 400,
				headers,
				json: { code: err.code, message: err.message },
			});
		}
	});

	await page.exposeFunction(
		"__e2eConvexCall",
		async (kind: "mutation" | "action", name: string, args: unknown) => {
			const table = kind === "mutation" ? mutations : actions;
			const handler = table[name];
			if (!handler) {
				throw new Error(`E2E: no mock registered for ${kind} ${name}`);
			}
			try {
				return await handler(args, { page, setQuery });
			} catch (err) {
				if (err instanceof MockStudentError) {
					return {
						__e2eStudentError: { code: err.code, message: err.message },
					};
				}
				throw err;
			}
		},
	);
}

// Pushes a new result for a query into the running page.
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

export const ADMIN_ROLE = Object.freeze({
	SUPER: "super",
	ADMIN: "admin",
}) satisfies Record<string, AdminRole>;

// Pre-signs the page in as an admin with the given role and email.
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
					startTime: null,
				}),
			);
			const w = window as unknown as {
				__e2eConvexSeed?: Array<{
					name: string;
					args: unknown;
					data?: unknown;
					error?: MockError;
				}>;
			};
			w.__e2eConvexSeed = [
				...(w.__e2eConvexSeed ?? []),
				{
					name: "api/admins:viewer",
					args: {},
					data: { email: adminEmail, role: adminRole },
				},
			];
		},
		[role, email] as const,
	);
}

// Builds a mock contact defaulting to Mary, the CFO.
export const contact = (overrides: Parameters<typeof makeContact>[0] = {}) =>
	makeContact({ id: "mary", role: "Chief Financial Officer", ...overrides });

// Builds a mock run state with a default run id and one contact.
export const runState = (overrides: Parameters<typeof makeRunState>[0] = {}) =>
	makeRunState({
		run_id: "testrun123",
		contacts: [contact()],
		...overrides,
	});

export type ChatMessage = { role: "user" | "assistant"; content: string };

let turnCounter = 0;
// Builds a /turn-stream handler that simulates a turn by updating history and the reply stream, or failing it.
export function turnHandler({
	reply,
	history = [],
	nextRunState,
	partialText,
}: {
	reply: string | null;
	history?: ChatMessage[];
	nextRunState?: ReturnType<typeof runState>;
	partialText?: string;
}): ConvexHandler {
	return async (args, { setQuery }) => {
		const { runId, personaId, message } = args as {
			runId: string;
			personaId: string;
			message: string;
		};
		const streamId = `e2e-stream-${++turnCounter}`;
		const pushTurn = (turn: {
			status: string;
			text?: string;
			settled?: boolean;
		}) =>
			setQuery(
				"api/turn:getTurnStream",
				{ runId, personaId, withText: true },
				{
					data: {
						streamId,
						settled: false,
						text: "",
						...turn,
					},
				},
			);
		if (reply === null) {
			if (partialText) {
				await pushTurn({ status: "streaming", text: partialText });
			}
			await pushTurn({ status: "error" });
			return streamId;
		}

		const split = Math.ceil(reply.length / 2);
		await pushTurn({ status: "streaming", text: reply.slice(0, split) });
		const withReply: ChatMessage[] = [
			...history,
			{ role: "user", content: message },
			{ role: "assistant", content: reply },
		];
		// The real server commits both in one transaction; settling first keeps the pending bubble and the saved copy from overlapping here.
		await pushTurn({ status: "done", settled: true });
		await setQuery(
			"api/simulations:getPersonaHistory",
			{ runId, personaId },
			{ data: withReply },
		);
		if (nextRunState) {
			await setQuery("api/simulations:get", { runId }, { data: nextRunState });
		}
		return streamId;
	};
}

// Builds a persona entry for a mock case, defaulting to Mary.
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

// Builds a referral entry with blank defaults.
export const referralEntry = (
	overrides: Partial<ReferralEdge> = {},
): ReferralEdge => ({
	from_id: "",
	to_id: "",
	conditions: "",
	...overrides,
});

// Builds a mock case document.
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
	isDemo: false,
	structure: {
		personas: [personaEntry()],
		referrals: [],
		roots: ["mary"],
	},
	...overrides,
});

// Builds a mock admin document.
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

export { makePersonaPayload };
