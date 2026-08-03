// Runs in the jsdom (client) project: apiFetch/streamChat call `fetch` with a
// relative path ("/api/..."), which needs a document origin to resolve
// against. That is exactly the environment they run in for real — the app is
// an SPA with `ssr = false` (see src/routes/+layout.ts), so there is no
// server-side caller to cover.
import { delay, HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server, sseBody, sseStreamResponse } from "../../testing/msw.js";
import { ApiError, apiFetch, streamChat } from "./client.js";

function assertApiError(err: unknown): asserts err is ApiError {
	if (!(err instanceof ApiError)) throw err;
}

describe("apiFetch", () => {
	it("sends the given method to the given path, always with credentials included", async () => {
		let captured: {
			method: string;
			pathname: string;
			credentials: string;
		} | null = null;
		server.use(
			http.post("*/api/widgets", ({ request }) => {
				captured = {
					method: request.method,
					pathname: new URL(request.url).pathname,
					credentials: request.credentials,
				};
				return HttpResponse.json({ id: 1 });
			}),
		);

		await apiFetch("/api/widgets", { method: "POST", body: { name: "a" } });

		expect(captured).toEqual({
			method: "POST",
			pathname: "/api/widgets",
			credentials: "include",
		});
	});

	it("sets Content-Type: application/json only when a body is present", async () => {
		const contentTypes: (string | null)[] = [];
		server.use(
			http.get("*/api/no-body", ({ request }) => {
				contentTypes.push(request.headers.get("content-type"));
				return HttpResponse.json({});
			}),
			http.post("*/api/with-body", ({ request }) => {
				contentTypes.push(request.headers.get("content-type"));
				return HttpResponse.json({});
			}),
		);

		await apiFetch("/api/no-body");
		await apiFetch("/api/with-body", { method: "POST", body: { a: 1 } });

		expect(contentTypes).toEqual([null, "application/json"]);
	});

	it("parses a JSON response body", async () => {
		server.use(
			http.get("*/api/thing", () =>
				HttpResponse.json({ id: 7, name: "budget" }),
			),
		);

		const result = await apiFetch<{ id: number; name: string }>("/api/thing");

		expect(result).toEqual({ id: 7, name: "budget" });
	});

	it("returns null for an empty 200 body", async () => {
		server.use(
			http.get("*/api/empty", () => new HttpResponse(null, { status: 200 })),
		);

		const result = await apiFetch("/api/empty");

		expect(result).toBeNull();
	});
});

describe("ApiError", () => {
	it("a plain-string detail sets .message and .status and leaves .code undefined", async () => {
		server.use(
			http.get("*/api/fail-plain", () =>
				HttpResponse.json(
					{ detail: "Access code not found." },
					{ status: 422 },
				),
			),
		);

		const err = await apiFetch("/api/fail-plain").catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		assertApiError(err);
		expect(err.name).toBe("ApiError");
		expect(err.message).toBe("Access code not found.");
		expect(err.status).toBe(422);
		expect(err.code).toBeUndefined();
	});

	// The case form's version-conflict modal (see updateCase / services/cases.py's
	// VERSION_CONFLICT) branches on `err.code`, so this structured shape is the
	// one detail besides the plain string that actually matters.
	it("a {detail: {message, code}} body sets .code (the version-conflict shape)", async () => {
		server.use(
			http.put("*/api/cases/1", () =>
				HttpResponse.json(
					{
						detail: {
							message: "This case was edited elsewhere.",
							code: "VERSION_CONFLICT",
						},
					},
					{ status: 409 },
				),
			),
		);

		const err = await apiFetch("/api/cases/1", {
			method: "PUT",
			body: {},
		}).catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		assertApiError(err);
		expect(err.message).toBe("This case was edited elsewhere.");
		expect(err.status).toBe(409);
		expect(err.code).toBe("VERSION_CONFLICT");
	});

	it("a non-JSON error body falls back to 'Request failed: <status>'", async () => {
		server.use(
			http.get(
				"*/api/fail-html",
				() => new HttpResponse("<html>502 Bad Gateway</html>", { status: 502 }),
			),
		);

		const err = await apiFetch("/api/fail-html").catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		assertApiError(err);
		expect(err.message).toBe("Request failed: 502");
		expect(err.status).toBe(502);
		expect(err.code).toBeUndefined();
	});

	it("an empty error body falls back to 'Request failed: <status>'", async () => {
		server.use(
			http.get(
				"*/api/fail-empty",
				() => new HttpResponse(null, { status: 500 }),
			),
		);

		const err = await apiFetch("/api/fail-empty").catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		assertApiError(err);
		expect(err.message).toBe("Request failed: 500");
		expect(err.status).toBe(500);
	});
});

