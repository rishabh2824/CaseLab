import { createParser } from 'eventsource-parser'

// Base URL of the backend
export const API_BASE = import.meta.env.VITE_API_BASE

/**
 * Fetch a JSON endpoint under the API base.
 * Admin auth rides an httpOnly session cookie (set by POST /api/admin/login),
 * so every request goes out with `credentials: 'include'` —
 * the browser attaches it automatically where it applies, and it's a no-op otherwise.
 */
export async function apiFetch(path, { method = 'GET', body, headers } = {}) {
    const finalHeaders = { ...headers }
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'

    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: finalHeaders,
        credentials: 'include',
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
        let detail
        try {detail = (await response.json())?.detail} catch {
            // non-JSON error body; fall through to status text
        }
        const error = new Error(detail || `Request failed: ${response.status}`)
        error.status = response.status
        throw error
    }

    const text = await response.text()
    return text ? JSON.parse(text) : null
}


const TIMEOUT_ERROR_MESSAGE = 'Connection timed out. Please check your network and try again.'


/**
 * Open a push-only WebSocket that receives simulation state updates as the server's
 * poll loop notices changes (see backend api/simulations.py simulationLive).
 * Reconnects on any unexpected close with exponential backoff; a clean unmount
 * (the returned close function) skips reconnecting. Returns a function to close it.
 */
export function openSimulationSocket(path, { onState, onExpired }) {
    const wsBase = API_BASE.replace(/^http/, 'ws')
    let socket = null
    let closedByCaller = false
    let expired = false
    let retryDelayMs = 1000
    let retryTimer = null

    const connect = () => {
        socket = new WebSocket(`${wsBase}${path}`)
        socket.onopen = () => {
            retryDelayMs = 1000
        }
        socket.onmessage = (event) => {
            let message
            try {
                message = JSON.parse(event.data)
            } catch {
                return
            }
            if (message.type === 'state') onState(message.data)
            else if (message.type === 'expired') {
                expired = true
                onExpired()
            }
        }
        socket.onclose = () => {
            if (closedByCaller || expired) return
            retryTimer = setTimeout(connect, retryDelayMs)
            retryDelayMs = Math.min(retryDelayMs * 2, 15000)
        }
    }
    connect()

    return () => {
        closedByCaller = true
        clearTimeout(retryTimer)
        socket?.close()
    }
}


/**
 * POST to a Server-Sent-Events endpoint and invoke `onEvent({type, data})` for each frame as it streams in.
 * Pre-stream errors throw like apiFetch,so the caller can distinguish a rejected request from a mid-stream failure.
 * Guards against a stalled connection with an IDLE timeout: it resets on every chunk received
 */
export async function streamChat(path, { body, onEvent, idleTimeoutMs = 30000 } = {}) {
    const headers = { 'Content-Type': 'application/json' }

    const controller = new AbortController()
    let idleTimer
    const armIdleTimer = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
            controller.abort(new DOMException('Idle timeout', 'TimeoutError'))
        }, idleTimeoutMs)
    }
    const isTimeoutAbort = (error) =>
        error?.name === 'TimeoutError' ||
        (error?.name === 'AbortError' && controller.signal.aborted)

    armIdleTimer() // guards the connect phase too — a server that never responds is also a stall

    let response
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers,
            credentials: 'include',
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
        try {detail = (await response.json())?.detail} catch {}
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
