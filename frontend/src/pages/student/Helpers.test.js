import { describe, expect, it } from 'vitest'
import {
    countWords,
    mapContact,
    normalizeHistories,
    normalizeMessages,
    slugify,
} from './Helpers.js'

describe('slugify', () => {
    it('lowercases and dashes non-alphanumerics', () => {
        expect(slugify('Sterling Industries')).toBe('sterling-industries')
    })

    it('collapses runs of separators into one dash', () => {
        expect(slugify('a  --  b')).toBe('a-b')
    })

    it('trims leading and trailing dashes', () => {
        expect(slugify('  !Hello!  ')).toBe('hello')
    })

    it('handles null/undefined as empty string', () => {
        expect(slugify(null)).toBe('')
        expect(slugify(undefined)).toBe('')
    })
})

describe('countWords', () => {
    it('counts whitespace-separated words', () => {
        expect(countWords('hello there world')).toBe(3)
    })

    it('is zero for empty and whitespace-only', () => {
        expect(countWords('')).toBe(0)
        expect(countWords('   ')).toBe(0)
    })

    it('ignores extra internal whitespace', () => {
        expect(countWords('a    b')).toBe(2)
    })

    it('treats null/undefined as zero', () => {
        expect(countWords(null)).toBe(0)
        expect(countWords(undefined)).toBe(0)
    })
})

describe('normalizeMessages', () => {
    it('keeps only user/assistant messages with string content', () => {
        const input = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'system', content: 'sys' },
            { role: 'user', content: 42 },
        ]
        expect(normalizeMessages(input)).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ])
    })

    it('handles missing/nullish input', () => {
        expect(normalizeMessages()).toEqual([])
        expect(normalizeMessages(null)).toEqual([])
    })
})

describe('normalizeHistories', () => {
    it('normalizes each persona history', () => {
        const input = {
            p1: [{ role: 'user', content: 'a' }, { role: 'system', content: 'x' }],
            p2: [{ role: 'assistant', content: 'b' }],
        }
        expect(normalizeHistories(input)).toEqual({
            p1: [{ role: 'user', content: 'a' }],
            p2: [{ role: 'assistant', content: 'b' }],
        })
    })

    it('handles empty input', () => {
        expect(normalizeHistories()).toEqual({})
    })
})

describe('mapContact', () => {
    const base = {
        id: 'p1',
        name: 'Mary Jane',
        role: 'CFO',
        availability_duration: 30,
        available: true,
    }

    it('derives two-letter initials from the name', () => {
        expect(mapContact(base).initials).toBe('MJ')
    })

    it('falls back to NA initials when name is missing', () => {
        expect(mapContact({ ...base, name: '' }).initials).toBe('NA')
    })

    it('defaults display fields when absent', () => {
        const c = mapContact({ id: 'p2' })
        expect(c.name).toBe('Unnamed')
        expect(c.title).toBe('Role')
        expect(c.available).toBe(false)
        expect(c.isReferred).toBe(false)
        expect(c.warningCount).toBe(0)
        expect(c.profilePhotoUrl).toBeNull()
    })

    it('maps snake_case server fields to camelCase', () => {
        const c = mapContact({
            ...base,
            is_referred: true,
            available_in: 5,
            expires_in: 10,
            chat_ended: true,
            chat_end_reason: 'nonsense',
            warning_count: 2,
            profile_photo: { url: 'http://x/p.png' },
        })
        expect(c).toMatchObject({
            isReferred: true,
            availableIn: 5,
            expiresIn: 10,
            chatEnded: true,
            chatEndReason: 'nonsense',
            warningCount: 2,
            profilePhotoUrl: 'http://x/p.png',
        })
    })
})
