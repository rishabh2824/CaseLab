import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// Centralized session state.
export const useSessionStore = create(
    persist(
        (set) => ({
            // Admin session: set by AdminGoogleSignInButton after
            // POST /api/admin/login succeeds. adminJwt is sent as
            // `Authorization: Bearer <adminJwt>` on admin/write requests (see
            // client.js). adminRole is 1 (super admin) or 2 (admin), matching
            // the `admins.role` CHECK constraint.
            adminJwt: '',
            adminRole: null,
            adminEmail: '',
            runId: '',
            accessCode: '',
            startTime: null,

            setAdmin: ({ adminJwt, adminRole, adminEmail }) =>
                set({
                    adminJwt: adminJwt ?? '',
                    adminRole: adminRole ?? null,
                    adminEmail: adminEmail ?? '',
                }),

            // Called when a student simulation starts. Only the run id/access
            // code/start time are persisted — NOT the full /start response.
            // useSimulationRun's mount effect re-fetches the run's state via a
            // plain GET, so there's no need to smuggle the whole payload
            // through sessionStorage (quota pressure, and staleness if the
            // page is refreshed before it's "consumed").
            startRun: ({ runId, accessCode, startTime }) =>
                set({
                    runId: runId ?? '',
                    accessCode: accessCode ?? '',
                    startTime: startTime ?? Date.now(),
                }),

            setRunId: (runId) => set({ runId }),

            // Clear a student run (keeps admin session).
            clearRun: () => set({ runId: '', accessCode: '', startTime: null }),

            // Clear the admin session only (logout from the admin area).
            clearAdmin: () => set({ adminJwt: '', adminRole: null, adminEmail: '' }),

            // Clear everything.
            clearAll: () =>
                set({
                    adminJwt: '',
                    adminRole: null,
                    adminEmail: '',
                    runId: '',
                    accessCode: '',
                    startTime: null,
                }),
        }),
        {
            name: 'caseLabSession',
            storage: createJSONStorage(() => sessionStorage),
        },
    ),
)
