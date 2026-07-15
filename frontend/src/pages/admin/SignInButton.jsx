import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { apiFetch } from '../../client.js'
import { useSessionStore } from '../../hooks/sessionStore.js'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

function SignInButton({ className, children }) {
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
            queryClient.clear()
            setAdmin({
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

export default SignInButton
