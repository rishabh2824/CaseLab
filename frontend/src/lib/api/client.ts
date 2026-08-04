import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { StreamEvent } from "../types.js";

// Requests are always same-origin: `pnpm run dev`'s proxy and DigitalOcean App Platform
// both serve frontend and backend from one origin, so `path` (always "/api/...") is used
// as-is — no base URL to configure or get wrong.

// Thrown by apiFetch/streamChat on a non-2xx response, carrying the HTTP
// status so callers can branch on it (e.g. run.svelte.js's 404 → expired-run
// handling) without parsing the message string. `code` is set only for
// endpoints that return a structured `{message, code}` detail instead of a
// plain string (currently just updateCase's version-conflict 409 — see
// services/cases.py's VERSION_CONFLICT) — every other HTTPException in the
// backend still sends a plain string and leaves `code` undefined.
export class ApiError extends Error {
	status: number;
	code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

async function errorFromResponse(response: Response): Promise<ApiError> {
	let detail: string | undefined;
	let code: string | undefined;
	try {
		const body = await response.json();
		if (typeof body?.detail === "string") {
			detail = body.detail;
		} else if (body?.detail && typeof body.detail === "object") {
			detail = body.detail.message;
			code = body.detail.code;
		}
	} catch {
		// non-JSON error body; fall through to status text
	}
	return new ApiError(
		detail || `Request failed: ${response.status}`,
		response.status,
		code,
	);
}

type ApiFetchInit = {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
};

// Fetch a JSON endpoint under the API base. T defaults to `unknown` — pass an
// explicit type argument at the call site; a forgotten one now surfaces as a
// compile error instead of silently disabling type checking on the response.
export async function apiFetch<T = unknown>(
	path: string,
	{ method = "GET", body, headers }: ApiFetchInit = {},
): Promise<T> {
	const finalHeaders: Record<string, string> = { ...headers };
	if (body !== undefined) finalHeaders["Content-Type"] = "application/json";

	const response = await fetch(path, {
		method,
		headers: finalHeaders,
		credentials: "include",
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	if (!response.ok) throw await errorFromResponse(response);

	return (await response.json()) as T;
}

const TIMEOUT_ERROR_MESSAGE =
	"Connection timed out. Please check your network and try again.";

type StreamChatInit = {
	body: unknown;
	onEvent: (event: StreamEvent) => void;
	idleTimeoutMs?: number;
};

/**
 * POST to a Server-Sent-Events endpoint and invoke `onEvent({type, data})` for each frame as it streams in.
 * Pre-stream errors throw like apiFetch,so the caller can distinguish a rejected request from a mid-stream failure.
 * Guards against a stalled connection with an IDLE timeout: it resets on every chunk received
 */
export async function streamChat(
	path: string,
	{ body, onEvent, idleTimeoutMs = 30000 }: StreamChatInit,
): Promise<void> {
	const headers = { "Content-Type": "application/json" };

	const controller = new AbortController();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdleTimer = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			controller.abort(new DOMException("Idle timeout", "TimeoutError"));
		}, idleTimeoutMs);
	};
	// Duck-typed on purpose (not `instanceof DOMException`): the fetch
	// implementation's thrown error type isn't guaranteed, so this checks
	// `.name` on whatever comes through instead of narrowing to one class.
	const errorName = (error: unknown): unknown =>
		error && typeof error === "object" && "name" in error
			? (error as { name: unknown }).name
			: undefined;
	const isTimeoutAbort = (error: unknown) =>
		errorName(error) === "TimeoutError" ||
		(errorName(error) === "AbortError" && controller.signal.aborted);

	armIdleTimer(); // guards the connect phase too — a server that never responds is also a stall

	let response: Response;
	try {
		response = await fetch(path, {
			method: "POST",
			headers,
			credentials: "include",
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (error) {
		clearTimeout(idleTimer);
		throw isTimeoutAbort(error) ? new Error(TIMEOUT_ERROR_MESSAGE) : error;
	}

	if (!response.ok) {
		clearTimeout(idleTimer);
		throw await errorFromResponse(response);
	}

	const parser = createParser({
		onEvent: (event: EventSourceMessage) => {
			// biome-ignore lint/suspicious/noExplicitAny: parsed JSON can't be verified against StreamEvent's data union
			let data: any;
			try {
				data = JSON.parse(event.data);
			} catch {
				return;
			}
			onEvent({
				type: (event.event ?? "message") as StreamEvent["type"],
				data,
			});
		},
	});
	if (!response.body) throw new Error(TIMEOUT_ERROR_MESSAGE);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			armIdleTimer(); // any bytes (including sse-starlette's ~15s ping) count as activity
			parser.feed(decoder.decode(value, { stream: true }));
		}
	} catch (error) {
		throw isTimeoutAbort(error) ? new Error(TIMEOUT_ERROR_MESSAGE) : error;
	} finally {
		clearTimeout(idleTimer);
	}
}
