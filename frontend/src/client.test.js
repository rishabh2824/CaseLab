import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from './client.js'

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
