// Pure data-shaping helpers for the case form — no closure over component
// state, so they're stable references usable outside any hook dependency list.

export const createEmptyPersona = (overrides = {}) => ({
    name: '',
    role: '',
    profilePhoto: null,
    knownFacts: '',
    unknownFacts: '',
    hiddenFacts: '',
    personalityTraits: '',
    availabilityMinutes: null,
    scheduledAfterMinutes: null,
    fileCount: null,
    files: [],
    referralOutCount: null,
    referrals: [],
    ...overrides,
})

export const createEmptyReferral = (overrides = {}) => ({
    name: '',
    triggerType: null,
    conditions: '',
    revealDelayMinutes: null,
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
