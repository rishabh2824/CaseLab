import { useNavigate } from '@tanstack/react-router'

function CreateCase() {
    const navigate = useNavigate()

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6 py-10">
            <div className="mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
                <div className="max-w-2xl">
                    <p
                        className="text-sm font-semibold uppercase tracking-[0.24em] text-[#5b5fc7] font-display"
                    >
                        Create Case
                    </p>
                    <h1
                        className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl font-display"
                    >
                        How do you want to begin?
                    </h1>
                    <p className="mt-4 max-w-xl text-sm leading-6 text-slate-500">
                        Start with a blank case builder or reuse an existing case as the base for a
                        new one.
                    </p>
                </div>

                <div className="mt-12 grid gap-6 md:grid-cols-2">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/new/scratch' })}
                        className="group rounded-3xl border border-[#d6d9ff] bg-white p-8 text-left shadow-sm transition hover:-translate-y-1 hover:border-[#5b5fc7] hover:shadow-lg"
                    >
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#5b5fc7]">
                            Option 1
                        </p>
                        <h2
                            className="mt-4 text-2xl font-semibold text-slate-900 font-display"
                        >
                            Start From Scratch
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-slate-500">
                            Open the empty case form and build everything from the ground up.
                        </p>
                    </button>

                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/new/template' })}
                        className="group rounded-3xl border border-slate-200 bg-[#f8f9ff] p-8 text-left shadow-sm transition hover:-translate-y-1 hover:border-[#5b5fc7] hover:shadow-lg"
                    >
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Option 2
                        </p>
                        <h2
                            className="mt-4 text-2xl font-semibold text-slate-900 font-display"
                        >
                            Use Existing Case As Template
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-slate-500">
                            Choose an existing case and preload its details into a new-case form.
                        </p>
                    </button>
                </div>
            </div>
        </div>
    )
}

export default CreateCase
