import { createParser } from 'eventsource-parser'

// Base URL of the backend. No trailing slash. All routes live under `${API_BASE}/api/...`.
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

/**
 * Fetch a JSON endpoint under the API base.
 * Throws an Error (with the backend `detail` when present) on non-2xx.
 *
 * @param {string} path        e.g. `/api/cases`
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {any}    [opts.body]        JSON-serialized automatically
 * @param {string} [opts.adminJwt]    sent as `Authorization: Bearer <adminJwt>`
 * @param {object} [opts.headers]     extra headers
 */
export async function apiFetch(path, { method = 'GET', body, adminJwt, headers } = {}) {
    const finalHeaders = { ...headers }
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
    if (adminJwt) finalHeaders.Authorization = `Bearer ${adminJwt}`

    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
        let detail
        try {
            detail = (await response.json())?.detail
        } catch {
            // non-JSON error body; fall through to status text
        }
        const error = new Error(detail || `Request failed: ${response.status}`)
        error.status = response.status
        throw error
    }
    // 204 / empty bodies
    const text = await response.text()
    return text ? JSON.parse(text) : null
}

const TIMEOUT_ERROR_MESSAGE = 'Connection timed out. Please check your network and try again.'

/**
 * POST to a Server-Sent-Events endpoint and invoke `onEvent({type, data})` for
 * each frame as it streams in. Pre-stream errors (non-2xx) throw like apiFetch,
 * so the caller can distinguish a rejected request from a mid-stream failure
 * (which arrives as an `error` event). SSE framing/decoding is handled by
 * `eventsource-parser` (multi-byte-safe across chunk boundaries).
 *
 * Guards against a stalled connection (proxy idle-timeout half-open, a laptop
 * moving between Wi-Fi networks, etc.) with an IDLE timeout: it resets on every
 * chunk received (not just once for the whole request), so a slow-but-alive
 * generation never trips it, but a truly dead connection is caught quickly.
 * The backend (sse-starlette) sends a keep-alive ping every ~15s, so the
 * default 30s idle window has margin to spare while still failing fast.
 *
 * @param {string} path
 * @param {object} opts
 * @param {any}      opts.body
 * @param {string}   [opts.adminJwt]
 * @param {(event: {type: string, data: any}) => void} opts.onEvent
 * @param {number}   [opts.idleTimeoutMs=30000] reset on each chunk; fires if
 *   no bytes (including pings) arrive for this long
 */
export async function streamChat(
    path,
    { body, adminJwt, onEvent, idleTimeoutMs = 30000 } = {},
) {
    const headers = { 'Content-Type': 'application/json' }
    if (adminJwt) headers.Authorization = `Bearer ${adminJwt}`

    const controller = new AbortController()
    let idleTimer
    const armIdleTimer = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
            controller.abort(new DOMException('Idle timeout waiting for server activity.', 'TimeoutError'))
        }, idleTimeoutMs)
    }
    const isTimeoutAbort = (error) =>
        error?.name === 'TimeoutError' || (error?.name === 'AbortError' && controller.signal.aborted)

    armIdleTimer() // guards the connect phase too — a server that never responds is also a stall

    let response
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        })
    } catch (error) {
        clearTimeout(idleTimer)
        throw isTimeoutAbort(error) ? new Error(TIMEOUT_ERROR_MESSAGE) : error
    }

    if (!response.ok) {
        clearTimeout(idleTimer)
        let detail
        try {
            detail = (await response.json())?.detail
        } catch {
            // non-JSON error body
        }
        const error = new Error(detail || `Request failed: ${response.status}`)
        error.status = response.status
        throw error
    }

    const parser = createParser({
        onEvent: (event) => {
            let data
            try {
                data = JSON.parse(event.data)
            } catch {
                return
            }
            onEvent({ type: event.event || 'message', data })
        },
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            armIdleTimer() // any bytes (including sse-starlette's ~15s ping) count as activity
            parser.feed(decoder.decode(value, { stream: true }))
        }
    } catch (error) {
        throw isTimeoutAbort(error) ? new Error(TIMEOUT_ERROR_MESSAGE) : error
    } finally {
        clearTimeout(idleTimer)
    }
}
