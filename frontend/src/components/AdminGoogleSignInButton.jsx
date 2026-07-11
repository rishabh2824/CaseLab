import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { apiFetch } from '../client.js'
import { useSessionStore } from '../hooks/sessionStore.js'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

// Clicking `children` (rendered with the caller's own `className`, so it
// looks like an ordinary button) opens Google's real account-picker popup
// directly — via the OAuth2 authorization-code "popup" flow
// (`google.accounts.oauth2.initCodeClient`), not the One Tap `prompt()`
// flow. One Tap is silently suppressed in a lot of real-world conditions
// (third-party cookies blocked, no FedCM support, prior dismissal cooldown)
// and there is no way to detect that *before* the click, which used to force
// a second click on a fallback button. The popup code flow is triggered
// directly from a real user gesture, so the browser always shows the popup.
//
// The code client only hands back an authorization `code`, not an ID token —
// the backend exchanges it for one (see backend/services/admin_auth.py)
// before doing the usual ID-token verification.
function AdminGoogleSignInButton({ className, children }) {
    const [error, setError] = useState('')
    const codeClientRef = useRef(null)
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const setAdmin = useSessionStore((s) => s.setAdmin)

    const { mutate: login, isPending } = useMutation({
        mutationFn: (googleAuthCode) =>
            apiFetch('/api/admin/login', {
                method: 'POST',
                body: { google_auth_code: googleAuthCode },
            }),
        onSuccess: (data) => {
            setError('')
            // ['cases']/['admins'] aren't keyed by admin identity — without
            // this, a leftover cache entry from a previous admin's session on
            // this device/tab could flash here before the new fetch resolves.
            queryClient.clear()
            setAdmin({
                adminJwt: data.admin_jwt,
                adminRole: data.role,
                adminEmail: data.email,
            })
            navigate({ to: '/admin' })
        },
        onError: (err) =>
            setError(err.message || 'Your account is not authorized. Ask a super admin to add you.'),
    })

    const handleCodeResponse = useCallback(
        (response) => {
            if (response.error) {
                // 'popup_closed' fires when the admin just closes the picker
                // without choosing an account — not a real error.
                if (response.error !== 'popup_closed') {
                    setError('Google sign-in did not complete.')
                }
                return
            }
            login(response.code)
        },
        [login],
    )

    const ensureCodeClient = useCallback(() => {
        const oauth2 = window.google?.accounts?.oauth2
        if (!oauth2) return null
        if (!codeClientRef.current) {
            codeClientRef.current = oauth2.initCodeClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: 'openid email profile',
                ux_mode: 'popup',
                callback: handleCodeResponse,
            })
        }
        return codeClientRef.current
    }, [handleCodeResponse])

    const handleClick = () => {
        setError('')
        const codeClient = ensureCodeClient()
        if (!codeClient) {
            setError('Google sign-in is still loading. Try again in a moment.')
            return
        }
        codeClient.requestCode()
    }

    return (
        <div className="relative inline-block">
            <button type="button" onClick={handleClick} className={className}>
                {isPending ? 'Signing in…' : children}
            </button>
            {error && (
                <p className="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-[#e4dfd5] bg-white px-3 py-2 text-xs font-medium text-[#c5050c] shadow-md">
                    {error}
                </p>
            )}
        </div>
    )
}

export default AdminGoogleSignInButton
