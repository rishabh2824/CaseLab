// Simulates N students concurrently running a case study, to find the actual breaking point
// before a real class does. Talks to a real Convex deployment over plain HTTP (ConvexHttpClient
// -- no websocket, no auth needed, matches how the student frontend calls these same functions)
// and fires real LLM calls through convex/lib/llm.ts, so each run costs real OpenRouter/Anthropic
// spend. Start small (LOADTEST_STUDENTS=10) before jumping to 100.
//
// Usage:
//   LOADTEST_CONVEX_URL=https://terrific-mockingbird-415.convex.cloud \
//   LOADTEST_ACCESS_CODE=yourtestcode \
//   LOADTEST_STUDENTS=100 \
//   LOADTEST_MESSAGES=3 \
//   LOADTEST_RAMP_MS=10000 \
//   node scripts/loadtest.js
//
// LOADTEST_RAMP_MS spreads student starts evenly across that window (simulates students
// trickling in); set it to 0 for the worst case -- every student starting and messaging in the
// same instant.
//
// NEVER point this at the prod deployment's real access codes -- it inserts real `runs` rows
// and spends real LLM budget. Point it at the dev deployment (or a preview deployment) against a
// disposable test case made for this purpose.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.LOADTEST_CONVEX_URL;
const ACCESS_CODE = process.env.LOADTEST_ACCESS_CODE;
const NUM_STUDENTS = Number(process.env.LOADTEST_STUDENTS ?? 10);
const MESSAGES_PER_STUDENT = Number(process.env.LOADTEST_MESSAGES ?? 3);
const RAMP_MS = Number(process.env.LOADTEST_RAMP_MS ?? 10_000);

if (!CONVEX_URL || !ACCESS_CODE) {
	console.error(
		"Set LOADTEST_CONVEX_URL and LOADTEST_ACCESS_CODE env vars (see comment at top of this file).",
	);
	process.exit(1);
}

const MESSAGES = [
	"Hi, can you tell me more about what happened?",
	"What's your role in this situation?",
	"Is there anything else I should know before I decide?",
	"Can you walk me through the timeline again?",
];

async function pollUntilDone(client, runId, personaId, timeoutMs = 60_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const preview = await client.query(api.turn.getStreamingPreview, {
			runId,
			personaId,
		});
		if (preview?.status === "done" || preview?.status === "error") {
			return preview.status;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return "timeout";
}

async function simulateStudent(index) {
	const client = new ConvexHttpClient(CONVEX_URL);
	const result = { index, startError: null, turns: [] };
	try {
		const state = await client.mutation(api.simulations.start, {
			accessCode: ACCESS_CODE,
		});
		const runId = state.run_id;
		const personaId = state.active_persona_id;
		for (let i = 0; i < MESSAGES_PER_STUDENT; i++) {
			const turnStart = Date.now();
			try {
				await client.mutation(api.turn.start, {
					runId,
					personaId,
					message: MESSAGES[i % MESSAGES.length],
				});
				const status = await pollUntilDone(client, runId, personaId);
				result.turns.push({
					ok: status === "done",
					status,
					ms: Date.now() - turnStart,
				});
			} catch (err) {
				result.turns.push({
					ok: false,
					status: "threw",
					error: String(err),
					ms: Date.now() - turnStart,
				});
			}
			// Pacing between a student's own messages -- not a machine gun. Tune down to stress
			// the per-run message rate limit (15/min, lib/rateLimits.ts) on purpose.
			await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
		}
	} catch (err) {
		result.startError = String(err);
	}
	return result;
}

async function main() {
	console.log(
		`Load test: ${NUM_STUDENTS} students, ${MESSAGES_PER_STUDENT} messages each, ` +
			`ramped over ${RAMP_MS}ms, against ${CONVEX_URL}`,
	);
	const tasks = [];
	for (let i = 0; i < NUM_STUDENTS; i++) {
		const delay = RAMP_MS > 0 ? (i / NUM_STUDENTS) * RAMP_MS : 0;
		tasks.push(
			new Promise((resolve) =>
				setTimeout(() => resolve(simulateStudent(i)), delay),
			),
		);
	}
	const results = await Promise.all(tasks);

	const startFailures = results.filter((r) => r.startError);
	const allTurns = results.flatMap((r) => r.turns);
	const turnFailures = allTurns.filter((t) => !t.ok);
	const durations = allTurns
		.filter((t) => t.ok)
		.map((t) => t.ms)
		.sort((a, b) => a - b);
	const pct = (p) => durations[Math.floor(durations.length * p)] ?? null;

	console.log(`\n== Results ==`);
	console.log(
		`Students that failed to start: ${startFailures.length}/${NUM_STUDENTS}`,
	);
	console.log(
		`Turns attempted: ${allTurns.length}, failed: ${turnFailures.length}`,
	);
	console.log(
		`Turn latency (ms): p50=${pct(0.5)} p95=${pct(0.95)} p99=${pct(0.99)} max=${durations.at(-1) ?? null}`,
	);
	if (startFailures.length > 0) {
		console.log("Sample start error:", startFailures[0].startError);
	}
	if (turnFailures.length > 0) {
		const byStatus = {};
		for (const t of turnFailures) {
			const key = t.error ?? t.status;
			byStatus[key] = (byStatus[key] ?? 0) + 1;
		}
		console.log("Turn failures by cause:", byStatus);
	}
}

main();
