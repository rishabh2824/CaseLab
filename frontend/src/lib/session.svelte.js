import { browser } from '$app/environment'

// Centralized session state Persisted to sessionStorage so a student run survives reload
const STORAGE_KEY = 'caseLabSession'

const defaults = Object.freeze({
    adminRole: null,
    adminEmail: '',
    runId: '',
    accessCode: '',
    startTime: null,
})

function readPersisted() {
    if (!browser) return defaults
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        return raw ? { ...defaults, ...JSON.parse(raw) } : defaults
    } catch {
        return defaults
    }
}

const initial = readPersisted()

class SessionStore {
    adminRole = $state(initial.adminRole)
    adminEmail = $state(initial.adminEmail)
    runId = $state(initial.runId)
    accessCode = $state(initial.accessCode)
    startTime = $state(initial.startTime)

    #persist() {
        if (!browser) return
        sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                adminRole: this.adminRole,
                adminEmail: this.adminEmail,
                runId: this.runId,
                accessCode: this.accessCode,
                startTime: this.startTime,
            }),
        )
    }

    setAdmin({ adminRole, adminEmail }) {
        this.adminRole = adminRole ?? null
        this.adminEmail = adminEmail ?? ''
        this.#persist()
    }

    // Called when a student simulation starts
    startRun({ runId, accessCode, startTime }) {
        this.runId = runId ?? ''
        this.accessCode = accessCode ?? ''
        this.startTime = startTime ?? Date.now()
        this.#persist()
    }

    setRunId(runId) {
        this.runId = runId
        this.#persist()
    }

    // Clear a student run (keeps admin session).
    clearRun() {
        this.runId = ''
        this.accessCode = ''
        this.startTime = null
        this.#persist()
    }

    // Clear the admin UI state
    clearAdmin() {
        this.adminRole = null
        this.adminEmail = ''
        this.#persist()
    }

    // Clear everything.
    clearAll() {
        this.adminRole = null
        this.adminEmail = ''
        this.runId = ''
        this.accessCode = ''
        this.startTime = null
        this.#persist()
    }
}

export const session = new SessionStore()
