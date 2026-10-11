import {
	type FunctionArgs,
	type FunctionReference,
	type FunctionReturnType,
	getFunctionName,
} from "convex/server";
import { type Mock, vi } from "vitest";

// A shared stand-in for the `convex-svelte` module in component tests. Every function is addressed by its generated `api` reference, so a renamed or re-typed server function breaks the tests at compile time.

type QueryRef = FunctionReference<"query">;
type MutationRef = FunctionReference<"mutation">;
type ActionRef = FunctionReference<"action">;

export type QueryState<Q extends QueryRef> = {
	data?: FunctionReturnType<Q>;
	error?: Error;
	isLoading?: boolean;
};

type StoredState = { data?: unknown; error?: Error; isLoading?: boolean };

const queryKey = (name: string, args: unknown) =>
	`${name}::${args === undefined ? "*" : JSON.stringify(args)}`;

const nameOf = (ref: unknown) => getFunctionName(ref as QueryRef);

class ConvexFake {
	#states = new Map<string, StoredState>();
	#mutations = new Map<string, Mock>();
	#actions = new Map<string, Mock>();
	#clientQueries = new Map<string, Mock>();
	// Bumped on every query change so reactive reads re-run.
	#version = $state(0);

	// `setupConvex`, recorded so tests can assert the layout installs the client.
	setupConvex = vi.fn();

	// Sets what a reactive query returns. Without `args` it answers for any arguments; with `args` it answers only for those.
	setQuery<Q extends QueryRef>(
		ref: Q,
		args: FunctionArgs<Q> | undefined,
		state: QueryState<Q>,
	): void {
		this.#states.set(queryKey(nameOf(ref), args), state);
		this.#version += 1;
	}

	// Sets the result of a reactive query for any arguments.
	setQueryData<Q extends QueryRef>(ref: Q, data: FunctionReturnType<Q>): void {
		this.setQuery(ref, undefined, { data });
	}

	// The mock behind `useMutation(ref)` and `client.mutation(ref, ...)`. Resolves undefined until a test says otherwise.
	mutation<M extends MutationRef>(
		ref: M,
	): Mock<(args: FunctionArgs<M>) => Promise<FunctionReturnType<M>>> {
		return this.#mock(this.#mutations, ref) as never;
	}

	// The mock behind `useAction(ref)` and `client.action(ref, ...)`.
	action<A extends ActionRef>(
		ref: A,
	): Mock<(args: FunctionArgs<A>) => Promise<FunctionReturnType<A>>> {
		return this.#mock(this.#actions, ref) as never;
	}

	// The mock behind the one-shot `client.query(ref, ...)`.
	clientQuery<Q extends QueryRef>(
		ref: Q,
	): Mock<(args: FunctionArgs<Q>) => Promise<FunctionReturnType<Q>>> {
		return this.#mock(this.#clientQueries, ref) as never;
	}

	// Forgets every result and resets every mock, ready for the next test.
	reset(): void {
		this.#states.clear();
		// Reset in place, so a mock a test file grabbed at module level stays valid.
		for (const table of [this.#mutations, this.#actions, this.#clientQueries])
			for (const mock of table.values()) mock.mockReset();
		this.setupConvex.mockReset();
		this.#version += 1;
	}

	#mock(table: Map<string, Mock>, ref: unknown): Mock {
		const name = nameOf(ref);
		let mock = table.get(name);
		if (!mock) {
			mock = vi.fn(async () => undefined);
			table.set(name, mock);
		}
		return mock;
	}

	#read(ref: unknown, argsOrFn: unknown): StoredState | undefined {
		void this.#version;
		const args = typeof argsOrFn === "function" ? argsOrFn() : argsOrFn;
		if (args === "skip") return undefined;
		const name = nameOf(ref);
		return (
			this.#states.get(queryKey(name, args)) ??
			this.#states.get(queryKey(name, undefined))
		);
	}

	// Implements `useQuery`: the returned object reads the current state lazily, so it stays reactive.
	useQuery = (ref: unknown, argsOrFn?: unknown) => {
		const read = () => this.#read(ref, argsOrFn);
		return {
			get data() {
				return read()?.data;
			},
			get error() {
				return read()?.error;
			},
			get isLoading() {
				return read()?.isLoading ?? false;
			},
			get isStale() {
				return false;
			},
		};
	};

	useMutation = (ref: unknown) => (args: unknown) =>
		this.#mock(this.#mutations, ref)(args);

	useAction = (ref: unknown) => (args: unknown) =>
		this.#mock(this.#actions, ref)(args);

	getConvexClient = () => ({
		query: (ref: unknown, args: unknown) =>
			this.#mock(this.#clientQueries, ref)(args),
		mutation: (ref: unknown, args: unknown) =>
			this.#mock(this.#mutations, ref)(args),
		action: (ref: unknown, args: unknown) =>
			this.#mock(this.#actions, ref)(args),
	});
}

export const convexFake = new ConvexFake();

// The module shape `vi.mock("convex-svelte")` should return.
export const convexSvelteModule = {
	useQuery: convexFake.useQuery,
	useMutation: convexFake.useMutation,
	useAction: convexFake.useAction,
	getConvexClient: convexFake.getConvexClient,
	setupConvex: (...args: unknown[]) => convexFake.setupConvex(...args),
};
