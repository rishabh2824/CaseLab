import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const sharedFiles = []

function StudentHome() {
    const [caseData, setCaseData] = useState(null)
    const [contacts, setContacts] = useState([])
    const [notes, setNotes] = useState('')
    const [activeContactId, setActiveContactId] = useState(null)
    const [elapsedSeconds, setElapsedSeconds] = useState(0)
    const [runId, setRunId] = useState(null)
    const [messagesByPersona, setMessagesByPersona] = useState({})
    const [inputValue, setInputValue] = useState('')
    const [isSending, setIsSending] = useState(false)
    const [activePersonaId, setActivePersonaId] = useState(null)
    const [sharedFiles, setSharedFiles] = useState([])
    const [notifications, setNotifications] = useState([])
    const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')
    const navigate = useNavigate()
    const pushNotification = (message) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        setNotifications((prev) => [...prev, { id, message }])
        window.setTimeout(() => {
            setNotifications((prev) => prev.filter((item) => item.id !== id))
        }, 4000)
    }

    useEffect(() => {
        const loadSimulation = async () => {
            try {
                const bootstrap = sessionStorage.getItem('caseLabBootstrap')
                if (bootstrap) {
                    const data = JSON.parse(bootstrap)
                    sessionStorage.removeItem('caseLabBootstrap')
                    setRunId(data.run_id)
                    sessionStorage.setItem('caseLabRunId', data.run_id)
                    setCaseData(data.case)
                    const normalizedContacts = (data.contacts ?? []).map((persona) => {
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
                            isReferred: persona.is_referred ?? false,
                            available: persona.available ?? false,
                            availableIn: persona.available_in ?? null,
                            expiresIn: persona.expires_in ?? null,
                        }
                    })
                    setContacts(normalizedContacts)
                    if (normalizedContacts.length > 0) {
                        const active = data.active_persona_id || normalizedContacts[0].id
                        setActiveContactId(active)
                        setActivePersonaId(active)
                    }
                    setSharedFiles(data.shared_files ?? [])
                    return
                }
                const storedRun = sessionStorage.getItem('caseLabRunId')
                const storedAccessCode = sessionStorage.getItem('caseLabAccessCode')
                let response
                if (storedRun) {
                    response = await fetch(`${apiBase}/api/v1/simulations/${storedRun}`, {
                        method: 'GET',
                    })
                } else if (storedAccessCode) {
                    response = await fetch(`${apiBase}/api/v1/simulations/start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ access_code: storedAccessCode }),
                    })
                } else {
                    navigate('/')
                    return
                }
                if (storedRun && response.status === 404) {
                    sessionStorage.removeItem('caseLabRunId')
                    if (!storedAccessCode) {
                        navigate('/')
                        return
                    }
                    response = await fetch(`${apiBase}/api/v1/simulations/start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ access_code: storedAccessCode }),
                    })
                }
                if (!response.ok) {
                    throw new Error('Failed to load simulation.')
                }
                const data = await response.json()
                if (data.run_id) {
                    setRunId(data.run_id)
                    sessionStorage.setItem('caseLabRunId', data.run_id)
                } else if (storedRun) {
                    setRunId(storedRun)
                }
                setCaseData(data.case)
                const normalizedContacts = (data.contacts ?? []).map((persona) => {
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
                        isReferred: persona.is_referred ?? false,
                        available: persona.available ?? false,
                        availableIn: persona.available_in ?? null,
                        expiresIn: persona.expires_in ?? null,
                    }
                })
                setContacts(normalizedContacts)
                if (normalizedContacts.length > 0) {
                    const active = data.active_persona_id || normalizedContacts[0].id
                    setActiveContactId(active)
                    setActivePersonaId(active)
                }
                setSharedFiles(data.shared_files ?? [])
            } catch (error) {
                console.error(error)
            }
        }
        loadSimulation()
    }, [apiBase, navigate])
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
            sessionStorage.removeItem('caseLabRunId')
            sessionStorage.removeItem('caseLabAccessCode')
            sessionStorage.removeItem('caseLabBootstrap')
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
        sessionStorage.removeItem('caseLabRunId')
        sessionStorage.removeItem('caseLabAccessCode')
        sessionStorage.removeItem('caseLabBootstrap')
        navigate('/')
    }
    const activeContact =
        contacts.find((contact) => contact.id === activeContactId) || contacts[0]
    const activePersonaAvailable =
        activeContactId === activePersonaId &&
        contacts.find((c) => c.id === activeContactId)?.available

    const sendMessage = async () => {
        if (!runId || !activeContactId || !inputValue.trim()) return
        if (!activePersonaAvailable || isSending) return
        const message = inputValue.trim()
        setMessagesByPersona((prev) => {
            const next = { ...prev }
            const current = next[activeContactId] ?? []
            next[activeContactId] = [...current, { role: 'user', content: message }]
            return next
        })
        setInputValue('')
        setIsSending(true)
        try {
            const response = await fetch(
                `${apiBase}/api/v1/simulations/${runId}/message`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        persona_id: activeContactId,
                        message,
                    }),
                },
            )
            if (!response.ok) {
                throw new Error('Failed to send message.')
            }
            const data = await response.json()
            setMessagesByPersona((prev) => {
                const next = { ...prev }
                const current = next[activeContactId] ?? []
                next[activeContactId] = [
                    ...current,
                    { role: 'assistant', content: data.reply },
                ]
                return next
            })
            if (data.new_contacts?.length) {
                setContacts((prev) => {
                    const existingIds = new Set(prev.map((c) => c.id))
                    const additional = data.new_contacts
                        .filter((c) => !existingIds.has(c.id))
                        .map((persona) => {
                            const initials = persona.name
                                ? persona.name
                                      .split(' ')
                                      .filter(Boolean)
                                      .slice(0, 2)
                                      .map((part) => part[0].toUpperCase())
                                      .join('')
                                : 'NA'
                            return {
                                id: persona.id,
                                initials,
                                name: persona.name || 'Unnamed',
                                title: persona.role || 'Role',
                                status: 'Available',
                                availability: persona.availability_duration,
                                isReferred: true,
                                available: persona.available ?? true,
                                availableIn: persona.available_in ?? null,
                                expiresIn: persona.expires_in ?? null,
                            }
                        })
                    additional.forEach((contact) => {
                        pushNotification(
                            `New contact unlocked: ${contact.name} (${contact.title})`,
                        )
                    })
                    return [...prev, ...additional]
                })
            }
            if (data.shared_files?.length) {
                setSharedFiles((prev) => {
                    const existingIds = new Set(prev.map((f) => f.file_id))
                    const additions = data.shared_files.filter(
                        (file) => !existingIds.has(file.file_id),
                    )
                    additions.forEach((file) => {
                        pushNotification(`File shared: ${file.file_name}`)
                    })
                    return [...prev, ...additions]
                })
            }
        } catch (error) {
            console.error(error)
        } finally {
            setIsSending(false)
        }
    }

    useEffect(() => {
        const intervalId = window.setInterval(async () => {
            const storedRun = sessionStorage.getItem('caseLabRunId')
            if (!storedRun) return
            try {
                const response = await fetch(
                    `${apiBase}/api/v1/simulations/${storedRun}`,
                )
                if (!response.ok) return
                const data = await response.json()
                const normalizedContacts = (data.contacts ?? []).map((persona) => {
                    const initials = persona.name
                        ? persona.name
                              .split(' ')
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((part) => part[0].toUpperCase())
                              .join('')
                        : 'NA'
                    return {
                        id: persona.id,
                        initials,
                        name: persona.name || 'Unnamed',
                        title: persona.role || 'Role',
                        status: persona.available ? 'Available' : 'Unavailable',
                        availability: persona.availability_duration,
                        isReferred: persona.is_referred ?? false,
                        available: persona.available ?? false,
                        availableIn: persona.available_in ?? null,
                        expiresIn: persona.expires_in ?? null,
                    }
                })
                setContacts((prev) => {
                    const prevIds = new Set(prev.map((contact) => contact.id))
                    const newOnes = normalizedContacts.filter(
                        (contact) => !prevIds.has(contact.id),
                    )
                    newOnes.forEach((contact) => {
                        pushNotification(
                            `New contact unlocked: ${contact.name} (${contact.title})`,
                        )
                    })
                    return normalizedContacts
                })
                if (data.shared_files) {
                    setSharedFiles((prev) => {
                        const prevIds = new Set(prev.map((file) => file.file_id))
                        const newOnes = data.shared_files.filter(
                            (file) => !prevIds.has(file.file_id),
                        )
                        newOnes.forEach((file) => {
                            pushNotification(`File shared: ${file.file_name}`)
                        })
                        return data.shared_files
                    })
                }
            } catch (error) {
                console.error(error)
            }
        }, 15000)
        return () => window.clearInterval(intervalId)
    }, [apiBase])

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
                                    disabled={!contact.available}
                                    onClick={() => {
                                        if (contact.available) {
                                            setActiveContactId(contact.id)
                                            setActivePersonaId(contact.id)
                                        }
                                    }}
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
                                        <p className="text-[11px] text-emerald-600">
                                            {contact.available
                                                ? 'Available'
                                                : contact.availableIn
                                                  ? `Available in ${contact.availableIn} min`
                                                  : 'Unavailable'}
                                        </p>
                                        {typeof contact.availability === 'number' && (
                                            <p className="text-[11px] text-slate-400">
                                                Available for {contact.availability} min
                                            </p>
                                        )}
                                        {typeof contact.expiresIn === 'number' && contact.expiresIn > 0 && (
                                            <p className="text-[11px] text-slate-400">
                                                Expires in {contact.expiresIn} min
                                            </p>
                                        )}
                                        {contact.isReferred && (
                                            <p className="text-[11px] text-slate-400">
                                                Referred contact
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
                            {sharedFiles.length === 0 ? (
                                <p className="text-xs text-slate-500">No shared files yet.</p>
                            ) : (
                                sharedFiles.map((file) => (
                                    <div key={file.file_id}>
                                        <a
                                            className="text-sm font-semibold text-[#5b5fc7] underline"
                                            href={file.url}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {file.file_name}
                                        </a>
                                        <p className="text-xs text-slate-500">
                                            {file.content_type || 'File'}
                                        </p>
                                    </div>
                                ))
                            )}
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
                        {(messagesByPersona[activeContactId] ?? []).length === 0 ? (
                            'Chat history is empty.'
                        ) : (
                            <div className="space-y-3 text-left">
                                {(messagesByPersona[activeContactId] ?? []).map(
                                    (msg, index) => (
                                    <div
                                        key={`${msg.role}-${index}`}
                                        className={`rounded-2xl px-4 py-3 text-sm ${
                                            msg.role === 'user'
                                                ? 'bg-[#eef0ff] text-slate-700'
                                                : 'bg-slate-50 text-slate-700'
                                        }`}
                                    >
                                        {msg.content}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="mt-6 flex items-center gap-3 border-t pt-4">
                        <textarea
                            placeholder="Type your message..."
                            disabled={!activePersonaAvailable || isSending}
                            className={`flex-1 resize-none rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100 ${
                                activePersonaAvailable
                                    ? 'bg-white text-slate-700'
                                    : 'bg-slate-50 text-slate-400'
                            }`}
                            rows={2}
                            value={inputValue}
                            onChange={(event) => setInputValue(event.currentTarget.value)}
                            onKeyDown={async (event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault()
                                    await sendMessage()
                                }
                            }}
                        />
                        <button
                            type="button"
                            disabled={!activePersonaAvailable || isSending || !inputValue.trim()}
                            onClick={async () => {
                                await sendMessage()
                            }}
                            className={`rounded-xl px-4 py-3 text-sm font-semibold text-white ${
                                !activePersonaAvailable || isSending || !inputValue.trim()
                                    ? 'bg-slate-300'
                                    : 'bg-[#5b5fc7]'
                            }`}
                        >
                            {isSending ? (
                                <span className="typing-dots" aria-label="Typing">
                                    <span />
                                    <span />
                                    <span />
                                </span>
                            ) : (
                                'Send'
                            )}
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
            {notifications.length > 0 && (
                <div className="fixed left-6 top-6 z-50 space-y-2">
                    {notifications.map((note) => (
                        <div
                            key={note.id}
                            className="rounded-xl border border-[#d6d9ff] bg-white px-4 py-3 text-sm text-slate-700 shadow-lg"
                        >
                            {note.message}
                        </div>
                    ))}
                </div>
            )}
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
