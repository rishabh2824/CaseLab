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
 * @param {string} [opts.adminToken]  sent as `X-Admin-Token`
 * @param {object} [opts.headers]     extra headers
 */
export async function apiFetch(path, { method = 'GET', body, adminToken, headers } = {}) {
    const finalHeaders = { ...headers }
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
    if (adminToken) finalHeaders['X-Admin-Token'] = adminToken

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

/**
 * POST to a Server-Sent-Events endpoint and invoke `onEvent({type, data})` for
 * each frame as it streams in. Pre-stream errors (non-2xx) throw like apiFetch,
 * so the caller can distinguish a rejected request from a mid-stream failure
 * (which arrives as an `error` event). SSE framing/decoding is handled by
 * `eventsource-parser` (multi-byte-safe across chunk boundaries).
 *
 * @param {string} path
 * @param {object} opts
 * @param {any}      opts.body
 * @param {string}   [opts.adminToken]
 * @param {(event: {type: string, data: any}) => void} opts.onEvent
 */
export async function streamChat(path, { body, adminToken, onEvent } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (adminToken) headers['X-Admin-Token'] = adminToken

    const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    })

    if (!response.ok) {
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
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
    }
}
