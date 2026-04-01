import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

function Home() {
    const [accessCode, setAccessCode] = useState('')
    const [error, setError] = useState('')
    const navigate = useNavigate()

    const handleSubmit = (event) => {
        event.preventDefault()
        const normalized = accessCode.trim().toUpperCase()
        if (normalized === 'STUDENT') {
            setError('')
            sessionStorage.setItem('caseLabStart', String(Date.now()))
            navigate('/student')
            return
        }
        if (normalized === 'ADMIN') {
            setError('')
            navigate('/admin')
            return
        }
        setError('Invalid access code.')
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 flex items-center justify-center px-6">
            <div className="w-full max-w-xl text-center">
                <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-900"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                    wisconsin case lab
                </h1>
                <p className="mt-3 text-sm text-slate-500">
                    Enter your access code to continue.
                </p>
                <form onSubmit={handleSubmit} className="mt-10 space-y-4">
                    <input
                        type="text"
                        placeholder="Enter access code"
                        className="w-full rounded-xl border border-slate-200 bg-white px-5 py-4 text-base shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        value={accessCode}
                        onChange={(event) => setAccessCode(event.currentTarget.value)}
                    />
                    {error && (
                        <p className="text-sm text-red-500">{error}</p>
                    )}
                    <button
                        type="submit"
                        className="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-semibold text-white shadow-md transition hover:bg-slate-800"
                    >
                        Continue
                    </button>
                </form>
            </div>
        </div>
    )
}

export default Home
