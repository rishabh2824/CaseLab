import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { apiFetch } from '../client.js'
import SignInButton from './admin/SignInButton.jsx'
import { useSessionStore } from '../hooks/sessionStore.js'
import halfCircle from '../assets/HalfCircle.webp'
import chevron from '../assets/Chevron.webp'
import wsbLogo from '../assets/WSBLogo.webp'

function Home() {
    const [accessCode, setAccessCode] = useState('')
    const [error, setError] = useState('')
    const accessCodeRef = useRef(null)
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const startRun = useSessionStore((s) => s.startRun)

    // Students only now — admins sign in via the "Admin Login" button below
    // (Google SSO, triggered directly from that button), not through this form.
    const { mutate: submit, isPending: isSubmitting } = useMutation({
        mutationFn: async (code) => {
            const normalized = code.toUpperCase()
            const data = await apiFetch('/api/simulations/start', {
                method: 'POST',
                body: { access_code: normalized },
            })
            return { normalized, data }
        },
        onSuccess: (result) => {
            setError('')
            // Seed the query cache in memory (NOT sessionStorage) so the
            // student view renders from the /start payload immediately, without
            // a redundant GET on mount.
            queryClient.setQueryData(['simulation', result.data.run_id], result.data)
            startRun({
                runId: result.data.run_id,
                accessCode: result.normalized,
                startTime: Date.now(),
            })
            navigate({ to: '/student' })
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
        <div
            className="landing-bg relative flex flex-col h-screen w-full items-center justify-center overflow-hidden bg-cover bg-center px-6 font-body"
        >
            {/*Red horizontal bar*/}
            <div className="absolute inset-x-0 top-0 h-1 bg-[#c5050c]" aria-hidden="true" />

            {/* Brand geometry — faint WSB graphic elements framing the card */}
            <img
                src={chevron}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-28 -right-28 z-0 w-[34rem] max-w-none select-none opacity-[0.22]"
            />
            <img
                src={halfCircle}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 -left-28 z-0 w-72 max-w-none -translate-y-1/2 rotate-90 select-none opacity-[0.22]"
            />

            <img
                src={wsbLogo}
                alt="Wisconsin School of Business"
                className="absolute left-6 top-6 z-10 h-12 w-auto sm:h-20"
            />

            <div className="absolute bottom-6 right-6 z-10 sm:bottom-auto sm:top-12 sm:right-20">
                <SignInButton className="rounded-full border-2 border-[#c5050c] bg-white/70 px-6 py-3 font-mono text-sm uppercase tracking-[0.2em] text-[#57534b] shadow-sm backdrop-blur transition hover:bg-[#c5050c] hover:text-[#1a1a1a]">
                    Admin Login
                </SignInButton>
            </div>

            {/* Centered dossier */}
            <div className="relative z-10 w-full max-w-lg text-center">
                <div className="mt-8 flex items-center justify-center gap-3">
                    <span className="h-px w-8 bg-[#d6d0c4]" />
                    <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#c5050c]">
                        Wisconsin School of Business
                    </span>
                    <span className="h-px w-8 bg-[#d6d0c4]" />
                </div>

                <h1 className="mt-4 text-4xl font-bold leading-[1.02] tracking-tight text-[#1a1a1a] sm:text-5xl font-display">
                    Wisconsin Case Lab
                </h1>
                <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-[#57534b]">
                    Enter your access code to start the simulation.
                </p>

                {/* Access file */}
                <div className="mx-auto mt-9 max-w-sm overflow-hidden rounded-2xl border border-[#e4dfd5] bg-white text-left shadow-[0_1px_2px_rgba(18,18,18,0.04),0_24px_48px_-28px_rgba(18,18,18,0.3)]">
                    <div className="flex items-center justify-between border-b border-[#efeae0] bg-[#faf8f4] px-5 py-2.5">
                        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-[#c5050c]">
                            Case Studies
                        </span>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-3 px-5 py-5">
                        <input
                            ref={accessCodeRef}
                            type="text"
                            aria-label="Access code"
                            placeholder="Enter access code"
                            className="w-full rounded-xl border border-[#e1e5e7] bg-white px-4 py-3.5 text-center text-base tracking-[0.08em] text-[#121212] shadow-sm transition placeholder:tracking-normal placeholder:text-[#a4a4ab] focus:border-[#c5050c] focus:outline-none focus:ring-4 focus:ring-[#c5050c]/12"
                            value={accessCode}
                            onChange={(event) => setAccessCode(event.currentTarget.value)}
                        />
                        {error && (
                            <p className="text-center text-sm font-medium text-[#c5050c]">
                                {error}
                            </p>
                        )}
                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-full rounded-xl px-5 py-3.5 text-base font-semibold text-white shadow-sm transition hover:brightness-95 focus:outline-none focus:ring-4 focus:ring-[#c5050c]/25 disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ backgroundColor: '#c5050c' }}
                        >
                            {isSubmitting ? 'Starting…' : 'Open Case'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    )
}

export default Home
