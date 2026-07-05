// Pure data-shaping helpers — no component state, no React.

// Lowercase, replace runs of non-alphanumerics with a single '-', trim '-'.
export const slugify = (value) =>
    String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')

export const normalizeMessages = (messages = []) =>
    (messages ?? []).filter(
        (message) =>
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string',
    )

export const normalizeHistories = (histories = {}) =>
    Object.fromEntries(
        Object.entries(histories).map(([personaId, messages]) => [
            personaId,
            normalizeMessages(messages),
        ]),
    )

const getPersonaInitials = (name) =>
    name
        ? name
              .split(' ')
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0].toUpperCase())
              .join('')
        : 'NA'

export const mapContact = (persona) => {
    const scheduled = typeof persona.scheduled_time === 'number' ? persona.scheduled_time : 0
    const availability = persona.availability_duration
    let status = 'Available'
    if (scheduled && scheduled > 0) {
        status = `Available in ${scheduled} min`
    }
    return {
        id: persona.id,
        initials: getPersonaInitials(persona.name),
        name: persona.name || 'Unnamed',
        title: persona.role || 'Role',
        profilePhotoUrl: persona.profile_photo?.url || persona.profilePhoto?.url || null,
        status,
        availability,
        isReferred: persona.is_referred ?? false,
        available: persona.available ?? false,
        availableIn: persona.available_in ?? null,
        expiresIn: persona.expires_in ?? null,
        chatEnded: persona.chat_ended ?? false,
        chatEndReason: persona.chat_end_reason ?? null,
        warningCount: persona.warning_count ?? 0,
    }
}
