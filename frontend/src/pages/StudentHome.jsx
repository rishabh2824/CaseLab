import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const sharedFiles = [
    {
        id: 'invoice',
        name: 'sterling_invoices.xlsx',
        description: 'from Maria Reyes',
    },
]

function StudentHome() {
    const [caseData, setCaseData] = useState(null)
    const [contacts, setContacts] = useState([])
    const [notes, setNotes] = useState('')
    const [activeContactId, setActiveContactId] = useState(null)
    const [elapsedSeconds, setElapsedSeconds] = useState(0)
    const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')
    const navigate = useNavigate()

    useEffect(() => {
        const loadCase = async () => {
            try {
                const response = await fetch(`${apiBase}/api/v1/cases/active`)
                if (!response.ok) {
                    throw new Error('Failed to load case.')
                }
                const data = await response.json()
                setCaseData(data.case)
                const normalizedContacts = (data.personas ?? []).map((persona) => {
                    const initials = persona.name
                        ? persona.name
                              .split(' ')
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((part) => part[0].toUpperCase())
                              .join('')
                        : 'NA'
                    const scheduled = typeof persona.scheduled_time === 'number'
                        ? persona.scheduled_time
                        : 0
                    const availability = persona.availability_duration
                    let status = 'Available'
                    if (scheduled && scheduled > 0) {
                        status = `Available in ${scheduled} min`
                    }
                    return {
                        id: persona.id,
                        initials,
                        name: persona.name || 'Unnamed',
                        title: persona.role || 'Role',
                        status,
                        availability,
                    }
                })
                setContacts(normalizedContacts)
                if (normalizedContacts.length > 0) {
                    setActiveContactId(normalizedContacts[0].id)
                }
            } catch (error) {
                console.error(error)
            }
        }
        loadCase()
    }, [apiBase])
    useEffect(() => {
        const storedStart = sessionStorage.getItem('caseLabStart')
        if (!storedStart) {
            sessionStorage.setItem('caseLabStart', String(Date.now()))
        }
        const intervalId = window.setInterval(() => {
            const startValue = sessionStorage.getItem('caseLabStart')
            const startTime = startValue ? Number(startValue) : Date.now()
            const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000))
            setElapsedSeconds(elapsed)
        }, 1000)
        return () => window.clearInterval(intervalId)
    }, [])

    const totalDurationSeconds = useMemo(() => {
        if (typeof caseData?.simulation_duration === 'number') {
            return caseData.simulation_duration * 60
        }
        return null
    }, [caseData])

    useEffect(() => {
        if (typeof totalDurationSeconds === 'number' && elapsedSeconds >= totalDurationSeconds) {
            sessionStorage.removeItem('caseLabStart')
            navigate('/')
        }
    }, [elapsedSeconds, totalDurationSeconds, navigate])

    const formatTime = (totalSeconds) => {
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = totalSeconds % 60
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }

    const handleEndSimulation = () => {
        sessionStorage.removeItem('caseLabStart')
        navigate('/')
    }
    const activeContact =
        contacts.find((contact) => contact.id === activeContactId) || contacts[0]

    return (
        <div className="min-h-screen bg-slate-50">
            <header className="bg-[#5b5fc7] text-white">
                <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
                    <div>
                        <h1
                            className="text-lg font-semibold tracking-wide"
                            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                        >
                            Wisconsin Case Lab
                        </h1>
                        <p className="text-xs text-white/80">
                            {caseData?.case_name ?? 'Loading case...'}
                        </p>
                    </div>
                    <button className="rounded-md bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                        Export PDF
                    </button>
                </div>
            </header>

            <main className="mx-auto grid max-w-6xl gap-6 px-6 py-6 lg:grid-cols-[240px_minmax(0,1fr)_260px]">
                <aside className="space-y-6">
                    <div>
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            People & Contacts
                        </h2>
                        <div className="mt-3 space-y-2">
                            {contacts.map((contact) => (
                                <button
                                    key={contact.id}
                                    type="button"
                                    disabled
                                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition ${
                                        contact.id === activeContactId
                                            ? 'border-[#5b5fc7] bg-white shadow-sm'
                                            : 'border-transparent bg-white/70 hover:border-slate-200'
                                    }`}
                                >
                                    <div
                                        className={`grid h-9 w-9 place-items-center rounded-full text-xs font-semibold ${
                                            contact.id === activeContactId
                                                ? 'bg-[#5b5fc7] text-white'
                                                : 'bg-slate-200 text-slate-600'
                                        }`}
                                    >
                                        {contact.initials}
                                    </div>
                                    <div className="flex-1">
                                        <p className="font-semibold text-slate-900">{contact.name}</p>
                                        <p className="text-xs text-slate-500">{contact.title}</p>
                                        <p className="text-[11px] text-emerald-600">{contact.status}</p>
                                        {typeof contact.availability === 'number' && (
                                            <p className="text-[11px] text-slate-400">
                                                Available for {contact.availability} min
                                            </p>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Shared files
                        </h2>
                        <div className="mt-3 space-y-2 rounded-xl bg-white p-3 shadow-sm">
                            {sharedFiles.map((file) => (
                                <div key={file.id}>
                                    <p className="text-sm font-semibold text-[#5b5fc7]">{file.name}</p>
                                    <p className="text-xs text-slate-500">{file.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </aside>

                <section className="rounded-2xl bg-white p-6 shadow-sm">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                                {activeContact?.name ?? 'Select a contact'}
                            </p>
                            <p className="text-sm text-slate-500">
                                {activeContact?.title ?? ''}
                            </p>
                        </div>
                        <span className="inline-flex items-center gap-2 text-xs text-emerald-600">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                            Available
                        </span>
                    </div>

                    <div className="mt-5 rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
                        Chat history is empty.
                    </div>

                    <div className="mt-6 flex items-center gap-3 border-t pt-4">
                        <input
                            type="text"
                            placeholder="Type your message to Tom..."
                            disabled
                            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-400"
                        />
                        <button
                            type="button"
                            disabled
                            className="rounded-xl bg-slate-300 px-4 py-3 text-sm font-semibold text-white"
                        >
                            Send
                        </button>
                    </div>
                </section>

                <aside className="space-y-4">
                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Case Brief</h3>
                        <p className="mt-2 text-sm text-slate-600">
                            {caseData?.initial_brief ?? 'Loading brief...'}
                        </p>
                    </div>

                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Simulation Time
                        </h3>
                        <p className="mt-2 text-2xl font-semibold text-slate-900">
                            {formatTime(elapsedSeconds)} /{' '}
                            {typeof totalDurationSeconds === 'number'
                                ? formatTime(totalDurationSeconds)
                                : '--:--'}
                        </p>
                        <div className="mt-3 h-2 rounded-full bg-slate-100">
                            <div
                                className="h-2 rounded-full bg-emerald-500"
                                style={{
                                    width:
                                        typeof totalDurationSeconds === 'number'
                                            ? `${Math.min(
                                                  100,
                                                  (elapsedSeconds / totalDurationSeconds) * 100,
                                              )}%`
                                            : '0%',
                                }}
                            />
                        </div>
                    </div>

                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your Notes</h3>
                        <textarea
                            className="mt-3 h-40 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100"
                            placeholder="Write your notes here..."
                            value={notes}
                            onChange={(event) => setNotes(event.currentTarget.value)}
                        />
                    </div>
                </aside>
            </main>
            <button
                type="button"
                onClick={handleEndSimulation}
                className="fixed bottom-6 left-6 rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-slate-800"
            >
                End simulation
            </button>
        </div>
    )
}

export default StudentHome
