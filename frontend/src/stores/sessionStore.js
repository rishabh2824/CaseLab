import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// Centralized session state.
export const useSessionStore = create(
    persist(
        (set, get) => ({
            adminToken: '',
            runId: '',
            accessCode: '',
            bootstrap: null,
            startTime: null,

            setAdminToken: (token) => set({ adminToken: token }),

            // Called when a student simulation starts. `bootstrap` is the full
            // start-response payload, consumed once by StudentHome.
            startRun: ({ runId, accessCode, bootstrap, startTime }) =>
                set({
                    runId: runId ?? '',
                    accessCode: accessCode ?? '',
                    bootstrap: bootstrap ?? null,
                    startTime: startTime ?? Date.now(),
                }),

            setRunId: (runId) => set({ runId }),

            // Read the bootstrap payload exactly once, then clear it.
            consumeBootstrap: () => {
                const { bootstrap } = get()
                if (bootstrap) set({ bootstrap: null })
                return bootstrap
            },

            // Clear a student run (keeps adminToken).
            clearRun: () => set({ runId: '', accessCode: '', bootstrap: null, startTime: null }),

            // Clear everything (logout).
            clearAll: () =>
                set({
                    adminToken: '',
                    runId: '',
                    accessCode: '',
                    bootstrap: null,
                    startTime: null,
                }),
        }),
        {
            name: 'caseLabSession',
            storage: createJSONStorage(() => sessionStorage),
        },
    ),
)
