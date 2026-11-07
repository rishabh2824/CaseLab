/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { vi } from "vitest";
import {
	caseStructure,
	personaPayload,
	uniqueAccessCode,
} from "../tests/support/factories";
import { api, components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { CasePayload } from "./model/cases";
import schema from "./schema";
import { appErrorData } from "./shared/errors";
import type { CaseStructure } from "./shared/validators";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);

// Creates an in-memory Convex test instance with the app's components registered.
export function newTestConvex() {
	const t = convexTest(schema, modules);
	betterAuthTest.register(t);
	return t;
}

// Waits until a turn is no longer pending, failing if it takes too long.
export async function settleReply(
	t: ReturnType<typeof newTestConvex>,
	turnId: Id<"turns">,
): Promise<void> {
	await vi.waitFor(
		async () => {
			const row = await t.run((ctx) => ctx.db.get("turns", turnId));
			if (row?.status === "pending") throw new Error("Reply is still pending.");
		},
		{ timeout: 5000, interval: 5 },
	);
}

// Sends a student message, waits for the reply to settle and returns the turn id.
export async function sendTurn(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
	message: string,
): Promise<Id<"turns">> {
	const { turnId } = await t.mutation(api.turns.sendMessage, {
		runId,
		personaId,
		message,
	});
	await settleReply(t, turnId);
	return turnId;
}

// Returns a persona's visible chat messages for a run.
export async function visibleMessages(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
) {
	return (await t.query(api.runs.getPersonaHistory, { runId, personaId }))
		.messages;
}

// Returns the state of the latest reply for a persona, or null if there is none.
export async function lastReply(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
) {
	const history = await t.query(api.runs.getPersonaHistory, {
		runId,
		personaId,
	});
	return history.reply;
}

// Inserts a pending turn for a student message, without starting a reply, and returns the turn id.
export async function insertPendingReply(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
	message: string,
) {
	return await t.run((ctx) =>
		ctx.db.insert("turns", {
			runId,
			personaId,
			studentMessage: message,
			reply: "",
			status: "pending",
		}),
	);
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
			name: overrides.name ?? "Test Admin",
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

// Inserts an admins row with the given role, without a sign-in identity, and returns the document.
export async function makeAdmin(
	t: ReturnType<typeof newTestConvex>,
	role: "super" | "admin" = "admin",
): Promise<Doc<"admins">> {
	const id = await t.run((ctx) =>
		ctx.db.insert("admins", {
			name: "Test Admin",
			email: `${role}-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
			role,
		}),
	);
	return (await t.run((ctx) => ctx.db.get("admins", id)))!;
}

// Builds a valid case create/update payload with a unique access code and optional overrides.
export function casePayload(
	overrides: Partial<Omit<CasePayload, "structure">> &
		Partial<CaseStructure> = {},
): CasePayload {
	const {
		personas = [personaPayload("A")],
		referrals = [],
		...rest
	} = overrides;
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		commonInformation: "",
		accessCode: uniqueAccessCode(),
		collaborators: [],
		...rest,
		structure: { personas, referrals },
	};
}

// Seeds a case owned by a fresh admin with the given structure and access code, and starts a run on it.
export async function startRun(
	t: ReturnType<typeof newTestConvex>,
	structure: CaseStructure = caseStructure(),
	accessCode = "sterling",
) {
	const ownerAdminId = (await makeAdmin(t))._id;
	await t.run((ctx) =>
		ctx.db.insert("cases", {
			commonInformation: "",
			isTemplate: false,
			name: "Case",
			brief: "Brief",
			accessCode,
			ownerAdminId,
			structure,
		}),
	);
	return await t.mutation(api.runs.start, { accessCode });
}

// Returns a signed-in test client whose email is not on the admin roster.
export async function withStranger(
	t: ReturnType<typeof newTestConvex>,
	email = `stranger-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
) {
	return withGoogleIdentity(t, email);
}

export type LlmStub = {
	// The raw JSON text the model returns, instead of one built from replyText, introduce, sendFiles and flag.
	replyContent?: string;
	replyText?: string;
	introduce?: string[];
	sendFiles?: string[];
	flag?: "none" | "abuse" | "gibberish";
	replyBody?: string;
	replyStatus?: number;
	replyThrows?: Error;
};

// biome-ignore lint/suspicious/noExplicitAny: tests read captured request bodies freely by property
export type LlmCall = { body: any };

// Builds a stub fetch that records LLM calls and returns a configurable reply.
export function makeLlmFetch(options: LlmStub = {}): {
	calls: LlmCall[];
	fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
	const {
		replyText = "OK",
		introduce = [],
		sendFiles = [],
		flag = "none",
	} = options;
	const calls: LlmCall[] = [];

	async function stubbedFetch(
		_url: string,
		init: RequestInit,
	): Promise<Response> {
		const body = JSON.parse(init.body as string);
		if (Array.isArray(body.messages[0].content)) {
			body.messages[0].content = body.messages[0].content
				.map((block: { text: string }) => block.text)
				.join("\n\n");
		}
		calls.push({ body });

		if (options.replyThrows) throw options.replyThrows;
		if (options.replyStatus && options.replyStatus !== 200) {
			return new Response("upstream failure", { status: options.replyStatus });
		}
		if (options.replyBody !== undefined) {
			return new Response(options.replyBody, { status: 200 });
		}
		const content =
			options.replyContent ??
			JSON.stringify({ reply: replyText, introduce, sendFiles, flag });
		return new Response(
			JSON.stringify({ choices: [{ message: { content } }] }),
			{ status: 200 },
		);
	}

	return { calls, fetch: stubbedFetch };
}

// Awaits a promise and returns the student error it rejects with, or 'resolved' if it succeeds.
export async function studentRejection(
	promise: Promise<unknown>,
): Promise<ReturnType<typeof appErrorData> | "resolved"> {
	try {
		await promise;
	} catch (err) {
		return appErrorData(err);
	}
	return "resolved";
}

// Stubs the global fetch with the fake LLM and returns its recorded calls.
export function stubLlm(options: LlmStub = {}) {
	const { calls, fetch } = makeLlmFetch(options);
	const fetchMock = vi.fn(fetch);
	vi.stubGlobal("fetch", fetchMock);
	return { calls, fetchMock };
}
