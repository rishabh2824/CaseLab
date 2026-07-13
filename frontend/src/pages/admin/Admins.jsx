import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../client.js'
import { ADMIN_ROLE } from '../../constants.js'
import { useSessionStore } from '../../hooks/sessionStore.js'

const ROLE_LABELS = { [ADMIN_ROLE.SUPER]: 'Super Admin', [ADMIN_ROLE.ADMIN]: 'Admin' }

// Super-admin-only admin-management page: list, add ("invite" is just adding
// their email — there's no email/token flow, see backend plan), and delete
// (which cascades to delete that admin's cases — confirmed before sending).
function Admins() {
    const adminJwt = useSessionStore((s) => s.adminJwt)
    const queryClient = useQueryClient()

    const [email, setEmail] = useState('')
    const [name, setName] = useState('')
    const [role, setRole] = useState(ADMIN_ROLE.ADMIN)
    const [formError, setFormError] = useState('')

    const {
        data,
        isLoading,
        error: listError,
    } = useQuery({
        queryKey: ['admins'],
        queryFn: () => apiFetch('/api/admin/admins', { adminJwt }),
    })

    const admins = data ?? []

    const addMutation = useMutation({
        mutationFn: (payload) =>
            apiFetch('/api/admin/admins', { method: 'POST', adminJwt, body: payload }),
        onSuccess: () => {
            setFormError('')
            setEmail('')
            setName('')
            setRole(ADMIN_ROLE.ADMIN)
            queryClient.invalidateQueries({ queryKey: ['admins'] })
        },
        onError: (err) => setFormError(err.message || 'Failed to add admin.'),
    })

    const deleteMutation = useMutation({
        mutationFn: (adminId) =>
            apiFetch(`/api/admin/admins/${adminId}`, { method: 'DELETE', adminJwt }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admins'] }),
    })

    const handleAdd = (event) => {
        event.preventDefault()
        const trimmedEmail = email.trim()
        if (!trimmedEmail) {
            setFormError('Email is required.')
            return
        }
        addMutation.mutate({ email: trimmedEmail, name: name.trim() || null, role })
    }

    const handleDelete = (admin) => {
        const confirmed = window.confirm(
            `Delete ${admin.email}? This also deletes every case they own. This cannot be undone.`,
        )
        if (confirmed) deleteMutation.mutate(admin.id)
    }

    return (
        <div className="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
            <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
            <div className="relative z-10 mx-auto max-w-4xl">
                <div className="flex items-center gap-3">
                    <span className="h-px w-8 bg-line" />
                    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
                        Super Admin
                    </p>
                </div>
                <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
                    Manage admins
                </h1>
                <p className="mt-4 max-w-xl text-sm leading-6 text-stone">
                    Add an admin by email — their Google account being on the allowed Workspace
                    domain plus a row here is their entire access grant. Deleting an admin also
                    deletes every case they own.
                </p>

                <form
                    onSubmit={handleAdd}
                    className="mt-10 flex flex-wrap items-end gap-4 rounded-2xl border border-line bg-white p-6 shadow-soft"
                >
                    <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                        <label
                            htmlFor="admin-email"
                            className="text-xs font-medium text-stone-soft"
                        >
                            Email
                        </label>
                        <input
                            id="admin-email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.currentTarget.value)}
                            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
                            placeholder="name@wisc.edu"
                        />
                    </div>
                    <div className="flex min-w-[160px] flex-1 flex-col gap-1.5">
                        <label htmlFor="admin-name" className="text-xs font-medium text-stone-soft">
                            Name (optional)
                        </label>
                        <input
                            id="admin-name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.currentTarget.value)}
                            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
                            placeholder="Jane Doe"
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="admin-role" className="text-xs font-medium text-stone-soft">
                            Role
                        </label>
                        <select
                            id="admin-role"
                            value={role}
                            onChange={(e) => setRole(Number(e.currentTarget.value))}
                            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
                        >
                            <option value={ADMIN_ROLE.ADMIN}>Admin</option>
                            <option value={ADMIN_ROLE.SUPER}>Super Admin</option>
                        </select>
                    </div>
                    <button
                        type="submit"
                        disabled={addMutation.isPending}
                        className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {addMutation.isPending ? 'Adding…' : 'Add admin'}
                    </button>
                    {formError && (
                        <p className="w-full text-sm font-medium text-brand">{formError}</p>
                    )}
                </form>

                <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-white shadow-soft">
                    {isLoading && <p className="p-5 text-sm text-stone">Loading admins…</p>}
                    {listError && (
                        <p className="p-5 text-sm text-brand">
                            {listError.message || 'Failed to load admins.'}
                        </p>
                    )}
                    {!isLoading && !listError && admins.length === 0 && (
                        <p className="p-5 text-sm text-stone">No admins yet.</p>
                    )}
                    {!isLoading && !listError && admins.length > 0 && (
                        <table className="w-full text-left text-sm">
                            <thead className="border-b border-line bg-cream font-mono text-[11px] uppercase tracking-[0.14em] text-stone-soft">
                                <tr>
                                    <th className="px-5 py-3 font-medium">Email</th>
                                    <th className="px-5 py-3 font-medium">Name</th>
                                    <th className="px-5 py-3 font-medium">Role</th>
                                    <th className="px-5 py-3 font-medium" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line-soft">
                                {admins.map((admin) => (
                                    <tr key={admin.id} className="transition hover:bg-cream/60">
                                        <td className="px-5 py-3 font-medium text-ink">
                                            {admin.email}
                                        </td>
                                        <td className="px-5 py-3 text-stone">
                                            {admin.name || '—'}
                                        </td>
                                        <td className="px-5 py-3 text-stone">
                                            {ROLE_LABELS[admin.role] || admin.role}
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            {admin.role === ADMIN_ROLE.SUPER ? (
                                                <span className="text-sm text-stone-soft">
                                                    Super admins can't be deleted
                                                </span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => handleDelete(admin)}
                                                    disabled={deleteMutation.isPending}
                                                    className="text-sm font-semibold text-brand transition hover:text-brand-dark disabled:opacity-60"
                                                >
                                                    Delete
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    )
}

export default Admins
