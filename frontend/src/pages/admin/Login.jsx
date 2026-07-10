import { GoogleLogin } from '@react-oauth/google'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { apiFetch } from '../../client.js'
import { useSessionStore } from '../../hooks/sessionStore.js'

// Replaces the old shared admin-code entry on the home screen with Google
// Workspace SSO. An admin's presence in the `admins` table (added by a super
// admin from the /admin/admins page) *is* their access grant — there is no
// separate invite/accept step.
function Login() {
    const [error, setError] = useState('')
    const navigate = useNavigate()
    const setAdmin = useSessionStore((s) => s.setAdmin)

    const { mutate: login, isPending } = useMutation({
        mutationFn: (googleIdToken) =>
            apiFetch('/api/admin/login', {
                method: 'POST',
                body: { google_id_token: googleIdToken },
            }),
        onSuccess: (data) => {
            setError('')
            setAdmin({
                adminJwt: data.admin_jwt,
                adminRole: data.role,
                adminEmail: data.email,
            })
            navigate({ to: '/admin' })
        },
        onError: (err) => {
            setError(
                err.message ||
                    'Your account is not authorized. Ask a super admin to add you.',
            )
        },
    })

    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-[#faf8f4] px-6 font-body">
            <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-[#e4dfd5] bg-white text-center shadow-[0_1px_2px_rgba(18,18,18,0.04),0_24px_48px_-28px_rgba(18,18,18,0.3)]">
                <div className="border-b border-[#efeae0] bg-[#faf8f4] px-6 py-3">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-[#c5050c]">
                        Admin Access
                    </span>
                </div>
                <div className="space-y-5 px-8 py-10">
                    <h1 className="text-2xl font-semibold tracking-tight text-[#1a1a1a] font-display">
                        Sign in with Google
                    </h1>
                    <p className="text-sm leading-relaxed text-[#57534b]">
                        Use your Wisconsin School of Business Google account. If you
                        haven't been added as an admin yet, ask a super admin to add
                        your email first.
                    </p>
                    <div className="flex justify-center pt-2">
                        <GoogleLogin
                            onSuccess={(credentialResponse) => {
                                if (!credentialResponse.credential) {
                                    setError('Google sign-in did not return a credential.')
                                    return
                                }
                                login(credentialResponse.credential)
                            }}
                            onError={() => setError('Google sign-in failed.')}
                        />
                    </div>
                    {isPending && (
                        <p className="text-sm text-[#57534b]">Signing in…</p>
                    )}
                    {error && (
                        <p className="text-sm font-medium text-[#c5050c]">{error}</p>
                    )}
                </div>
            </div>
        </div>
    )
}

export default Login
