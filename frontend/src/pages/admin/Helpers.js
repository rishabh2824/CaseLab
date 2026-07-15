// Pure data-shaping helpers for the case form
export const createEmptyPersona = (overrides = {}) => ({
    name: '',
    role: '',
    profile_photo: null,
    known_facts: '',
    personality_traits: '',
    availability_minutes: null,
    file_count: null,
    files: [],
    referral_out_count: null,
    referrals: [],
    ...overrides,
})

export const createEmptyReferral = (overrides = {}) => ({
    name: '',
    conditions: '',
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

// Field-level validation for one persona
export const getPersonaFieldErrors = (persona) => {
    const errors = {}
    if (!persona.name?.trim()) errors.name = 'Name is required.'
    if (!persona.role?.trim()) errors.role = 'Role is required.'
    if (typeof persona.availability_minutes === 'number' && persona.availability_minutes < 1) {
        errors.availability = 'Must be at least 1 minute.'
    }
    if (typeof persona.file_count === 'number' && persona.file_count < 0) {
        errors.fileCount = 'Cannot be negative.'
    }
    if (typeof persona.referral_out_count === 'number' && persona.referral_out_count < 0) {
        errors.referralOutCount = 'Cannot be negative.'
    }
    return errors
}

export const hasFieldErrors = (errors) => Object.values(errors).some(Boolean)

// Flattens every referred persona across all root `personas` into a single list of
// { path, persona, label, parentLabel } entries, for rendering one accordion item each.
export const collectReferredPersonas = (personas) => {
    const referredItems = []

    const walk = (currentPersona, path, parentLabel) => {
        const referrals = currentPersona?.referrals ?? []
        referrals.forEach((referralRaw, referralIndex) => {
            const referral = normalizeReferral(referralRaw)
            const childPath = [...path, referralIndex]
            const referralLabel = getPersonaLabel({ name: referral.name }, 'Referred Persona')
            referredItems.push({
                path: childPath,
                persona: referral.persona,
                label: referralLabel,
                parentLabel,
            })
            const childLabel = getPersonaLabel(referral.persona, 'Referred Persona')
            walk(referral.persona, childPath, childLabel)
        })
    }

    personas.forEach((persona, index) => {
        const normalized = normalizePersona(persona)
        const baseLabel = getPersonaLabel(normalized, `Persona ${index + 1}`)
        walk(normalized, [index], baseLabel)
    })

    return referredItems
}
