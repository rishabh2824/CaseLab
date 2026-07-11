// Pure data-shaping helpers for the case form — no closure over component
// state, so they're stable references usable outside any hook dependency list.

// Shape mirrors the API 1:1 (snake_case) except `file_count`/
// `referral_out_count` here and `name` in createEmptyReferral below — those
// three are client-form-only (UI counters / the referral's own display
// label); caseForm.jsx strips them before building the submit payload, since
// the backend ignores/recomputes them.
export const createEmptyPersona = (overrides = {}) => ({
    name: '',
    role: '',
    profile_photo: null,
    known_facts: '',
    unknown_facts: '',
    hidden_facts: '',
    personality_traits: '',
    availability_minutes: null,
    scheduled_after_minutes: null,
    file_count: null,
    files: [],
    referral_out_count: null,
    referrals: [],
    ...overrides,
})

export const createEmptyReferral = (overrides = {}) => ({
    name: '',
    trigger_type: null,
    conditions: '',
    reveal_delay_minutes: null,
    persona: createEmptyPersona(),
    ...overrides,
})

export const normalizePersona = (persona) => ({
    ...createEmptyPersona(),
    ...(persona ?? {}),
    files: persona?.files ?? [],
    referrals: persona?.referrals ?? [],
})

export const normalizeReferral = (referral) => ({
    ...createEmptyReferral(),
    ...(referral ?? {}),
    persona: normalizePersona(referral?.persona),
})

export const getPersonaLabel = (persona, fallback) => {
    const trimmed = persona.name.trim()
    return trimmed.length > 0 ? trimmed : fallback
}

// Flattens every referred persona (at any depth) across all root `personas`
// into a single list of { path, persona, label, parentLabel } entries, for
// rendering one accordion item each. Walks the RAW referral tree (not a
// normalized copy) so each step's persona/referral objects are the actual
// state references — required for `getNormalizedPersona`/
// `getNormalizedReferral`'s caches (see caseForm.jsx) to hit for anything
// Immer didn't touch this render. Takes those normalize functions as
// parameters rather than importing normalizePersona/normalizeReferral
// directly so it stays swappable and testable in isolation.
export const collectReferredPersonas = (
    personas,
    { getNormalizedPersona, getNormalizedReferral, getPersonaLabel: labelFor },
) => {
    const referredItems = []

    const walk = (currentPersonaRaw, path, parentLabel) => {
        const rawReferrals = currentPersonaRaw?.referrals ?? []
        rawReferrals.forEach((referralRaw, referralIndex) => {
            const normalizedReferral = getNormalizedReferral(referralRaw)
            const childPath = [...path, referralIndex]
            const referralLabel = labelFor({ name: normalizedReferral.name }, 'Referred Persona')
            referredItems.push({
                path: childPath,
                persona: normalizedReferral.persona,
                label: referralLabel,
                parentLabel,
            })
            const childLabel = labelFor(normalizedReferral.persona, 'Referred Persona')
            walk(referralRaw?.persona, childPath, childLabel)
        })
    }

    personas.forEach((persona, index) => {
        const baseLabel = labelFor(getNormalizedPersona(persona), `Persona ${index + 1}`)
        walk(persona, [index], baseLabel)
    })

    return referredItems
}
