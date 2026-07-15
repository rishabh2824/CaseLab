import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from './sessionStore.js'

const reset = () => useSessionStore.getState().clearAll()

describe('sessionStore', () => {
    beforeEach(reset)

    it('has empty defaults', () => {
        const s = useSessionStore.getState()
        expect(s.adminRole).toBeNull()
        expect(s.runId).toBe('')
        expect(s.accessCode).toBe('')
        expect(s.startTime).toBeNull()
    })

    it('setAdmin stores role and email', () => {
        useSessionStore.getState().setAdmin({ adminRole: 'super', adminEmail: 'a@wisc.edu' })
        expect(useSessionStore.getState().adminRole).toBe('super')
        expect(useSessionStore.getState().adminEmail).toBe('a@wisc.edu')
    })

    it('startRun seeds run fields', () => {
        useSessionStore.getState().startRun({ runId: 'r1', accessCode: 'code', startTime: 123 })
        const s = useSessionStore.getState()
        expect(s.runId).toBe('r1')
        expect(s.accessCode).toBe('code')
        expect(s.startTime).toBe(123)
    })

    it('startRun defaults startTime to now when omitted', () => {
        const before = Date.now()
        useSessionStore.getState().startRun({ runId: 'r1', accessCode: 'code' })
        expect(useSessionStore.getState().startTime).toBeGreaterThanOrEqual(before)
    })

    it('clearRun wipes the run but keeps the admin session', () => {
        useSessionStore.getState().setAdmin({ adminRole: 'super', adminEmail: 'a@wisc.edu' })
        useSessionStore.getState().startRun({ runId: 'r1', accessCode: 'code', startTime: 1 })
        useSessionStore.getState().clearRun()
        const s = useSessionStore.getState()
        expect(s.runId).toBe('')
        expect(s.accessCode).toBe('')
        expect(s.startTime).toBeNull()
        expect(s.adminRole).toBe('super') // admin session preserved
    })

    it('clearAdmin wipes admin but keeps the run', () => {
        useSessionStore.getState().setAdmin({ adminRole: 'super', adminEmail: 'a@wisc.edu' })
        useSessionStore.getState().startRun({ runId: 'r1', accessCode: 'code', startTime: 1 })
        useSessionStore.getState().clearAdmin()
        const s = useSessionStore.getState()
        expect(s.adminRole).toBeNull()
        expect(s.runId).toBe('r1') // run preserved
    })

    it('clearAll wipes everything', () => {
        useSessionStore.getState().setAdmin({ adminRole: 'super', adminEmail: 'a@wisc.edu' })
        useSessionStore.getState().startRun({ runId: 'r1', accessCode: 'code', startTime: 1 })
        useSessionStore.getState().clearAll()
        expect(useSessionStore.getState()).toMatchObject({
            adminRole: null,
            adminEmail: '',
            runId: '',
            accessCode: '',
            startTime: null,
        })
    })
})
