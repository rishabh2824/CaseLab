import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ADMIN_ROLE } from '../../constants.js'
import { useSessionStore } from '../../hooks/sessionStore.js'

function Home() {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const adminEmail = useSessionStore((s) => s.adminEmail)
    const adminRole = useSessionStore((s) => s.adminRole)
    const clearAdmin = useSessionStore((s) => s.clearAdmin)

    const handleSignOut = () => {
        // ['cases']/['admins'] aren't keyed by admin identity — without this,
        // the next admin to sign in on this device/tab could flash the
        // previous admin's case list before their own fetch completes.
        queryClient.clear()
        clearAdmin()
        navigate({ to: '/' })
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6 py-10">
            <div className="mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-slate-400">
                        Signed in as{' '}
                        <span className="font-medium text-slate-600">{adminEmail}</span>
                    </p>
                    <div className="flex items-center gap-4">
                        {adminRole === ADMIN_ROLE.SUPER && (
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/admin/admins' })}
                                className="text-sm font-semibold text-[#5b5fc7] transition hover:text-[#4548a0]"
                            >
                                Manage admins
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={handleSignOut}
                            className="text-sm font-semibold text-slate-500 transition hover:text-slate-700"
                        >
                            Sign out
                        </button>
                    </div>
                </div>
                <div className="max-w-2xl">
                    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#5b5fc7] font-display">
                        Admin Panel
                    </p>
                    <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl font-display">
                        Choose what you want to work on
                    </h1>
                    <p className="mt-4 max-w-xl text-sm leading-6 text-slate-500">
                        Create a new simulation case from scratch or open an existing case for
                        editing.
                    </p>
                </div>

                <div className="mt-12 grid gap-6 md:grid-cols-2">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/new' })}
                        className="group rounded-3xl border border-[#d6d9ff] bg-white p-8 text-left shadow-sm transition hover:-translate-y-1 hover:border-[#5b5fc7] hover:shadow-lg"
                    >
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#5b5fc7]">
                            Option 1
                        </p>
                        <h2 className="mt-4 text-2xl font-semibold text-slate-900 font-display">
                            Create New Case
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-slate-500">
                            Start a fresh case setup, define personas, referral logic, and upload
                            files.
                        </p>
                        <div className="mt-8 text-sm font-semibold text-slate-700 transition group-hover:text-[#5b5fc7]">
                            Open case builder
                        </div>
                    </button>

                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/edit' })}
                        className="group rounded-3xl border border-slate-200 bg-[#f8f9ff] p-8 text-left shadow-sm transition hover:-translate-y-1 hover:border-[#5b5fc7] hover:shadow-lg"
                    >
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Option 2
                        </p>
                        <h2 className="mt-4 text-2xl font-semibold text-slate-900 font-display">
                            Edit Existing Case
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-slate-500">
                            Load an existing case and update its setup, personas, or supporting
                            materials.
                        </p>
                        <div className="mt-8 text-sm font-semibold text-slate-700 transition group-hover:text-[#5b5fc7]">
                            Open case list
                        </div>
                    </button>
                </div>
            </div>
        </div>
    )
}

export default Home
