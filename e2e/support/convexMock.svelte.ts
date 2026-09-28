import { getFunctionName } from "convex/server";
import { getContext, setContext } from "svelte";
import type { StudentErrorCode } from "../../convex/lib/studentErrors.js";
import { clientStudentError } from "../../tests/support/convexClientErrors.js";

const CLIENT_CONTEXT_KEY = "$$_convexClient";
export const _authContextKey = "$$_convexAuth";
const AUTH_CONTEXT_KEY = _authContextKey;

type MockError = string | { code: StudentErrorCode; message: string };
type QueryEntry = { data: unknown } | { error: MockError };

type StudentErrorEnvelope = {
	__e2eStudentError: { code: StudentErrorCode; message: string };
};

declare global {
	interface Window {
		__e2eConvexSeed?: Array<{
			name: string;
			args: unknown;
			data?: unknown;
			error?: MockError;
		}>;
		__e2eConvex?: {
			setQuery: (name: string, args: unknown, entry: QueryEntry) => void;
		};
		__e2eConvexCall?: (
			kind: "mutation" | "action",
			name: string,
			args: unknown,
		) => Promise<unknown>;
	}
}

const store = new Map<string, QueryEntry>();
let version = $state(0);

// Builds the store key for a query name and its arguments.
function keyFor(name: string, args: unknown): string {
	return `${name}::${JSON.stringify(args ?? {})}`;
}

// Stores a query result and notifies subscribers.
function setQuery(name: string, args: unknown, entry: QueryEntry): void {
	store.set(keyFor(name, args), entry);
	version += 1;
}

if (typeof window !== "undefined") {
	window.__e2eConvex = { setQuery };
	for (const entry of window.__e2eConvexSeed ?? []) {
		setQuery(
			entry.name,
			entry.args,
			"error" in entry && entry.error !== undefined
				? { error: entry.error }
				: { data: entry.data },
		);
	}
}

// Builds the error a query or mutation should reject with from a mock error.
function buildError(name: string, error: MockError): Error {
	return typeof error === "string"
		? new Error(error)
		: clientStudentError(name, error.code, error.message, "Q");
}

// Returns the error for a query entry, if it has one.
function toError(
	name: string,
	entry: QueryEntry | undefined,
): Error | undefined {
	return entry && "error" in entry ? buildError(name, entry.error) : undefined;
}

// Returns the data for a query entry, if it has any.
function toData(entry: QueryEntry | undefined): unknown {
	return entry && "data" in entry ? entry.data : undefined;
}

const revealed = new Set<string>();
const revealPending = new Set<string>();

// Reveals a stored query result after a tick, so it first appears as loading.
function ensureRevealed(key: string): boolean {
	if (revealed.has(key)) return true;
	if (!store.has(key)) return false;
	if (!revealPending.has(key)) {
		revealPending.add(key);
		setTimeout(() => {
			revealPending.delete(key);
			revealed.add(key);
			version += 1;
		}, 0);
	}
	return false;
}

// Mock of convex-svelte's useQuery that reads results from the in-memory store.
export function useQuery(query: unknown, argsOrFn: unknown = {}) {
	const name = getFunctionName(query as Parameters<typeof getFunctionName>[0]);
	const resolveArgs = () =>
		typeof argsOrFn === "function" ? argsOrFn() : argsOrFn;
	return {
		get data() {
			const args = resolveArgs();
			if (args === "skip") return undefined;
			void version;
			const key = keyFor(name, args);
			if (!ensureRevealed(key)) return undefined;
			return toData(store.get(key));
		},
		get error() {
			const args = resolveArgs();
			if (args === "skip") return undefined;
			void version;
			const key = keyFor(name, args);
			if (!ensureRevealed(key)) return undefined;
			return toError(name, store.get(key));
		},
		get isLoading() {
			const args = resolveArgs();
			if (args === "skip") return false;
			void version;
			return !ensureRevealed(keyFor(name, args));
		},
		get isStale() {
			return false;
		},
	};
}

