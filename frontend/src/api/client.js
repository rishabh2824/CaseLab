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

function parseSseFrame(raw) {
    let eventType = 'message'
    const dataLines = []
    for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (!dataLines.length) return null
    try {
        return { type: eventType, data: JSON.parse(dataLines.join('\n')) }
    } catch {
        return null
    }
}

/**
 * POST to a Server-Sent-Events endpoint and invoke `onEvent({type, data})` for
 * each frame as it streams in. Pre-stream errors (non-2xx) throw like apiFetch,
 * so the caller can distinguish a rejected request from a mid-stream failure
 * (which arrives as an `error` event).
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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Frames are separated by a blank line (\n\n).
        for (;;) {
            const sep = buffer.indexOf('\n\n')
            if (sep === -1) break
            const frame = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            const parsed = parseSseFrame(frame)
            if (parsed) onEvent(parsed)
        }
    }
}
