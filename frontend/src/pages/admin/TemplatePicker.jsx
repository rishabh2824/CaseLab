import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { apiFetch } from '../../client.js'
import { useSessionStore } from '../../hooks/sessionStore.js'

function TemplatePicker({ mode = 'template' }) {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const adminJwt = useSessionStore((s) => s.adminJwt)

    const {
        data,
        isLoading: loading,
        error: queryError,
    } = useQuery({
        queryKey: ['cases'],
        queryFn: () => apiFetch('/api/cases', { adminJwt }),
    })

    const cases = data?.cases ?? []
    const error = queryError ? queryError.message || 'Failed to load cases.' : ''

    // Delete is only offered in edit mode (managing existing cases) — the
    // backend is the real gate: an admin may delete their own cases, a super
    // admin any case (see case_service._authorize_case_access).
    const deleteMutation = useMutation({
        mutationFn: (caseId) => apiFetch(`/api/cases/${caseId}`, { method: 'DELETE', adminJwt }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cases'] }),
    })

    const handleDelete = (event, caseItem) => {
        event.stopPropagation()
        const confirmed = window.confirm(
            `Delete "${caseItem.case_name}"? This also frees its access code for reuse. This cannot be undone.`,
        )
        if (confirmed) deleteMutation.mutate(caseItem.id)
    }

    const isEditMode = mode === 'edit'
    return (
        <div className="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
            <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
            <div className="relative z-10 mx-auto max-w-4xl">
                <div className="max-w-2xl">
                    <div className="flex items-center gap-3">
                        <span className="h-px w-8 bg-line" />
                        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
                            {isEditMode ? 'Edit Case' : 'Choose Template'}
                        </p>
                    </div>
                    <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
                        {isEditMode ? 'Select a case to edit' : 'Select an existing case'}
                    </h1>
                    <p className="mt-4 text-sm leading-6 text-stone">
                        {isEditMode
                            ? 'The selected case will open in the form with all of its current details so you can edit it directly.'
                            : 'The selected case will be copied into a new form. Saving it will create a brand-new case and leave the original untouched.'}
                    </p>
                </div>

                <div className="mt-10 space-y-4">
                    {loading && (
                        <div className="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
                            Loading cases...
                        </div>
                    )}
                    {error && (
                        <div className="rounded-2xl border border-brand/20 bg-brand-tint p-5 text-sm text-brand">
                            {error}
                        </div>
                    )}
                    {!loading && !error && cases.length === 0 && (
                        <div className="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
                            No cases found.
                        </div>
                    )}
                    {!loading &&
                        !error &&
                        cases.map((caseItem) => (
                            <div key={caseItem.id}>
                                <button
                                    type="button"
                                    onClick={() =>
                                        navigate(
                                            isEditMode
                                                ? {
                                                      to: '/admin/edit/form',
                                                      search: { caseId: caseItem.id },
                                                  }
                                                : {
                                                      to: '/admin/new/form',
                                                      search: { template: caseItem.id },
                                                  },
                                        )
                                    }
                                    className="group block w-full rounded-2xl border border-line bg-white p-5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-brand hover:shadow-premium"
                                >
                                    <p className="font-display text-lg font-semibold text-ink transition group-hover:text-brand">
                                        {caseItem.case_name}
                                    </p>
                                    {caseItem.access_code && (
                                        <p className="mt-1 font-mono text-xs uppercase tracking-[0.18em] text-stone-soft">
                                            Access code: {caseItem.access_code}
                                        </p>
                                    )}
                                </button>
                                {isEditMode && (
                                    <div className="mt-1.5 flex justify-end px-1">
                                        <button
                                            type="button"
                                            onClick={(event) => handleDelete(event, caseItem)}
                                            disabled={deleteMutation.isPending}
                                            className="text-xs font-semibold text-stone-soft transition hover:text-brand disabled:opacity-60"
                                        >
                                            Delete case
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                </div>
            </div>
        </div>
    )
}

export default TemplatePicker