// Forwards a mutation or action to the Playwright-side handler and rethrows any student error it reports.
async function callBridge(
	kind: "mutation" | "action",
	query: unknown,
	args: unknown,
): Promise<unknown> {
	const name = getFunctionName(query as Parameters<typeof getFunctionName>[0]);
	if (!window.__e2eConvexCall) {
		throw new Error(
			`E2E: no Convex bridge registered (missing mockApi(page, ...) call) for ${kind} ${name}`,
		);
	}
	const result = await window.__e2eConvexCall(kind, name, args);
	const failure = (result as StudentErrorEnvelope | undefined)
		?.__e2eStudentError;
	if (failure) {
		throw clientStudentError(
			name,
			failure.code,
			failure.message,
			kind === "mutation" ? "M" : "A",
		);
	}
	return result;
}

let clientSingleton: ReturnType<typeof makeClient> | null = null;

// Builds the mock Convex client.
function makeClient() {
	return {
		query: (query: unknown, args: unknown = {}) => {
			const name = getFunctionName(
				query as Parameters<typeof getFunctionName>[0],
			);
			const entry = store.get(keyFor(name, args));
			if (!entry) {
				return Promise.reject(
					new Error(`E2E: no mock registered for query ${name}`),
				);
			}
			if ("error" in entry)
				return Promise.reject(buildError(name, entry.error));
			return Promise.resolve(entry.data);
		},
		mutation: (query: unknown, args: unknown = {}) =>
			callBridge("mutation", query, args),
		action: (query: unknown, args: unknown = {}) =>
			callBridge("action", query, args),
		setAuth: (_fetchToken?: unknown, onChange?: (ok: boolean) => void) => {
			onChange?.(false);
		},
		close: async () => {},
	};
}

// Returns the shared mock Convex client.
export function getConvexClient() {
	if (!clientSingleton) clientSingleton = makeClient();
	return clientSingleton;
}

// Mock of convex-svelte's useConvexClient.
export function useConvexClient() {
	return (
		(getContext(CLIENT_CONTEXT_KEY) as ReturnType<typeof getConvexClient>) ??
		getConvexClient()
	);
}

// Puts the mock client into Svelte context.
export function setConvexClientContext(
	client: ReturnType<typeof getConvexClient>,
) {
	return setContext(CLIENT_CONTEXT_KEY, client);
}

// Mock of convex-svelte's setupConvex that installs the mock client.
export function setupConvex(_url?: string, _options?: unknown) {
	const client = getConvexClient();
	setConvexClientContext(client);
	return client;
}

// Mock of convex-svelte's useMutation.
export function useMutation(mutation: unknown) {
	return (args: unknown) => getConvexClient().mutation(mutation, args);
}

// Mock of convex-svelte's useAction.
export function useAction(action: unknown) {
	return (args: unknown) => getConvexClient().action(action, args);
}

// Returns whether the test session marks an admin as signed in.
function isE2EAdminSignedIn(): boolean {
	if (typeof sessionStorage === "undefined") return false;
	try {
		const raw = sessionStorage.getItem("caseLabSession");
		if (!raw) return false;
		const parsed = JSON.parse(raw) as { adminRole?: unknown };
		return parsed.adminRole === "super" || parsed.adminRole === "admin";
	} catch {
		return false;
	}
}

// Mock auth setup that puts a signed-in or signed-out state into context.
export function setupAuth(_authProvider?: unknown, _options?: unknown) {
	setContext(AUTH_CONTEXT_KEY, {
		isLoading: false,
		isAuthenticated: isE2EAdminSignedIn(),
	});
}

// Mock of the auth hook, reflecting whether an admin is signed in.
export function useAuth() {
	return (
		(getContext(AUTH_CONTEXT_KEY) as
			| { isLoading: boolean; isAuthenticated: boolean }
			| undefined) ?? {
			isLoading: false,
			isAuthenticated: isE2EAdminSignedIn(),
		}
	);
}
