import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// Centralized session state.
export const useSessionStore = create(
    persist(
        (set) => ({
            adminRole: null,
            adminEmail: '',
            runId: '',
            accessCode: '',
            startTime: null,

            setAdmin: ({ adminRole, adminEmail }) => set({adminRole: adminRole ?? null, adminEmail: adminEmail ?? ''}),

            // Called when a student simulation starts
            startRun: ({ runId, accessCode, startTime }) =>
                set({runId: runId ?? '', accessCode: accessCode ?? '', startTime: startTime ?? Date.now()}),

            setRunId: (runId) => set({ runId }),

            // Clear a student run (keeps admin session).
            clearRun: () => set({ runId: '', accessCode: '', startTime: null }),

            // Clear the admin UI state
            clearAdmin: () => set({ adminRole: null, adminEmail: '' }),

            // Clear everything.
            clearAll: () => set({adminRole: null, adminEmail: '', runId: '', accessCode: '', startTime: null})
        }),
        {name: 'caseLabSession', storage: createJSONStorage(() => sessionStorage)},
    ),
)
