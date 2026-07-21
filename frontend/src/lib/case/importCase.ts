// Imports the autofilled HTML form back into the app
import type { DraftPersona } from '../types.js'

export class CaseImportError extends Error {}

const FIXED_ROOT_ID = 'P1'

type FormFieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

function fieldValue(root: ParentNode, field: string): string {
    const el = root.querySelector(`[data-field="${field}"]`) as FormFieldElement | null
    return el ? el.value : ''
}


function parseNumberField(text: string, label: string, warnings: string[]): number | null {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
        warnings.push(`Couldn't read "${label}" as a number (was "${trimmed}") — left blank for you to fill in.`)
        return null
    }
    return Math.round(parsed)
}


type ParsedPersonaCards = {
    personaOrder: string[]
    personaById: Map<string, DraftPersona>
}

function parsePersonaCards(doc: Document, warnings: string[]): ParsedPersonaCards {
    const cards = Array.from(doc.querySelectorAll('.persona-card[data-persona-id]'))
    const personaOrder: string[] = []
    const personaById = new Map<string, DraftPersona>()

    for (const card of cards) {
        const id = card.getAttribute('data-persona-id')
        if (!id) continue
        if (personaById.has(id)) {
            warnings.push(`Duplicate persona id "${id}" — kept the first one and ignored the rest.`)
            continue
        }
        const canShareFiles = fieldValue(card, 'can_share_files').trim().toLowerCase() === 'yes'
        personaOrder.push(id)
        personaById.set(id, {
            name: fieldValue(card, 'name').trim(),
            role: fieldValue(card, 'role').trim(),
            known_facts: fieldValue(card, 'known_facts').trim(),
            personality_traits: fieldValue(card, 'personality_traits').trim(),
            availability_minutes: parseNumberField(
                fieldValue(card, 'availability_minutes'),
                `${id} availability`,
                warnings,
            ),
            profile_photo: null,
            file_count: canShareFiles ? 1 : null,
            files: canShareFiles ? [{ file: null, share_conditions: '', perceived_contents: '' }] : [],
            referral_out_count: null,
            referrals: [],
        })
    }
    return { personaOrder, personaById }
}


type ReferralEdge = { fromId: string; toId: string; conditions: string }

function parseReferralEdges(doc: Document, personaById: Map<string, DraftPersona>, warnings: string[]): ReferralEdge[] {
    const rows = Array.from(doc.querySelectorAll('.referral-row[data-referral="true"]'))
    const edges: ReferralEdge[] = []

    // A persona can be referred by at most one parent Keep the first edge into any given id, in document order, and
    // drop the rest rather than letting a persona end up duplicated under two parents.
    const referredBy = new Map<string, string>()
    for (const row of rows) {
        const fromId = (row.querySelector('select[data-role="from"]') as HTMLSelectElement | null)?.value
        const toId = (row.querySelector('select[data-role="to"]') as HTMLSelectElement | null)?.value
        const conditions = fieldValue(row, 'conditions').trim()
        if (!fromId || !toId) continue
        if (!personaById.has(fromId) || !personaById.has(toId)) {
            warnings.push(`Skipped a referral (${fromId || '?'} → ${toId || '?'}) — one of the personas wasn't found.`)
            continue
        }
        if (fromId === toId) {
            warnings.push(`Skipped a referral where ${fromId} refers to itself.`)
            continue
        }
        if (referredBy.has(toId)) {
            warnings.push(
                `Skipped a referral (${fromId} → ${toId}) — ${toId} is already referred by ${referredBy.get(toId)}; a persona can only be referred by one parent.`,
            )
            continue
        }
        referredBy.set(toId, fromId)
        edges.push({ fromId, toId, conditions })
    }

    if (personaById.has(FIXED_ROOT_ID)) {
        const before = edges.length
        const kept = edges.filter((edge) => edge.toId !== FIXED_ROOT_ID)
        if (kept.length < before) {
            warnings.push(`${FIXED_ROOT_ID} is always a root persona — removed the referral(s) pointing to it.`)
        }
        return kept
    }
    return edges
}


type PersonaTreeResult = { personas: DraftPersona[]; rootCount: number }

