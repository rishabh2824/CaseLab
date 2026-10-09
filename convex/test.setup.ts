/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { studentErrorData } from "./lib/studentErrors";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);

// Creates an in-memory Convex test instance with the app's components registered.
export function newTestConvex() {
	const t = convexTest(schema, modules);
	betterAuthTest.register(t);
	return t;
}

// Waits until a reply is no longer pending, failing if it takes too long.
export async function settleReply(
	t: ReturnType<typeof newTestConvex>,
	replyId: Id<"runMessages">,
): Promise<void> {
	await vi.waitFor(
		async () => {
			const row = await t.run((ctx) => ctx.db.get("runMessages", replyId));
			if (row?.status === "pending") throw new Error("Reply is still pending.");
		},
		{ timeout: 5000, interval: 5 },
	);
}

// Sends a student message, waits for the reply to settle and returns the reply row id.
export async function sendTurn(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
	message: string,
): Promise<Id<"runMessages">> {
	const { replyId } = await t.mutation(api.api.turn.sendMessage, {
		runId,
		personaId,
		message,
	});
	await settleReply(t, replyId);
	return replyId;
}

// Returns the state of the latest reply for a persona, or null if there is none.
export async function lastReply(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
) {
	const history = await t.query(api.api.simulations.getPersonaHistory, {
		runId,
		personaId,
	});
	return history.reply;
}

// Inserts a student message with a pending reply, without starting a reply, and returns the reply id.
export async function insertPendingReply(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
	message: string,
) {
	return await t.run(async (ctx) => {
		const userMessageId = await ctx.db.insert("runMessages", {
			runId,
			personaId: personaId,
			role: "user",
			content: message,
			status: "done",
		});
		return await ctx.db.insert("runMessages", {
			runId,
			personaId: personaId,
			role: "assistant",
			content: "",
			status: "pending",
			userMessageId,
		});
	});
}

// Creates a Better Auth user and session for an email and returns a test client acting as them.
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

// Creates an admins row and a signed-in test client for it.
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

// Returns a signed-in test client whose email is not on the admin roster.
export async function withStranger(
	t: ReturnType<typeof newTestConvex>,
	email = `stranger-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
) {
	return withGoogleIdentity(t, email);
}

// Formats a text chunk as a streamed completion SSE data line.
export function sseDelta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

// Formats text chunks as a full SSE stream ending with [DONE].
export function sseStream(chunks: string[]): string {
	return `${chunks.map(sseDelta).join("")}data: [DONE]\n\n`;
}

export type LlmStub = {
	replyChunks?: string[];
	replyText?: string;
	introduce?: string[];
	sendFiles?: string[];
	replyBody?: string;
	replyStatus?: number;
	replyThrows?: Error;
	harassment?: string;
	classifierThrows?: Error;
	classifierBody?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: captured request bodies differ in shape (classify vs. reply) and tests read them freely by property
export type LlmCall = { kind: "classify" | "reply"; body: any };

// Builds a stub fetch that records LLM calls and returns configurable classifier and reply responses.
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
		if (Array.isArray(body.messages[0].content)) {
			body.messages[0].content = body.messages[0].content
				.map((block: { text: string }) => block.text)
				.join("\n\n");
		}
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
			JSON.stringify({ reply: replyText, introduce, sendFiles: sendFiles }),
		];
		return new Response(sseStream(chunks), { status: 200 });
	}

	return { calls, fetch: stubbedFetch };
}

// Awaits a promise and returns the student error it rejects with, or 'resolved' if it succeeds.
export async function studentRejection(
	promise: Promise<unknown>,
): Promise<ReturnType<typeof studentErrorData> | "resolved"> {
	try {
		await promise;
	} catch (err) {
		return studentErrorData(err);
	}
	return "resolved";
}
