import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, openSimulationSocket } from './client.js'

// --- apiFetch ---------------------------------------------------------------
const fakeResponse = ({ ok = true, status = 200, jsonBody, textBody = '' }) => ({
    ok,
    status,
    json: async () => {
        if (jsonBody === undefined) throw new Error('no json')
        return jsonBody
    },
    text: async () => textBody,
})

describe('apiFetch', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('parses a JSON response body', async () => {
        global.fetch = vi.fn().mockResolvedValue(fakeResponse({ textBody: '{"a":1}' }))
        await expect(apiFetch('/x')).resolves.toEqual({ a: 1 })
    })

    it('returns null for an empty body', async () => {
        global.fetch = vi.fn().mockResolvedValue(fakeResponse({ textBody: '' }))
        await expect(apiFetch('/x')).resolves.toBeNull()
    })

    it('sends credentials and hits the API base', async () => {
        global.fetch = vi.fn().mockResolvedValue(fakeResponse({ textBody: '' }))
        await apiFetch('/api/thing')
        expect(global.fetch).toHaveBeenCalledWith(
            'http://api.test/api/thing',
            expect.objectContaining({ method: 'GET', credentials: 'include' }),
        )
    })

    it('sets JSON content-type only when a body is present', async () => {
        global.fetch = vi.fn().mockResolvedValue(fakeResponse({ textBody: '' }))
        await apiFetch('/x', { method: 'POST', body: { hi: 1 } })
        const [, opts] = global.fetch.mock.calls[0]
        expect(opts.headers['Content-Type']).toBe('application/json')
        expect(opts.body).toBe('{"hi":1}')
    })

    it('throws with the server-provided detail and status on error', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValue(fakeResponse({ ok: false, status: 400, jsonBody: { detail: 'Bad code' } }))
        await expect(apiFetch('/x')).rejects.toMatchObject({ message: 'Bad code', status: 400 })
    })

    it('falls back to a generic message when the error body is not JSON', async () => {
        global.fetch = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 500 }))
        await expect(apiFetch('/x')).rejects.toMatchObject({ message: 'Request failed: 500', status: 500 })
    })
})

// --- openSimulationSocket ---------------------------------------------------
class MockWebSocket {
    static instances = []
    constructor(url) {
        this.url = url
        this.close = vi.fn()
        MockWebSocket.instances.push(this)
    }
    emitOpen() {
        this.onopen?.()
    }
    emitMessage(data) {
        this.onmessage?.({ data })
    }
    emitClose(code = 1006) {
        this.onclose?.({ code })
    }
}

describe('openSimulationSocket', () => {
    beforeEach(() => {
        MockWebSocket.instances = []
        global.WebSocket = MockWebSocket
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('derives a ws:// URL from the http API base', () => {
        const close = openSimulationSocket('/api/simulations/r1/live', { onState: vi.fn(), onExpired: vi.fn() })
        expect(MockWebSocket.instances[0].url).toBe('ws://api.test/api/simulations/r1/live')
        close()
    })

    it('invokes onState with parsed state messages', () => {
        const onState = vi.fn()
        const close = openSimulationSocket('/live', { onState, onExpired: vi.fn() })
        MockWebSocket.instances[0].emitMessage(JSON.stringify({ type: 'state', data: { runId: 'r1' } }))
        expect(onState).toHaveBeenCalledWith({ runId: 'r1' })
        close()
    })

    it('invokes onExpired on an expired message', () => {
        const onExpired = vi.fn()
        const close = openSimulationSocket('/live', { onState: vi.fn(), onExpired })
        MockWebSocket.instances[0].emitMessage(JSON.stringify({ type: 'expired' }))
        expect(onExpired).toHaveBeenCalled()
        close()
    })

    it('ignores malformed messages without throwing', () => {
        const onState = vi.fn()
        const close = openSimulationSocket('/live', { onState, onExpired: vi.fn() })
        expect(() => MockWebSocket.instances[0].emitMessage('not json')).not.toThrow()
        expect(onState).not.toHaveBeenCalled()
        close()
    })

    it('reconnects after an unexpected close', () => {
        const close = openSimulationSocket('/live', { onState: vi.fn(), onExpired: vi.fn() })
        MockWebSocket.instances[0].emitClose(1006)
        vi.advanceTimersByTime(1000)
        expect(MockWebSocket.instances.length).toBe(2)
        close()
    })

    it('does not reconnect after the caller closes it', () => {
        const close = openSimulationSocket('/live', { onState: vi.fn(), onExpired: vi.fn() })
        close()
        MockWebSocket.instances[0].emitClose(1006)
        vi.advanceTimersByTime(30000)
        expect(MockWebSocket.instances.length).toBe(1)
    })

    it('does not reconnect after the run expires', () => {
        const close = openSimulationSocket('/live', { onState: vi.fn(), onExpired: vi.fn() })
        MockWebSocket.instances[0].emitMessage(JSON.stringify({ type: 'expired' }))
        MockWebSocket.instances[0].emitClose(1006)
        vi.advanceTimersByTime(30000)
        expect(MockWebSocket.instances.length).toBe(1)
        close()
    })
})
