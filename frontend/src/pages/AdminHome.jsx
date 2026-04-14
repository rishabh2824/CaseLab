import { useNavigate } from 'react-router-dom'

function AdminHome() {
    const navigate = useNavigate()

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6 py-10">
            <div className="mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
                <div className="max-w-2xl">
                    <p
                        className="text-sm font-semibold uppercase tracking-[0.24em] text-[#5b5fc7]"
                        style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                    >
                        Admin Panel
                    </p>
                    <h1
                        className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl"
                        style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                    >
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
                        onClick={() => navigate('/admin/new')}
                        className="group rounded-3xl border border-[#d6d9ff] bg-white p-8 text-left shadow-sm transition hover:-translate-y-1 hover:border-[#5b5fc7] hover:shadow-lg"
                    >
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#5b5fc7]">
                            Option 1
                        </p>
                        <h2
                            className="mt-4 text-2xl font-semibold text-slate-900"
                            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                        >
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
                        onClick={() => navigate('/admin/edit')}
                        className="group rounded-3xl border border-slate-200 bg-[#f8f9ff] p-8 text-left shadow-sm transition hover:-translate-y-1 hover:border-[#5b5fc7] hover:shadow-lg"
                    >
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Option 2
                        </p>
                        <h2
                            className="mt-4 text-2xl font-semibold text-slate-900"
                            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                        >
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

export default AdminHome
