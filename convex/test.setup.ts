/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import rateLimiter from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { components } from "./_generated/api";
import schema from "./schema";

// Called from every *.test.ts file to get a fresh in-memory backend. Lives at the convex/
// root (not in a test-only subfolder) so `import.meta.glob` below sees every real module --
// convex-test needs the full module map to resolve `internal.*`/`api.*` references made by
// actions and scheduled functions.
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);

export function newTestConvex() {
	const t = convexTest(schema, modules);
	// lib/rateLimits.ts calls into the rateLimiter component (registered in convex.config.ts)
	// on every startSimulation/startTurn call -- convex-test has no way to discover a
	// component's own schema/functions on its own, so the component's own test helper
	// registers them the same way a real deployment's build step would.
	rateLimiter.register(t);
	// requireCurrentAdmin/viewer (services/admins.ts) resolve the signed-in identity via
	// authComponent.safeGetAuthUser, which looks up real rows in the betterAuth component's
	// own session/user tables -- same registration story as rateLimiter above.
	betterAuthTest.register(t);
	return t;
}

// Seeds betterAuth `user` and `session` rows directly via the component's generic adapter
// mutation, bypassing Better Auth's own request-handling layer (and so auth.ts's
// databaseHooks.user.create.before) entirely -- this is test setup standing in for "Google
// sign-in already happened", not an exercise of the sign-in gate itself. Both rows are
// required: authComponent.safeGetAuthUser resolves the caller in two steps, session by
// `identity.sessionId` (and not expired) THEN user by `identity.subject` -- a mocked
// identity missing either leaves that lookup with nothing to find. Returns a `t` handle
// whose identity matches both rows, the way a real signed-in request would. Whether the
// email also has an `admins` row (and so is actually authorized) is entirely up to the
// caller -- this only seeds the identity side.
export async function withGoogleIdentity(
	t: ReturnType<typeof newTestConvex>,
	email: string,
) {
	const now = Date.now();
	const user = await t.run((ctx) =>
		ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: "user",
				data: {
					name: email,
					email,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			},
		}),
	);
	const session = await t.run((ctx) =>
		ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: "session",
				data: {
					token: `test-session-${Math.random().toString(36).slice(2)}`,
					userId: user._id,
					createdAt: now,
					updatedAt: now,
					expiresAt: now + 60 * 60 * 1000,
				},
			},
		}),
	);
	return t.withIdentity({ subject: user._id, sessionId: session._id });
}

// A signed-in admin's `t` handle plus the ids convex-test needs to look them up again.
export async function withAdmin(
	t: ReturnType<typeof newTestConvex>,
	overrides: { email?: string; name?: string; role?: "super" | "admin" } = {},
) {
	const email =
		overrides.email ??
		`admin-${Math.random().toString(36).slice(2)}@test.caselab.invalid`;
	const adminId = await t.run(async (ctx) =>
		ctx.db.insert("admins", {
			email,
			name: overrides.name,
			role: overrides.role ?? "admin",
		}),
	);
	const asUser = await withGoogleIdentity(t, email);
	return {
		adminId,
		email,
		asUser,
	};
}

// A signed-in Google identity with no matching `admins` row -- the "authenticated but not
// authorized" case exercised by requireCurrentAdmin/viewer's rejection paths.
export async function withStranger(
	t: ReturnType<typeof newTestConvex>,
	email = `stranger-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
) {
	return withGoogleIdentity(t, email);
}

// ---------------------------------------------------------------------------
// OpenRouter stubbing
// ---------------------------------------------------------------------------

// A single SSE frame carrying one text delta, as OpenRouter emits them.
export function sseDelta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

// A complete SSE body for one reply, chunked at arbitrary boundaries so a test can prove the
// consumer doesn't depend on frame alignment.
export function sseStream(chunks: string[]): string {
	return `${chunks.map(sseDelta).join("")}data: [DONE]\n\n`;
}

export type LlmStub = {
	// The whole raw text the reply model "generates", chunked as given. Defaults to a
	// well-formed persona-reply envelope built from replyText/introduce/sendFiles.
	replyChunks?: string[];
	replyText?: string;
	introduce?: string[];
	sendFiles?: string[];
	// Raw SSE body, bypassing replyChunks entirely -- for malformed/partial/erroring streams.
	replyBody?: string;
	// Fail the reply request itself rather than its body.
	replyStatus?: number;
	replyThrows?: Error;
	// Classifier outcome. A thrown error exercises classifyHarassment's fail-open path.
	harassment?: string;
	classifierThrows?: Error;
	classifierBody?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: captured request bodies differ in shape (classify vs. reply) and tests read them freely by property
export type LlmCall = { kind: "classify" | "reply"; body: any };

// One fetch implementation standing in for every OpenRouter call a turn makes -- the Haiku
// harassment classifier and the Sonnet reply stream, dispatched by `body.stream` since both hit
// the same endpoint. Returns the function rather than installing it (callers do their own
// `vi.stubGlobal("fetch", ...)`) so this module stays free of a vitest import, same as the rest
// of convex/. Shared here rather than re-hand-rolled per suite: several suites feed the reply
// path deliberately malformed SSE, and that framing is exactly the detail worth having in one
// place.
export function makeLlmFetch(options: LlmStub = {}): {
	calls: LlmCall[];
	fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
	const {
		replyText = "OK",
		introduce = [],
		sendFiles = [],
		harassment = "NORMAL",
	} = options;
	const calls: LlmCall[] = [];

	async function stubbedFetch(
		_url: string,
		init: RequestInit,
	): Promise<Response> {
		const body = JSON.parse(init.body as string);
		const kind: "classify" | "reply" = body.stream ? "reply" : "classify";
		calls.push({ kind, body });

		if (kind === "classify") {
			if (options.classifierThrows) throw options.classifierThrows;
			if (options.classifierBody !== undefined) {
				return new Response(options.classifierBody, { status: 200 });
			}
			return new Response(
				JSON.stringify({ choices: [{ message: { content: harassment } }] }),
				{ status: 200 },
			);
		}

		if (options.replyThrows) throw options.replyThrows;
		if (options.replyStatus && options.replyStatus !== 200) {
			return new Response("upstream failure", { status: options.replyStatus });
		}
		if (options.replyBody !== undefined) {
			return new Response(options.replyBody, { status: 200 });
		}
		const chunks = options.replyChunks ?? [
			JSON.stringify({ reply: replyText, introduce, send_files: sendFiles }),
		];
		return new Response(sseStream(chunks), { status: 200 });
	}

	return { calls, fetch: stubbedFetch };
}
