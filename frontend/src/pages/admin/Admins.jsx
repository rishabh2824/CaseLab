import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../client.js'
import { useSessionStore } from '../../hooks/sessionStore.js'

const ROLE_LABELS = { 1: 'Super Admin', 2: 'Admin' }

// Super-admin-only admin-management page: list, add ("invite" is just adding
// their email — there's no email/token flow, see backend plan), and delete
// (which cascades to delete that admin's cases — confirmed before sending).
function Admins() {
    const adminJwt = useSessionStore((s) => s.adminJwt)
    const queryClient = useQueryClient()

    const [email, setEmail] = useState('')
    const [name, setName] = useState('')
    const [role, setRole] = useState(2)
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
            setRole(2)
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
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6 py-10">
            <div className="mx-auto max-w-4xl">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#5b5fc7] font-display">
                    Super Admin
                </p>
                <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl font-display">
                    Manage admins
                </h1>
                <p className="mt-4 max-w-xl text-sm leading-6 text-slate-500">
                    Add an admin by email — their Google account being on the
                    allowed Workspace domain plus a row here is their entire
                    access grant. Deleting an admin also deletes every case
                    they own.
                </p>

                <form
                    onSubmit={handleAdd}
                    className="mt-10 flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                    <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                        <label htmlFor="admin-email" className="text-xs font-medium text-slate-500">
                            Email
                        </label>
                        <input
                            id="admin-email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.currentTarget.value)}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#5b5fc7] focus:outline-none focus:ring-2 focus:ring-[#5b5fc7]/20"
                            placeholder="name@wisc.edu"
                        />
                    </div>
                    <div className="flex min-w-[160px] flex-1 flex-col gap-1">
                        <label htmlFor="admin-name" className="text-xs font-medium text-slate-500">
                            Name (optional)
                        </label>
                        <input
                            id="admin-name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.currentTarget.value)}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#5b5fc7] focus:outline-none focus:ring-2 focus:ring-[#5b5fc7]/20"
                            placeholder="Jane Doe"
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label htmlFor="admin-role" className="text-xs font-medium text-slate-500">
                            Role
                        </label>
                        <select
                            id="admin-role"
                            value={role}
                            onChange={(e) => setRole(Number(e.currentTarget.value))}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#5b5fc7] focus:outline-none focus:ring-2 focus:ring-[#5b5fc7]/20"
                        >
                            <option value={2}>Admin</option>
                            <option value={1}>Super Admin</option>
                        </select>
                    </div>
                    <button
                        type="submit"
                        disabled={addMutation.isPending}
                        className="rounded-lg bg-[#5b5fc7] px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {addMutation.isPending ? 'Adding…' : 'Add admin'}
                    </button>
                    {formError && (
                        <p className="w-full text-sm font-medium text-red-600">{formError}</p>
                    )}
                </form>

                <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    {isLoading && (
                        <p className="p-5 text-sm text-slate-500">Loading admins…</p>
                    )}
                    {listError && (
                        <p className="p-5 text-sm text-red-600">
                            {listError.message || 'Failed to load admins.'}
                        </p>
                    )}
                    {!isLoading && !listError && admins.length === 0 && (
                        <p className="p-5 text-sm text-slate-500">No admins yet.</p>
                    )}
                    {!isLoading && !listError && admins.length > 0 && (
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-5 py-3 font-medium">Email</th>
                                    <th className="px-5 py-3 font-medium">Name</th>
                                    <th className="px-5 py-3 font-medium">Role</th>
                                    <th className="px-5 py-3 font-medium" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {admins.map((admin) => (
                                    <tr key={admin.id}>
                                        <td className="px-5 py-3 text-slate-900">{admin.email}</td>
                                        <td className="px-5 py-3 text-slate-500">{admin.name || '—'}</td>
                                        <td className="px-5 py-3 text-slate-500">
                                            {ROLE_LABELS[admin.role] || admin.role}
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            <button
                                                type="button"
                                                onClick={() => handleDelete(admin)}
                                                disabled={deleteMutation.isPending}
                                                className="text-sm font-semibold text-red-600 transition hover:text-red-700 disabled:opacity-60"
                                            >
                                                Delete
                                            </button>
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