function buildPersonaTree(
    personaOrder: string[],
    personaById: Map<string, DraftPersona>,
    edges: ReferralEdge[],
    warnings: string[],
): PersonaTreeResult {
    const edgesFrom = new Map<string, ReferralEdge[]>()
    for (const edge of edges) {
        const bucket = edgesFrom.get(edge.fromId) ?? []
        bucket.push(edge)
        edgesFrom.set(edge.fromId, bucket)
    }
    const referredIds = new Set(edges.map((edge) => edge.toId))
    const usedIds = new Set<string>()

    function buildNode(id: string, ancestry: Set<string>): DraftPersona {
        usedIds.add(id)
        const base = personaById.get(id)
        if (!base) {
            // Every id passed here comes from personaOrder (built straight off
            // the parsed document) or from an edge.toId that
            // parseReferralEdges already confirmed exists in personaById, so
            // this is unreachable in practice. Throwing here — instead of the
            // old `{ ...personaById.get(id), referrals: [] }`, which silently
            // built a node with every field but `referrals` missing — is what
            // noUncheckedIndexedAccess/strict flags as a genuine
            // undefined-spread once this file is typed.
            throw new CaseImportError(`Internal error: persona "${id}" not found while building the persona tree.`)
        }
        const node: DraftPersona = { ...base, referrals: [] }
        for (const edge of edgesFrom.get(id) ?? []) {
            if (ancestry.has(edge.toId)) {
                warnings.push(`Cycle detected involving ${edge.toId} — that referral was dropped.`)
                continue
            }
            const childAncestry = new Set(ancestry)
            childAncestry.add(edge.toId)
            const childPersona = buildNode(edge.toId, childAncestry)
            node.referrals.push({
                name: childPersona.name,
                conditions: edge.conditions,
                persona: childPersona,
            })
        }
        node.referral_out_count = node.referrals.length > 0 ? node.referrals.length : null
        return node
    }

    const rootIds = personaOrder.filter((id) => !referredIds.has(id))
    const personas = rootIds.map((id) => buildNode(id, new Set([id])))

    for (const id of personaOrder) {
        if (!usedIds.has(id)) {
            const name = personaById.get(id)?.name
            warnings.push(
                `${id}${name ? ` (${name})` : ''} couldn't be placed — it's only reachable through a referral cycle.`,
            )
        }
    }

    return { personas, rootCount: rootIds.length }
}


export type ImportedCaseData = {
    caseName: string
    accessCode: string
    simulationDurationMinutes: number | null
    initialBrief: string
    commonInformation: string
    totalPersonas: number
    personas: DraftPersona[]
}

export type ParsedHTMLForm = {
    data: ImportedCaseData
    warnings: string[]
}

export function parseHTMLForm(htmlText: string): ParsedHTMLForm {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html')
    if (!doc.getElementById('personas-list') || !doc.getElementById('referrals-list')) {
        throw new CaseImportError("This doesn't look like a Case Lab import file.")
    }

    const warnings: string[] = []
    const caseName = fieldValue(doc, 'case_name').trim()
    const accessCode = fieldValue(doc, 'access_code').trim()
    const initialBrief = fieldValue(doc, 'initial_brief').trim()
    const commonInformation = fieldValue(doc, 'common_information').trim()
    const simulationDurationMinutes = parseNumberField(
        fieldValue(doc, 'simulation_duration_minutes'),
        'Simulation duration',
        warnings,
    )

    const { personaOrder, personaById } = parsePersonaCards(doc, warnings)
    if (personaOrder.length === 0) {
        throw new CaseImportError('No personas found in this file — add at least one before importing.')
    }
    const edges = parseReferralEdges(doc, personaById, warnings)
    const { personas, rootCount } = buildPersonaTree(personaOrder, personaById, edges, warnings)
    if (rootCount === 0) {
        throw new CaseImportError('This file has no root personas — every persona is referred.')
    }

    return {
        data: {
            caseName,
            accessCode,
            simulationDurationMinutes,
            initialBrief,
            commonInformation,
            totalPersonas: rootCount,
            personas,
        },
        warnings,
    }
}
