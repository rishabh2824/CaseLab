import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { RECENT_HISTORY_LIMIT } from "../lib/llm";
import { NONSENSE_THRESHOLD } from "../lib/turnState";
import { newTestConvex } from "../test.setup";
import {
	caseStructure,
	fileEntry,
	personaPayload,
	referralEdge,
} from "../testFactories";
import {
	getPersonaHistory,
	getSimulationState,
	startSimulation,
} from "./simulations";
import { applyDecisions, getStreamingPreview, startTurn } from "./turn";

type LlmStubOptions = {
	harassment?: string | ((message: string, conversation: string) => string);
	replyText?: string;
	introduce?: string[];
	sendFiles?: string[];
};

function jsonResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
	});
}

function sseResponse(envelope: string): Response {
	return new Response(
		`data: ${JSON.stringify({ choices: [{ delta: { content: envelope } }] })}\n\ndata: [DONE]\n\n`,
		{
			status: 200,
		},
	);
}

function resolveMaybeFn<T>(
	value: T | ((message: string, conversation: string) => T),
	message: string,
	conversation: string,
): T {
	return typeof value === "function"
		? (value as (m: string, h: string) => T)(message, conversation)
		: value;
}

// One fetch mock standing in for every LLM call a turn makes: the harassment classifier (the
// only classifier left -- see lib/llm.ts) and the persona reply stream, which now also judges
// referral/file eligibility itself (see lib/prompt.ts's systemPrompt) rather than a separate
// classifier pre-filtering an "eligible" list. Dispatched by inspecting the request body since
// both hit the same endpoint.
function stubLlm(options: LlmStubOptions = {}) {
	const {
		harassment = "normal",
		replyText = "OK",
		introduce = [],
		sendFiles = [],
	} = options;
	// biome-ignore lint/suspicious/noExplicitAny: mock request bodies vary in shape (classify vs. reply) and are freely accessed by property throughout this file
	const calls: { kind: string; body: any }[] = [];
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		calls.push({ kind: body.stream ? "reply" : "classify", body });
		if (body.stream) {
			const envelope = JSON.stringify({
				reply: replyText,
				introduce,
				send_files: sendFiles,
			});
			return sseResponse(envelope);
		}
		const systemContent: string = body.messages[0].content;
		const userContent: string = body.messages[1].content;
		if (systemContent.includes("conversation safety classifier")) {
			const label = resolveMaybeFn(harassment, "", userContent);
			return jsonResponse(label.toUpperCase());
		}
		throw new Error(`Unexpected LLM call: ${systemContent.slice(0, 80)}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, calls };
}

beforeEach(() => {
	vi.stubEnv("LLM_KEY", "test-key");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function startRun(
	t: ReturnType<typeof newTestConvex>,
	structure: unknown,
	accessCode = "sterling",
) {
	const ownerAdminId = await t.run((ctx) =>
		ctx.db.insert("admins", {
			email: `o-${Math.random()}@test.caselab.invalid`,
			role: "admin",
		}),
	);
	await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: "Case",
			brief: "Brief",
			accessCode,
			ownerAdminId,
			structure,
		}),
	);
	return await t.run((ctx) => startSimulation(ctx, accessCode));
}

async function send(
	t: ReturnType<typeof newTestConvex>,
	runId: Id<"runs">,
	personaId: string,
	message: string,
) {
	await t.run((ctx) => startTurn(ctx, runId, personaId, message));
	await t.finishAllScheduledFunctions(() => {});
}

describe("startTurn validation", () => {
	it("rejects an empty/whitespace message", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", "   ")),
		).rejects.toThrow();
	});

	it("rejects a message over the word limit", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		const tooLong = Array(51).fill("word").join(" ");
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", tooLong)),
		).rejects.toThrow(/too long/);
	});

	it("rejects an unknown persona id", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "does-not-exist", "hi")),
		).rejects.toThrow("Persona not found.");
	});

	it("rejects a persona that exists in the graph but hasn't been unlocked yet", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			referrals: [referralEdge("A", "B", "the user asks for B")],
			roots: ["A"],
		});
		const state = await startRun(t, structure);
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "B", "hi")),
		).rejects.toThrow("Persona is not available yet.");
	});

	it("rejects a message once the simulation's duration has elapsed", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure(), "timed");
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		// Force a case duration (the seeded case has none) and move the run's start far enough
		// back that elapsed >= duration.
		await t.run((ctx) => ctx.db.patch(run.caseId, { duration: 10 }));
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { startTime: run.startTime - 15 * 60_000 }),
		);
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", "hi")),
		).rejects.toThrow("This simulation has ended.");
	});

	it("rejects a message once the persona's own availability window has expired", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [personaPayload("A", { availability_minutes: 5 })],
		});
		const state = await startRun(t, structure);
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { startTime: Date.now() - 10 * 60_000 }),
		);
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", "hi")),
		).rejects.toThrow("Persona is not available yet.");
	});
});

describe("concurrency guard (claimStreamingSlot)", () => {
	it("rejects a second turn on the same persona while one is already in flight", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await t.run((ctx) => startTurn(ctx, state.run_id, "A", "first message"));
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", "second message")),
		).rejects.toThrow(
			"A reply is already being generated for this contact. Please wait.",
		);
	});
});

describe("normal turn happy path", () => {
	it("persists the reply and clears the streaming preview", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		stubLlm({ replyText: "Our vendor is Acme." });

		await send(t, state.run_id, "A", "What vendor do we use?");

		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(history.map((m) => m.content)).toEqual([
			"What vendor do we use?",
			"Our vendor is Acme.",
		]);
	});

	it("strips a leading speaker tag before storing the reply", async () => {
		const t = newTestConvex();
		const state = await startRun(
			t,
			caseStructure({ personas: [personaPayload("A", { name: "Mary" })] }),
		);
		stubLlm({ replyText: "[Mary, CFO] Our budget is tight." });

		await send(t, state.run_id, "A", "How is the budget?");

		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(history[1]!.content).toBe("Our budget is tight.");
	});

	it("bounds what reaches the LLM to RECENT_HISTORY_LIMIT but persists the full history", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		// 6 prior turns + this one puts 13 messages in the DB, 3 more than RECENT_HISTORY_LIMIT
		// (10) -- enough to force truncation and make the "sent 1+LIMIT, drops the oldest"
		// assertion below meaningful regardless of the limit's exact value.
		for (let i = 1; i <= 6; i++) {
			stubLlm({ replyText: `reply-${i}` });
			await send(t, state.run_id, "A", `turn-${i}`);
		}
		const { calls } = stubLlm({ replyText: "reply-7" });
		await send(t, state.run_id, "A", "turn-7");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		const sentMessages = replyCall.body.messages;
		expect(sentMessages).toHaveLength(1 + RECENT_HISTORY_LIMIT);
		expect(sentMessages[1]).toEqual({ role: "assistant", content: "reply-2" });
		expect(sentMessages[sentMessages.length - 1]).toEqual({
			role: "user",
			content: "turn-7",
		});

		const fullHistory = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(fullHistory).toHaveLength(14);
	});

	it("marks the stream errored and appends no assistant turn when the reply is empty", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		stubLlm({ replyText: "" });

		await send(t, state.run_id, "A", "hi");

		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(history.map((m) => m.role)).toEqual(["user"]);
	});

	it("preserves the user's message and marks the stream errored when the LLM call fails", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("upstream blew up")),
		);

		await send(t, state.run_id, "A", "hi");

		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(history.map((m) => m.role)).toEqual(["user"]);
		expect(history[0]!.content).toBe("hi");
	});
});

describe("harassment/boundary escalation", () => {
	function twoRoots() {
		return caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			roots: ["A", "B"],
		});
	}

	it("still issues the reply call concurrently even when the message ends up flagged", async () => {
		const t = newTestConvex();
		const state = await startRun(t, twoRoots());
		const { calls } = stubLlm({ harassment: "nonsense" });

		await send(t, state.run_id, "A", "bad message");

		// The Sonnet reply call fires alongside the harassment check rather than waiting on it
		// (see runTurn's comment on `cleared`) -- it's the OUTPUT that's discarded, not the call.
		expect(calls.some((c) => c.kind === "reply")).toBe(true);
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.personaChatState.A).toMatchObject({
			warningCount: 1,
			ended: false,
		});
	});

	it("never reveals the discarded reply to the client and never persists it", async () => {
		const t = newTestConvex();
		const state = await startRun(t, twoRoots());
		stubLlm({
			harassment: "nonsense",
			replyText: "this in-character reply must never be shown",
		});

		await send(t, state.run_id, "A", "bad message");

		// Nothing was ever written to the live preview a client subscribes to mid-stream.
		const preview = await t.run((ctx) =>
			getStreamingPreview(ctx, state.run_id, "A"),
		);
		expect(preview).toEqual({ text: "", status: "done" });

		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		const assistantReply = history.find((m) => m.role === "assistant")!;
		expect(assistantReply.content).not.toContain(
			"this in-character reply must never be shown",
		);
		expect(assistantReply.content).toContain("not able to follow that");
	});

	it("ends the chat once NONSENSE_THRESHOLD is reached", async () => {
		const t = newTestConvex();
		const state = await startRun(t, twoRoots());
		stubLlm({ harassment: "nonsense" });

		for (let i = 0; i < NONSENSE_THRESHOLD; i++)
			await send(t, state.run_id, "A", "bad message");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.personaChatState.A).toMatchObject({
			warningCount: NONSENSE_THRESHOLD,
			ended: true,
			endReason: "nonsense",
		});
		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(history[history.length - 1]?.content).toContain(
			"ending this conversation",
		);
	});

	it("rejects a message to an already-ended chat, even a clean one", async () => {
		const t = newTestConvex();
		const state = await startRun(t, twoRoots());
		stubLlm({ harassment: "nonsense" });
		for (let i = 0; i < NONSENSE_THRESHOLD; i++)
			await send(t, state.run_id, "A", "bad message");

		await expect(
			t.run((ctx) =>
				startTurn(ctx, state.run_id, "A", "sorry, can we continue?"),
			),
		).rejects.toThrow("This conversation has ended.");
	});

	it("ending one persona's chat does not end another persona's", async () => {
		const t = newTestConvex();
		const state = await startRun(t, twoRoots());
		stubLlm({ harassment: "nonsense" });
		for (let i = 0; i < NONSENSE_THRESHOLD; i++)
			await send(t, state.run_id, "A", "bad message");

		await send(t, state.run_id, "B", "bad message");
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.personaChatState.B).toMatchObject({
			warningCount: 1,
			ended: false,
		});
	});

	it("a normal message after a warning does not reset the warning count", async () => {
		const t = newTestConvex();
		const state = await startRun(t, twoRoots());
		stubLlm({ harassment: "nonsense" });
		await send(t, state.run_id, "A", "bad message");

		stubLlm({ harassment: "normal", replyText: "All good, let's continue." });
		await send(t, state.run_id, "A", "sorry, here's a real question");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.personaChatState.A).toMatchObject({
			warningCount: 1,
			ended: false,
		});
	});
});

describe("referrals", () => {
	function caseWithOneReferral() {
		return caseStructure({
			personas: [
				personaPayload("A", { name: "Alice" }),
				personaPayload("B", { name: "Bob", role: "Analyst" }),
			],
			referrals: [
				referralEdge("A", "B", "the user explicitly asks to speak with Bob"),
			],
			roots: ["A"],
		});
	}

	it("offers a candidate referral with its condition in the prompt, and introducing it unlocks the contact", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseWithOneReferral());
		const { calls } = stubLlm({
			replyText: "I'll connect you with Bob.",
			introduce: ["R1"],
		});

		await send(t, state.run_id, "A", "Can I talk to someone else?");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).toContain("R1: Bob (Analyst)");
		expect(replyCall.body.messages[0].content).toContain(
			"unlock condition: the user explicitly asks to speak with Bob",
		);

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.unlockedReferredIds).toContain("B");
		expect(run.unlockedAt.B).toBeDefined();

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		const bob = live.contacts.find((c) => c.id === "B")!;
		expect(bob).not.toHaveProperty("known_facts");
		expect(bob).not.toHaveProperty("personality_traits");
		expect(bob).not.toHaveProperty("files");
	});

	it("redacts a pending referral's name from the prompt, even after it was mentioned in a reply", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [
				personaPayload("A", {
					name: "Alice",
					known_facts: "Bob is the analyst who audited the budget.",
				}),
				personaPayload("B", { name: "Bob", role: "Analyst" }),
			],
			referrals: [
				referralEdge("A", "B", "the user explicitly asks to speak with Bob"),
			],
			roots: ["A"],
		});
		const state = await startRun(t, structure);
		stubLlm({ replyText: "Let me tell you about Bob." }); // model doesn't introduce Bob (introduce: [])
		await send(t, state.run_id, "A", "Tell me about Bob.");

		const { calls } = stubLlm({ replyText: "Sure, ask away." });
		await send(t, state.run_id, "A", "Anything else?");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).toContain(
			"[undisclosed contact]",
		);
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.unlockedReferredIds).toEqual([]);
	});

	it("ignores a handle the model hallucinates that was never offered", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseWithOneReferral());
		stubLlm({ replyText: "Sure.", introduce: ["R9"] });

		await send(t, state.run_id, "A", "hi");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.unlockedReferredIds).toEqual([]);
	});

	it("unlocks a persona exactly once even if the model repeats its handle in one reply", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseWithOneReferral());
		stubLlm({ replyText: "Meet Bob.", introduce: ["R1", "R1"] });

		await send(t, state.run_id, "A", "hi");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.unlockedReferredIds).toEqual(["B"]);
	});

	it("re-unlocking an already-unlocked persona (a retried applyDecisions call) is a no-op", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseWithOneReferral());
		const streamId = await t.run((ctx) =>
			ctx.db.insert("streamingReplies", {
				runId: state.run_id,
				personaKey: "A",
				text: "",
				status: "streaming",
			}),
		);
		await t.run((ctx) =>
			applyDecisions(
				ctx,
				state.run_id,
				"A",
				"Sure, meet Bob.",
				[{ referredPersonaId: "B" }],
				[],
				streamId,
			),
		);
		const firstUnlockedAt = (await t.run((ctx) => ctx.db.get(state.run_id)))!
			.unlockedAt.B;

		// Time passes before the (simulated) retry.
		const before = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { startTime: before.startTime - 5 * 60_000 }),
		);
		await t.run((ctx) =>
			applyDecisions(
				ctx,
				state.run_id,
				"A",
				"Sure, meet Bob again.",
				[{ referredPersonaId: "B" }],
				[],
				streamId,
			),
		);

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.unlockedReferredIds).toEqual(["B"]);
		expect(run.unlockedAt.B).toBe(firstUnlockedAt);
	});

	it("marks an unlocked persona as referred once messageable", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseWithOneReferral());
		stubLlm({ replyText: "Meet Bob.", introduce: ["R1"] });
		await send(t, state.run_id, "A", "hi");

		stubLlm({ replyText: "Hi, I'm Bob." });
		await send(t, state.run_id, "B", "Hello Bob");

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		expect(live.contacts.find((c) => c.id === "B")?.is_referred).toBe(true);
	});

	it("stops offering a persona referred by two parents to the parent who didn't unlock it", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [
				personaPayload("A", { name: "Alice" }),
				personaPayload("D", { name: "Dana" }),
				personaPayload("B", { name: "Bob", role: "Analyst" }),
			],
			referrals: [
				referralEdge("A", "B", "A asks about Bob"),
				referralEdge("D", "B", "D asks about Bob"),
			],
			roots: ["A", "D"],
		});
		const state = await startRun(t, structure);
		stubLlm({ replyText: "Meet Bob.", introduce: ["R1"] });
		await send(t, state.run_id, "A", "hi");

		const { calls } = stubLlm({ replyText: "hi" });
		await send(t, state.run_id, "D", "hi");
		// B is already unlocked (via A), so it's no longer offered as a candidate to D either --
		// unlockedReferredIds isn't scoped per-parent.
		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).not.toContain("Bob");
		expect(replyCall.body.messages[0].content).toContain(
			"You have no one to introduce this turn.",
		);
	});

	it("numbers handles stably and one-indexed across multiple pending referrals", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [
				personaPayload("A", { name: "Alice" }),
				personaPayload("B", { name: "Bob" }),
				personaPayload("C", { name: "Carl" }),
				personaPayload("E", { name: "Erin" }),
			],
			referrals: [
				referralEdge("A", "B", "cond 1"),
				referralEdge("A", "C", "cond 2"),
				referralEdge("A", "E", "cond 3"),
			],
			roots: ["A"],
		});
		const state = await startRun(t, structure);
		const { calls } = stubLlm({ replyText: "hi" });

		await send(t, state.run_id, "A", "hi");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		const prompt: string = replyCall.body.messages[0].content;
		expect(prompt).toContain("R1: Bob");
		expect(prompt).toContain("R2: Carl");
		expect(prompt).toContain("R3: Erin");
	});

	it("never unlocks a referral with a blank condition, and never even offers it as a candidate", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B", { name: "Bob" })],
			referrals: [referralEdge("A", "B", "")],
			roots: ["A"],
		});
		const state = await startRun(t, structure);
		const { calls } = stubLlm({ replyText: "hi" });

		await send(t, state.run_id, "A", "hi");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).toContain(
			"You have no one to introduce this turn.",
		);
		expect(replyCall.body.messages[0].content).not.toContain("Bob");
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.unlockedReferredIds).toEqual([]);
	});
});

describe("files", () => {
	// getTurnContext reads file_id straight off the case's structure blob, and applyDecisions'
	// sharedFiles input requires a real Id<"files"> -- so the files row has to exist BEFORE the
	// case is seeded, and the structure's file entry has to reference that real id, not a
	// placeholder string.
	async function startRunWithOneFile(t: ReturnType<typeof newTestConvex>) {
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["budget"])),
		);
		const fileId = await t.run((ctx) =>
			ctx.db.insert("files", {
				storageId,
				name: "budget.pdf",
				contentType: "application/pdf",
			}),
		);
		const structure = caseStructure({
			personas: [
				personaPayload("A", {
					files: [
						fileEntry({
							file_id: fileId,
							storage_id: storageId,
							file_name: "budget.pdf",
							share_conditions: "the user asks about the budget",
							perceived_contents: "Q3 numbers",
						}),
					],
				}),
			],
		});
		const state = await startRun(t, structure);
		return { state, fileId };
	}

	it("offers a candidate file with its condition in the prompt, and sending it shares a stable url", async () => {
		const t = newTestConvex();
		const { state, fileId } = await startRunWithOneFile(t);
		const { calls } = stubLlm({
			replyText: "Here's the budget.",
			sendFiles: ["F1"],
		});

		await send(t, state.run_id, "A", "Can I see the budget?");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).toContain(
			"F1: budget.pdf (what you believe it contains: Q3 numbers)",
		);
		expect(replyCall.body.messages[0].content).toContain(
			"sharing condition: the user asks about the budget",
		);

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(Object.keys(run.sharedFiles)).toContain(fileId);

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		expect(live.shared_files[0]!.url).toEqual(expect.any(String));
	});

	it("never shares a file with a blank share condition, and never even offers it as a candidate", async () => {
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["budget"])),
		);
		const fileId = await t.run((ctx) =>
			ctx.db.insert("files", {
				storageId,
				name: "budget.pdf",
				contentType: "application/pdf",
			}),
		);
		const structure = caseStructure({
			personas: [
				personaPayload("A", {
					files: [
						fileEntry({
							file_id: fileId,
							storage_id: storageId,
							file_name: "budget.pdf",
							share_conditions: "",
							perceived_contents: "Q3 numbers",
						}),
					],
				}),
			],
		});
		const state = await startRun(t, structure);
		const { calls } = stubLlm({ replyText: "hi" });

		await send(t, state.run_id, "A", "hi");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).toContain(
			"You have no file to send this turn.",
		);
		expect(replyCall.body.messages[0].content).not.toContain("budget.pdf");
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.sharedFiles).toEqual({});
	});

	it("never offers a file with no file_id, and withholds it from the prompt", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [
				personaPayload("A", { files: [fileEntry({ file_id: null })] }),
			],
		});
		const state = await startRun(t, structure);
		const { calls } = stubLlm({ replyText: "Sure." });

		await send(t, state.run_id, "A", "Can I see the budget?");

		const replyCall = calls.find((c) => c.kind === "reply")!;
		expect(replyCall.body.messages[0].content).not.toContain("doc.pdf");
		expect(replyCall.body.messages[0].content).toContain(
			"You have no file to send this turn.",
		);
	});

	it("withholds a file the model doesn't choose to send", async () => {
		const t = newTestConvex();
		const { state } = await startRunWithOneFile(t);
		stubLlm({ replyText: "I can't share that." });

		await send(t, state.run_id, "A", "Can I see the budget?");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.sharedFiles).toEqual({});
	});

	it("does not re-offer or re-share an already-shared file", async () => {
		const t = newTestConvex();
		const { state } = await startRunWithOneFile(t);
		stubLlm({ replyText: "Here's the budget.", sendFiles: ["F1"] });
		await send(t, state.run_id, "A", "Can I see the budget?");

		const { calls: secondCalls } = stubLlm({
			replyText: "Anything else?",
			sendFiles: ["F1"],
		});
		await send(t, state.run_id, "A", "Anything else about the budget?");
		const secondReplyCall = secondCalls.find((c) => c.kind === "reply")!;
		expect(secondReplyCall.body.messages[0].content).toContain(
			"You have no file to send this turn.",
		);
		expect(secondReplyCall.body.messages[0].content).not.toContain(
			"budget.pdf",
		);

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(Object.keys(run.sharedFiles)).toHaveLength(1);
	});

	it("ignores an unknown file handle from the model", async () => {
		const t = newTestConvex();
		const state = await startRun(
			t,
			caseStructure({ personas: [personaPayload("A", { files: [] })] }),
		);
		stubLlm({ replyText: "Sure.", sendFiles: ["F9"] });

		await send(t, state.run_id, "A", "hi");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.sharedFiles).toEqual({});
	});
});
