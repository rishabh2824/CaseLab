import { useNavigate } from '@tanstack/react-router'
import chevron from '../../assets/Chevron.webp'

function CreateCase() {
    const navigate = useNavigate()

    return (
        <div className="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
            <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
            <img
                src={chevron}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-32 -right-32 z-0 w-[34rem] max-w-none select-none opacity-[0.14]"
            />
            <div className="relative z-10 mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
                <div className="max-w-2xl">
                    <div className="flex items-center gap-3">
                        <span className="h-px w-8 bg-line" />
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
                            Create Case
                        </p>
                    </div>
                    <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
                        How do you want to begin?
                    </h1>
                    <p className="mt-4 max-w-xl text-sm leading-6 text-stone">
                        Start with a blank case builder or reuse an existing case as the base for a
                        new one.
                    </p>
                </div>

                <div className="mt-12 grid gap-6 md:grid-cols-2">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/new/scratch' })}
                        className="group rounded-3xl border border-line bg-white p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
                    >
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-brand">
                            Option 1
                        </p>
                        <h2 className="mt-4 font-display text-2xl font-semibold text-ink">
                            Start From Scratch
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-stone">
                            Open the empty case form and build everything from the ground up.
                        </p>
                        <div className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand">
                            Open blank form
                            <span aria-hidden="true">&rarr;</span>
                        </div>
                    </button>

                    <button
                        type="button"
                        onClick={() => navigate({ to: '/admin/new/template' })}
                        className="group rounded-3xl border border-line bg-cream p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
                    >
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                            Option 2
                        </p>
                        <h2 className="mt-4 font-display text-2xl font-semibold text-ink">
                            Use Existing Case As Template
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-stone">
                            Choose an existing case and preload its details into a new-case form.
                        </p>
                        <div className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand">
                            Choose a case
                            <span aria-hidden="true">&rarr;</span>
                        </div>
                    </button>
                </div>
            </div>
        </div>
    )
}

export default CreateCase
