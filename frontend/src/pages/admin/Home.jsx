import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { apiFetch } from '../../client.js'
import { ADMIN_ROLE } from '../../constants.js'
import { useSessionStore } from '../../hooks/sessionStore.js'
import chevron from '../../assets/Chevron.webp'

function Home() {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const adminRole = useSessionStore((s) => s.adminRole)
    const clearAdmin = useSessionStore((s) => s.clearAdmin)

    const handleSignOut = async () => {
        queryClient.clear()
        clearAdmin()
        navigate({ to: '/' })
        try {
            await apiFetch('/api/admin/logout', { method: 'POST' })
        } catch {
            // best-effort — the cookie will simply expire on its own otherwise
        }
    }

    return (
        <div className="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
            <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
            <img
                src={chevron}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-32 -right-32 z-0 w-[34rem] max-w-none select-none opacity-[0.14]"
            />
            <button
                type="button"
                onClick={handleSignOut}
                className="fixed bottom-6 left-6 z-10 rounded-xl border border-line bg-white px-5 py-3 text-sm font-semibold text-stone shadow-soft transition hover:border-ink hover:text-ink"
            >
                Sign out
            </button>

            {adminRole === ADMIN_ROLE.SUPER && (
                <button
                    type="button"
                    onClick={() => navigate({ to: '/admin/admins' })}
                    // Deliberately NOT top-6/right-6 (the landing page's Admin
                    // Login button sits there, sm:top-12 sm:right-20) — if the
                    // two buttons shared fixed coordinates, the cursor would
                    // still be resting on Admin Login when this one mounts
                    // right underneath it post-navigation, so the browser
                    // never fires a mousemove/hover on it until the pointer
                    // is nudged. Pushed below that button's footprint instead.
                    className="fixed right-6 top-24 z-10 rounded-full border border-line bg-white px-6 py-3 text-sm font-semibold text-brand shadow-soft transition hover:border-brand hover:bg-brand-tint sm:right-10 sm:top-28"
                >
                    Manage admins
                </button>
            )}

            <div className="relative z-10 mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
                <div className="max-w-2xl">
                    <div className="flex items-center gap-3">
                        <span className="h-px w-8 bg-line" />
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
                            Admin Panel
                        </p>
                    </div>
                    <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
                        Choose what you want to work on
                    </h1>
                    <p className="mt-4 max-w-xl text-sm leading-6 text-stone">
                        Create a new simulation case from scratch or open an existing case for
                        editing.
                    </p>
                </div>

                <div className="mt-12 grid gap-6 md:grid-cols-2">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/new' })}
                        className="group rounded-3xl border border-line bg-white p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
                    >
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-brand">
                            Option 1
                        </p>
                        <h2 className="mt-4 font-display text-2xl font-semibold text-ink">
                            Create New Case
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-stone">
                            Start a fresh case setup, define personas, referral logic, and upload
                            files.
                        </p>
                        <div className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand">
                            Open case builder
                            <span aria-hidden="true">&rarr;</span>
                        </div>
                    </button>

                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/edit' })}
                        className="group rounded-3xl border border-line bg-cream p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
                    >
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                            Option 2
                        </p>
                        <h2 className="mt-4 font-display text-2xl font-semibold text-ink">
                            Edit Existing Case
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-stone">
                            Load an existing case and update its setup, personas, or supporting
                            materials.
                        </p>
                        <div className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand">
                            Open case list
                            <span aria-hidden="true">&rarr;</span>
                        </div>
                    </button>
                </div>
            </div>
        </div>
    )
}

export default Home
