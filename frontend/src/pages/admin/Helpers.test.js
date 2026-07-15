import { describe, expect, it } from 'vitest'
import {
    collectReferredPersonas,
    createEmptyPersona,
    getPersonaFieldErrors,
    getPersonaLabel,
    hasFieldErrors,
    normalizePersona,
} from './Helpers.js'

describe('getPersonaFieldErrors', () => {
    it('flags missing name and role', () => {
        const errors = getPersonaFieldErrors(createEmptyPersona())
        expect(errors.name).toBeTruthy()
        expect(errors.role).toBeTruthy()
    })

    it('passes a fully-specified persona', () => {
        const errors = getPersonaFieldErrors(
            createEmptyPersona({ name: 'Mary', role: 'CFO', availability_minutes: 30 }),
        )
        expect(errors).toEqual({})
    })

    it('rejects availability below one minute', () => {
        const errors = getPersonaFieldErrors(
            createEmptyPersona({ name: 'Mary', role: 'CFO', availability_minutes: 0 }),
        )
        expect(errors.availability).toBeTruthy()
    })

    it('rejects negative counts', () => {
        const errors = getPersonaFieldErrors(
            createEmptyPersona({ name: 'M', role: 'R', file_count: -1, referral_out_count: -2 }),
        )
        expect(errors.fileCount).toBeTruthy()
        expect(errors.referralOutCount).toBeTruthy()
    })
})

describe('hasFieldErrors', () => {
    it('is false for an empty error object', () => {
        expect(hasFieldErrors({})).toBe(false)
    })

    it('is true when any error is present', () => {
        expect(hasFieldErrors({ name: 'Name is required.' })).toBe(true)
    })
})

describe('getPersonaLabel', () => {
    it('uses the trimmed name when present', () => {
        expect(getPersonaLabel({ name: '  Mary  ' }, 'fallback')).toBe('Mary')
    })

    it('falls back when name is blank', () => {
        expect(getPersonaLabel({ name: '   ' }, 'Persona 1')).toBe('Persona 1')
    })
})

describe('normalizePersona', () => {
    it('fills defaults and preserves arrays', () => {
        const p = normalizePersona({ name: 'X', files: [{ a: 1 }] })
        expect(p.name).toBe('X')
        expect(p.role).toBe('')
        expect(p.files).toEqual([{ a: 1 }])
        expect(p.referrals).toEqual([])
    })

    it('handles null input', () => {
        expect(normalizePersona(null)).toMatchObject({ name: '', role: '', files: [], referrals: [] })
    })
})

describe('collectReferredPersonas', () => {
    it('returns an empty list when there are no referrals', () => {
        expect(collectReferredPersonas([createEmptyPersona({ name: 'Root' })])).toEqual([])
    })

    it('flattens a nested referral tree depth-first with paths and parent labels', () => {
        const tree = [
            createEmptyPersona({
                name: 'Root',
                referrals: [
                    {
                        name: 'Child',
                        persona: createEmptyPersona({
                            name: 'Child',
                            referrals: [{ name: 'Grandchild', persona: createEmptyPersona({ name: 'Grandchild' }) }],
                        }),
                    },
                ],
            }),
        ]
        const items = collectReferredPersonas(tree)
        expect(items.map((i) => i.label)).toEqual(['Child', 'Grandchild'])
        expect(items[0].path).toEqual([0, 0])
        expect(items[0].parentLabel).toBe('Root')
        expect(items[1].path).toEqual([0, 0, 0])
        expect(items[1].parentLabel).toBe('Child')
    })

    it('labels unnamed referrals with the generic fallback', () => {
        const tree = [
            createEmptyPersona({
                name: 'Root',
                referrals: [{ name: '', persona: createEmptyPersona() }],
            }),
        ]
        expect(collectReferredPersonas(tree)[0].label).toBe('Referred Persona')
    })
})
