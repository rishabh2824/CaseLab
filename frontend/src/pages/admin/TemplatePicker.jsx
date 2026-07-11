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
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6 py-10">
            <div className="mx-auto max-w-4xl">
                <div className="max-w-2xl">
                    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#5b5fc7] font-display">
                        {isEditMode ? 'Edit Case' : 'Choose Template'}
                    </p>
                    <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl font-display">
                        {isEditMode ? 'Select a case to edit' : 'Select an existing case'}
                    </h1>
                    <p className="mt-4 text-sm leading-6 text-slate-500">
                        {isEditMode
                            ? 'The selected case will open in the form with all of its current details so you can edit it directly.'
                            : 'The selected case will be copied into a new form. Saving it will create a brand-new case and leave the original untouched.'}
                    </p>
                </div>

                <div className="mt-10 space-y-4">
                    {loading && (
                        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
                            Loading cases...
                        </div>
                    )}
                    {error && (
                        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-600">
                            {error}
                        </div>
                    )}
                    {!loading && !error && cases.length === 0 && (
                        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
                            No cases found.
                        </div>
                    )}
                    {!loading &&
                        !error &&
                        cases.map((caseItem) => (
                            <div
                                key={caseItem.id}
                                className="w-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#5b5fc7] hover:shadow-md"
                            >
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
                                    className="block w-full text-left"
                                >
                                    <p className="text-lg font-semibold text-slate-900">
                                        {caseItem.case_name}
                                    </p>
                                    {caseItem.access_code && (
                                        <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-400">
                                            Access code: {caseItem.access_code}
                                        </p>
                                    )}
                                </button>
                                {isEditMode && (
                                    <button
                                        type="button"
                                        onClick={(event) => handleDelete(event, caseItem)}
                                        disabled={deleteMutation.isPending}
                                        className="mt-3 text-sm font-semibold text-red-600 transition hover:text-red-700 disabled:opacity-60"
                                    >
                                        Delete
                                    </button>
                                )}
                            </div>
                        ))}
                </div>
            </div>
        </div>
    )
}

export default TemplatePicker
