import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useSessionStore } from '../stores/sessionStore'

function Home() {
    const [accessCode, setAccessCode] = useState('')
    const [error, setError] = useState('')
    const navigate = useNavigate()
    const setAdminToken = useSessionStore((s) => s.setAdminToken)
    const startRun = useSessionStore((s) => s.startRun)

    const { mutate: submit, isPending: isSubmitting } = useMutation({
        mutationFn: async (code) => {
            // Admin path: verify the token server-side.
            try {
                await apiFetch('/api/admin/verify', { adminToken: code })
                return { kind: 'admin', code }
            } catch {
                // Not an admin token — treat as a student access code.
            }
            const normalized = code.toUpperCase()
            const data = await apiFetch('/api/simulations/start', {
                method: 'POST',
                body: { access_code: normalized },
            })
            return { kind: 'student', normalized, data }
        },
        onSuccess: (result) => {
            setError('')
            if (result.kind === 'admin') {
                setAdminToken(result.code)
                navigate('/admin')
                return
            }
            startRun({
                runId: result.data.run_id,
                accessCode: result.normalized,
                bootstrap: result.data,
                startTime: Date.now(),
            })
            navigate('/student')
        },
        onError: () => setError('Invalid access code.'),
    })

    const handleSubmit = (event) => {
        event.preventDefault()
        const code = accessCode.trim()
        if (!code) {
            setError('Invalid access code.')
            return
        }
        submit(code)
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 flex items-center justify-center px-6">
            <div className="w-full max-w-xl text-center">
                <h1
                    className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-900"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                    wisconsin case lab
                </h1>
                <p className="mt-3 text-sm text-slate-500">Enter your access code to continue.</p>
                <form onSubmit={handleSubmit} className="mt-10 space-y-4">
                    <input
                        type="text"
                        placeholder="Enter access code"
                        className="w-full rounded-xl border border-slate-200 bg-white px-5 py-4 text-base shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        value={accessCode}
                        onChange={(event) => setAccessCode(event.currentTarget.value)}
                    />
                    {error && <p className="text-sm text-red-500">{error}</p>}
                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-semibold text-white shadow-md transition hover:bg-slate-800"
                    >
                        {isSubmitting ? 'Starting...' : 'Continue'}
                    </button>
                </form>
            </div>
        </div>
    )
}

export default Home
