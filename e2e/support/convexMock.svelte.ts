// Browser-side stand-in for `convex-svelte`, swapped in only for the E2E build (see
// vite.config.ts's E2E-gated alias) instead of a real WebSocket connection to a Convex
// deployment. Mirrors the mocking pattern already proven in
// tests/student/run.svelte.test.ts's `vi.mock("convex-svelte", ...)` -- a reactive
// (functionName, args)-keyed store standing in for the real client's query cache -- except
// here the store is driven from the Node-side Playwright test via `window.__e2eConvex`
// (see e2e/mockApi.ts) instead of a vitest mock function, since E2E runs a real bundled
// build in a real browser with no module-mocking mechanism available.
//
// `@mmailaender/convex-better-auth-svelte` (used by admin/+layout.svelte) itself calls
// `setupConvex`/`setupAuth` (below) and reads the client/auth context back via Svelte context
// at the hardcoded keys "$$_convexClient"/"$$_convexAuth" -- the exact strings convex-svelte's
// own internals use -- so aliasing just this one package is enough to intercept it too,
// without needing a separate mock for the Better Auth adapter itself. Real Google OAuth never
// runs in E2E; `setupAuth` below reports authenticated purely off the sessionStorage key
// mockApi.ts's signInAsAdmin seeds, and the client's own `.setAuth()` is a no-op on top of
// that (see its own comment further down).
import { getFunctionName } from "convex/server";
import { getContext, setContext } from "svelte";

const CLIENT_CONTEXT_KEY = "$$_convexClient";
// Same string convex-svelte itself exports as `_authContextKey` -- @mmailaender/convex-
// better-auth-svelte imports that binding directly (not just its value) from 'convex-svelte',
// so the alias needs the same export name available too, not just a same-valued rename.
export const _authContextKey = "$$_convexAuth";
const AUTH_CONTEXT_KEY = _authContextKey;

type QueryEntry = { data: unknown } | { error: string };

declare global {
	interface Window {
		__e2eConvexSeed?: Array<{
			name: string;
			args: unknown;
			data?: unknown;
			error?: string;
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
// Bumped on every write so `useQuery`'s $derived reads below re-evaluate -- a plain Map
// mutation alone is invisible to Svelte, same reason run.svelte.test.ts's fake needs its
// own version counter.
let version = $state(0);

function keyFor(name: string, args: unknown): string {
	return `${name}::${JSON.stringify(args ?? {})}`;
}

function setQuery(name: string, args: unknown, entry: QueryEntry): void {
	store.set(keyFor(name, args), entry);
	version += 1;
}

// Seeded once at module load (before the app's own top-level code runs, since
// page.addInitScript's script executes ahead of every other page script -- see
// mockApi.ts) so a test's initial query data survives a `page.reload()` without needing
// to be re-pushed by hand.
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

function toError(entry: QueryEntry | undefined): Error | undefined {
	return entry && "error" in entry ? new Error(entry.error) : undefined;
}

function toData(entry: QueryEntry | undefined): unknown {
	return entry && "data" in entry ? entry.data : undefined;
}

// Keys whose data useQuery is currently allowed to reveal, and keys with a reveal already
// scheduled -- see ensureRevealed's own comment for why revelation is deferred at all.
const revealed = new Set<string>();
const revealPending = new Set<string>();

// A real Convex subscription is never resolved before the component reading it has
// finished mounting (and run its onMount callbacks) -- a genuine network round trip is
// never that fast. Resolving a seeded/pushed value on `useQuery`'s very first synchronous
// read let run.svelte.ts's error-detection $effect react to an "expired run" seed before
// that page's own onMount (which sets a once-only #initialized guard) had run, double-
// firing startSession -- a race that can never happen against a live deployment, only
// against a mock resolving instantly. Deferring each (name, args) key's first reveal by
// one macrotask, counted from whenever `useQuery` FIRST reads it (not from page load, so
// a query only reached after some later navigation is deferred relative to ITS OWN first
// read too) reproduces that same always-at-least-one-tick latency generically. Only
// affects `useQuery` -- the one-shot client `.query()` below reads `store` directly, since
// callers there already `await` it and aren't racing a synchronous mount-time guard.
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

// Matches convex-svelte's real useQuery signature closely enough for every call site in
// this app: a FunctionReference plus either an args object or a closure returning one
// (possibly the literal "skip" string, same skip-sentinel convention the real client uses
// for a not-ready-yet query -- see run.svelte.ts's `session.runId ? {...} : "skip"`).
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
			return toError(store.get(key));
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
	return await window.__e2eConvexCall(kind, name, args);
}

let clientSingleton: ReturnType<typeof makeClient> | null = null;

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
			if ("error" in entry) return Promise.reject(new Error(entry.error));
			return Promise.resolve(entry.data);
		},
		mutation: (query: unknown, args: unknown = {}) =>
			callBridge("mutation", query, args),
		action: (query: unknown, args: unknown = {}) =>
			callBridge("action", query, args),
		// Real setAuth wires a token-fetcher into the client's WebSocket auth handshake --
		// a no-op here since E2E fakes admin sign-in via sessionStorage, never real auth.
		setAuth: (_fetchToken?: unknown, onChange?: (ok: boolean) => void) => {
			onChange?.(false);
		},
		close: async () => {},
	};
}

export function getConvexClient() {
	if (!clientSingleton) clientSingleton = makeClient();
	return clientSingleton;
}

export function useConvexClient() {
	return (
		(getContext(CLIENT_CONTEXT_KEY) as ReturnType<typeof getConvexClient>) ??
		getConvexClient()
	);
}

export function setConvexClientContext(
	client: ReturnType<typeof getConvexClient>,
) {
	return setContext(CLIENT_CONTEXT_KEY, client);
}

// Real signature takes a deployment URL; ignored here since every call already resolves to
// the same mock singleton regardless of "which deployment" it names.
export function setupConvex(_url?: string, _options?: unknown) {
	const client = getConvexClient();
	setConvexClientContext(client);
	return client;
}

export function useMutation(mutation: unknown) {
	return (args: unknown) => getConvexClient().mutation(mutation, args);
}

export function useAction(action: unknown) {
	return (args: unknown) => getConvexClient().action(action, args);
}

// Real setupAuth reactively bridges an auth provider's isLoading/isAuthenticated into
// Convex's own backend-confirmed state. E2E never signs in through Google -- admin tests fake
// sign-in by seeding sessionStorage directly (see mockApi.ts's signInAsAdmin) -- so this reads
// that same key rather than driving any real auth provider. Read once at call time (mount),
// not reactively: the seed is written by page.addInitScript before the app's own top-level
// code runs (see this file's header comment), so it's already settled by the time
// admin/+layout.svelte calls createSvelteAuthClient -> setupAuth, and sign-in/sign-out never
// happen mid-test.
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

export function setupAuth(_authProvider?: unknown, _options?: unknown) {
	setContext(AUTH_CONTEXT_KEY, {
		isLoading: false,
		isAuthenticated: isE2EAdminSignedIn(),
	});
}

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
