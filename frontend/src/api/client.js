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
