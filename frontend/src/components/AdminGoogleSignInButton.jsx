import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../client.js'
import { useSessionStore } from '../hooks/sessionStore.js'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

// Clicking `children` (rendered with the caller's own `className`, so it
// looks like an ordinary button) triggers Google's sign-in prompt directly —
// no separate "Sign in with Google" page/button to click through first.
//
// This deliberately does NOT stack an invisible Google button on top of a
// styled one: Google Identity Services detects that pattern (an interactive
// element hidden via opacity/visibility) and refuses to size or activate the
// real button underneath — confirmed live, the iframe stays 0x0 forever —
// since it's the exact shape of a clickjacking attack. Calling
// `google.accounts.id.prompt()` from a real click handler is Google's own
// documented mechanism for driving sign-in from a custom UI trigger, so it's
// used directly. If the browser/session can't display that prompt
// (third-party cookies blocked, no FedCM support, etc. — surfaced via the
// `notification` callback), we fall back to rendering Google's own real
// button via `renderButton()` so sign-in is never a dead end.
//
// The GSI client is initialized exactly once (`initializeRef`) and reused for
// both `prompt()` and the fallback `renderButton()` — re-initializing (e.g. by
// also mounting @react-oauth/google's <GoogleLogin>, which calls initialize()
// itself) confused GSI's internal state and broke the fallback button's
// sizing the same way the invisible-overlay approach did.
function AdminGoogleSignInButton({ className, children }) {
    const [error, setError] = useState('')
    const [showFallbackButton, setShowFallbackButton] = useState(false)
    const fallbackContainerRef = useRef(null)
    const initializedRef = useRef(false)
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const setAdmin = useSessionStore((s) => s.setAdmin)

    const { mutate: login, isPending } = useMutation({
        mutationFn: (googleIdToken) =>
            apiFetch('/api/admin/login', {
                method: 'POST',
                body: { google_id_token: googleIdToken },
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

    const handleCredential = useCallback(
        (response) => {
            if (!response?.credential) {
                setError('Google sign-in did not return a credential.')
                return
            }
            login(response.credential)
        },
        [login],
    )

    const ensureInitialized = useCallback(() => {
        const googleId = window.google?.accounts?.id
        if (!googleId) return null
        if (!initializedRef.current) {
            googleId.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredential })
            initializedRef.current = true
        }
        return googleId
    }, [handleCredential])

    // Once the fallback is showing, render Google's real button into our
    // container using the SAME already-initialized client (see module note).
    useEffect(() => {
        if (!showFallbackButton) return
        const googleId = ensureInitialized()
        if (googleId && fallbackContainerRef.current) {
            googleId.renderButton(fallbackContainerRef.current, { theme: 'outline', size: 'large' })
        }
    }, [showFallbackButton, ensureInitialized])

    const handleClick = () => {
        setError('')
        const googleId = ensureInitialized()
        if (!googleId) {
            // GSI script hasn't finished loading yet — fall back rather than
            // silently do nothing on click.
            setShowFallbackButton(true)
            return
        }
        googleId.prompt((notification) => {
            if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                setShowFallbackButton(true)
            }
        })
    }

    if (showFallbackButton) {
        return (
            <div className="flex flex-col items-end gap-2">
                <div ref={fallbackContainerRef} />
                {error && <p className="text-xs font-medium text-[#c5050c]">{error}</p>}
            </div>
        )
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