describe("streamChat", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses named SSE events into {type, data} and calls onEvent once per frame, in order", async () => {
		server.use(
			http.post(
				"*/api/stream/basic",
				() =>
					new HttpResponse(
						sseBody([
							{ event: "delta", data: { text: "Hel" } },
							{ event: "delta", data: { text: "lo" } },
							{
								event: "meta",
								data: {
									new_contacts: [],
									shared_files: [],
									chat_ended: false,
									chat_end_reason: null,
									warning_count: 0,
								},
							},
							{ event: "done", data: { history: [] } },
							{ event: "error", data: { detail: "boom" } },
						]),
						{ status: 200, headers: { "Content-Type": "text/event-stream" } },
					),
			),
		);

		const events: Array<{ type: string; data: unknown }> = [];
		await streamChat("/api/stream/basic", {
			body: {},
			onEvent: (e) => events.push(e),
		});

		expect(events.map((e) => e.type)).toEqual([
			"delta",
			"delta",
			"meta",
			"done",
			"error",
		]);
		expect(events[0]?.data).toEqual({ text: "Hel" });
		expect(events[3]?.data).toEqual({ history: [] });
		expect(events[4]?.data).toEqual({ detail: "boom" });
	});

	it("silently skips a frame whose data is not valid JSON, without aborting the stream", async () => {
		// Pin the try/catch in client.ts's onEvent handler: a malformed frame
		// must not take down the rest of the stream.
		const raw =
			'event: delta\ndata: not-json-at-all\n\nevent: delta\ndata: {"text":"ok"}\n\n';
		server.use(
			http.post(
				"*/api/stream/bad-json",
				() =>
					new HttpResponse(raw, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					}),
			),
		);

		const events: Array<{ type: string; data: unknown }> = [];
		await streamChat("/api/stream/bad-json", {
			body: {},
			onEvent: (e) => events.push(e),
		});

		expect(events).toEqual([{ type: "delta", data: { text: "ok" } }]);
	});

	it("delivers a frame with no event: line as type 'message'", async () => {
		const raw = 'data: {"text":"unnamed"}\n\n';
		server.use(
			http.post(
				"*/api/stream/unnamed",
				() =>
					new HttpResponse(raw, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					}),
			),
		);

		const events: Array<{ type: string; data: unknown }> = [];
		await streamChat("/api/stream/unnamed", {
			body: {},
			onEvent: (e) => events.push(e),
		});

		expect(events).toEqual([{ type: "message", data: { text: "unnamed" } }]);
	});

	it("reassembles a frame split across chunk boundaries", async () => {
		// The failure mode a single-string mock body can never catch: a chunk
		// that ends mid `data:` line must be buffered and joined with the next
		// chunk, not parsed (or dropped) as two separate malformed frames.
		server.use(
			http.post("*/api/stream/split", () =>
				sseStreamResponse(['event: delta\ndata: {"te', 'xt":"stitched"}\n\n']),
			),
		);

		const events: Array<{ type: string; data: unknown }> = [];
		await streamChat("/api/stream/split", {
			body: {},
			onEvent: (e) => events.push(e),
		});

		expect(events).toEqual([{ type: "delta", data: { text: "stitched" } }]);
	});

	it("throws an ApiError (not the timeout message) on a pre-stream non-2xx response", async () => {
		server.use(
			http.post("*/api/stream/rejected", () =>
				HttpResponse.json(
					{ detail: "This conversation has ended." },
					{ status: 409 },
				),
			),
		);

		const err = await streamChat("/api/stream/rejected", {
			body: {},
			onEvent: () => {},
		}).catch((e) => e);

		expect(err).toBeInstanceOf(ApiError);
		expect(err.message).toBe("This conversation has ended.");
		expect(err.status).toBe(409);
	});

	describe("idle timeout", () => {
		// MSW's mocked fetch response bodies are plain ReadableStreams that are
		// NOT wired to the request's AbortSignal (verified empirically: aborting
		// the controller mid-read does not reject a pending `reader.read()` on a
		// mocked stream — the read just resolves whenever the mock's own timer
		// fires). Real fetch/undici, reading off an actual socket, does reject
		// on abort. So the two tests below that need a stall *during* an
		// already-open stream hand-stub `fetch` with a body that honors the
		// signal the way a live connection would — MSW genuinely can't express
		// this. Everything else in this file uses MSW.
		function fetchWithAbortAwareStream(chunks: string[], chunkDelayMs: number) {
			return async (_input: unknown, init?: RequestInit) => {
				const signal = init?.signal as AbortSignal | undefined;
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						try {
							for (const chunk of chunks) {
								await new Promise<void>((resolve, reject) => {
									if (signal?.aborted) return reject(signal.reason);
									const timer = setTimeout(resolve, chunkDelayMs);
									signal?.addEventListener(
										"abort",
										() => {
											clearTimeout(timer);
											reject(signal.reason);
										},
										{ once: true },
									);
								});
								controller.enqueue(encoder.encode(chunk));
							}
							controller.close();
						} catch (err) {
							controller.error(err);
						}
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			};
		}

		it("rejects with the timeout message when the stream stalls between chunks", async () => {
			vi.stubGlobal(
				"fetch",
				fetchWithAbortAwareStream(
					[
						'event: delta\ndata: {"text":"a"}\n\n',
						'event: delta\ndata: {"text":"b"}\n\n',
					],
					200,
				),
			);

			await expect(
				streamChat("/api/stream/stall", {
					body: {},
					onEvent: () => {},
					idleTimeoutMs: 30,
				}),
			).rejects.toThrow(
				"Connection timed out. Please check your network and try again.",
			);
		});

		it("resets the idle timer on activity: chunks slower than idle but the stream finishes successfully", async () => {
			const frames = Array.from(
				{ length: 5 },
				(_, i) => `event: delta\ndata: {"text":"${i}"}\n\n`,
			);
			// Each gap (20ms) is well under the 60ms idle timeout, but the total
			// run (~100ms) comfortably exceeds it — only a timer that resets on
			// every chunk lets this finish without tripping.
			vi.stubGlobal("fetch", fetchWithAbortAwareStream(frames, 20));

			const events: Array<{ type: string; data: unknown }> = [];
			await streamChat("/api/stream/steady", {
				body: {},
				onEvent: (e) => events.push(e),
				idleTimeoutMs: 60,
			});

			expect(events).toHaveLength(5);
		});

		it("produces the timeout message on a connect-phase stall (server never responds)", async () => {
			server.use(
				http.post("*/api/stream/connect-stall", async () => {
					await delay(500);
					return HttpResponse.json({ unreachable: true });
				}),
			);

			await expect(
				streamChat("/api/stream/connect-stall", {
					body: {},
					onEvent: () => {},
					idleTimeoutMs: 30,
				}),
			).rejects.toThrow(
				"Connection timed out. Please check your network and try again.",
			);
		});

		it("clears the idle timer on success, leaving no dangling timer", async () => {
			server.use(
				http.post(
					"*/api/stream/quick",
					() =>
						new HttpResponse(sseBody([{ event: "done", data: {} }]), {
							status: 200,
							headers: { "Content-Type": "text/event-stream" },
						}),
				),
			);
			const clearSpy = vi.spyOn(globalThis, "clearTimeout");

			await streamChat("/api/stream/quick", { body: {}, onEvent: () => {} });

			// armIdleTimer() runs at least twice (connect phase + the one read
			// that yields `done`), and every arm/disarm goes through
			// clearTimeout first; the `finally` clears it one last time on the
			// way out. If any of those calls were skipped, a real idle timer
			// would be left running past the end of the test.
			expect(clearSpy).toHaveBeenCalled();
			clearSpy.mockRestore();
		});
	});
});
