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

// Installs the mock Convex backend on a page: seeds queries and routes mutations and actions to handlers; turn handles turn:sendMessage.
export async function mockApi(
	page: Page,
	config: MockApiConfig,
): Promise<void> {
	const { queries = [], actions = {}, turn } = config;
	const mutations = turn
		? { ...config.mutations, "turn:sendMessage": turn }
		: (config.mutations ?? {});

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
					name: "admins:viewer",
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
		runId: "testrun123",
		contacts: [contact()],
		...overrides,
	});

export type ChatMessage = { role: "user" | "assistant"; content: string };

let turnCounter = 0;
// Builds a turn:sendMessage handler that simulates a reply by pushing the persona history: pending, then done or failed.
export function turnHandler({
	reply,
	history = [],
	nextRunState,
}: {
	reply: string | null;
	history?: ChatMessage[];
	nextRunState?: ReturnType<typeof runState>;
}): ConvexHandler {
	return async (args, { setQuery }) => {
		const { runId, personaId, message } = args as {
			runId: string;
			personaId: string;
			message: string;
		};
		const replyId = `e2e-reply-${++turnCounter}`;
		const push = (
			messages: ChatMessage[],
			status: "pending" | "done" | "failed",
		) =>
			setQuery(
				"simulations:getPersonaHistory",
				{ runId, personaId },
				{ data: { messages, reply: { id: replyId, status } } },
			);
		const asked: ChatMessage[] = [
			...history,
			{ role: "user", content: message },
		];
		await push(asked, "pending");
		if (reply === null) {
			await push(history, "failed");
			return { replyId };
		}
		await push([...asked, { role: "assistant", content: reply }], "done");
		if (nextRunState) {
			await setQuery("simulations:get", { runId }, { data: nextRunState });
		}
		return { replyId };
	};
}

// Builds a persona entry for a mock case, defaulting to Mary.
export const personaEntry = (
	overrides: Partial<Persona> = {},
): Partial<Persona> => ({
	id: "mary",
	name: "Mary",
	role: "Chief Financial Officer",
	profilePhoto: null,
	knownFacts: "The vendor is Acme.",
	personalityTraits: "Direct.",
	availabilityMinutes: null,
	files: [],
	...overrides,
});

// Builds a referral entry with blank defaults.
export const referralEntry = (
	overrides: Partial<ReferralEdge> = {},
): ReferralEdge => ({
	fromId: "",
	toId: "",
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
