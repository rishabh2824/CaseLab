import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useSessionStore } from '../stores/sessionStore'

const PDF_PAGE_WIDTH = 612
const PDF_MARGIN = 54
const PDF_LINE_HEIGHT = 15
const PDF_BODY_FONT_SIZE = 10
const PDF_TITLE_FONT_SIZE = 14

const normalizePdfText = (value) =>
    String(value ?? '')
        .replace(/\u2018|\u2019/g, "'")
        .replace(/\u201c|\u201d/g, '"')
        .replace(/\u2013|\u2014/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[^\x20-\x7E\r\n\t]/g, '?')

const escapePdfString = (value) =>
    normalizePdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const wrapPdfLine = (line, maxChars) => {
    const normalized = normalizePdfText(line).replace(/\t/g, '    ')
    if (!normalized.trim()) return ['']
    const words = normalized.split(/\s+/)
    const lines = []
    let current = ''

    words.forEach((word) => {
        if (word.length > maxChars) {
            if (current) {
                lines.push(current)
                current = ''
            }
            for (let index = 0; index < word.length; index += maxChars) {
                lines.push(word.slice(index, index + maxChars))
            }
            return
        }
        const next = current ? `${current} ${word}` : word
        if (next.length > maxChars) {
            lines.push(current)
            current = word
        } else {
            current = next
        }
    })

    if (current) lines.push(current)
    return lines
}

const wrapPdfText = (text, maxChars) =>
    normalizePdfText(text)
        .split(/\r?\n/)
        .flatMap((line) => wrapPdfLine(line, maxChars))

const slugifyFileName = (value) => {
    const slug = String(value || 'case-lab-chat-export')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return slug || 'case-lab-chat-export'
}

const normalizeMessages = (messages = []) =>
    (messages ?? []).filter(
        (message) =>
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string',
    )

const normalizeHistories = (histories = {}) =>
    Object.fromEntries(
        Object.entries(histories).map(([personaId, messages]) => [
            personaId,
            normalizeMessages(messages),
        ]),
    )

const getPersonaInitials = (name) =>
    name
        ? name
              .split(' ')
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0].toUpperCase())
              .join('')
        : 'NA'

const mapContact = (persona) => {
    const scheduled = typeof persona.scheduled_time === 'number' ? persona.scheduled_time : 0
    const availability = persona.availability_duration
    let status = 'Available'
    if (scheduled && scheduled > 0) {
        status = `Available in ${scheduled} min`
    }
    return {
        id: persona.id,
        initials: getPersonaInitials(persona.name),
        name: persona.name || 'Unnamed',
        title: persona.role || 'Role',
        profilePhotoUrl: persona.profile_photo?.url || persona.profilePhoto?.url || null,
        status,
        availability,
        isReferred: persona.is_referred ?? false,
        available: persona.available ?? false,
        availableIn: persona.available_in ?? null,
        expiresIn: persona.expires_in ?? null,
        chatEnded: persona.chat_ended ?? false,
        chatEndReason: persona.chat_end_reason ?? null,
        warningCount: persona.warning_count ?? 0,
    }
}

const buildChatPdfBlob = (personas, notes = '') => {
    const printablePersonas =
        personas.length > 0 ? personas : [{ name: 'No unlocked personas', role: '', messages: [] }]
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ]
    const pageIds = []

    const addPage = (lines) => {
        const pageHeight = Math.max(792, PDF_MARGIN * 2 + lines.length * PDF_LINE_HEIGHT)
        const content = lines
            .map((line, index) => {
                const isTitle = index === 0
                const font = isTitle
                    ? `/F2 ${PDF_TITLE_FONT_SIZE} Tf`
                    : `/F1 ${PDF_BODY_FONT_SIZE} Tf`
                const y = pageHeight - PDF_MARGIN - index * PDF_LINE_HEIGHT
                return `BT ${font} ${PDF_MARGIN} ${y.toFixed(2)} Td (${escapePdfString(line)}) Tj ET`
            })
            .join('\n')
        const contentId = objects.length + 1
        objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
        const pageId = objects.length + 1
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${pageHeight.toFixed(
                2,
            )}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
        )
        pageIds.push(pageId)
    }

    const notesLines = ['My Notes', '']
    const trimmedNotes = notes.trim()
    if (trimmedNotes) {
        notesLines.push(...wrapPdfText(trimmedNotes, 92))
    } else {
        notesLines.push('No notes.')
    }
    addPage(notesLines)

    printablePersonas.forEach((persona) => {
        const speakerName = persona.name || 'Persona'
        const title = persona.role ? `${speakerName} - ${persona.role}` : speakerName
        const lines = [title, '']
        const messages = persona.messages ?? []

        if (messages.length === 0) {
            lines.push('No chat history.')
        } else {
            messages.forEach((message) => {
                const label = message.role === 'user' ? 'You' : speakerName
                lines.push(...wrapPdfText(`${label}: ${message.content ?? ''}`, 92))
                lines.push('')
            })
        }

        addPage(lines)
    })

    objects[1] = `<< /Type /Pages /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(' ')}] /Count ${pageIds.length} >>`

    let pdf = '%PDF-1.4\n'
    const offsets = []
    objects.forEach((object, index) => {
        offsets.push(pdf.length)
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    })
    const xrefOffset = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n`
    pdf += '0000000000 65535 f \n'
    offsets.forEach((offset) => {
        pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
    })
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    pdf += `startxref\n${xrefOffset}\n%%EOF`

    return new Blob([pdf], { type: 'application/pdf' })
}

function StudentHome() {
    const [caseData, setCaseData] = useState(null)
    const [contacts, setContacts] = useState([])
    const [notes, setNotes] = useState('')
    const [activeContactId, setActiveContactId] = useState(null)
    const [elapsedSeconds, setElapsedSeconds] = useState(0)
    const [runId, setRunId] = useState(null)
    const [messagesByPersona, setMessagesByPersona] = useState({})
    const [inputValue, setInputValue] = useState('')
    const [activePersonaId, setActivePersonaId] = useState(null)
    const [sharedFiles, setSharedFiles] = useState([])
    const [notifications, setNotifications] = useState([])
    const sendingPersonaIdRef = useRef(null)
    const chatInputRef = useRef(null)
    const messagesEndRef = useRef(null)
    const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')
    const navigate = useNavigate()
    const storeRunId = useSessionStore((s) => s.runId)
    const accessCode = useSessionStore((s) => s.accessCode)
    const startTime = useSessionStore((s) => s.startTime)
    const consumeBootstrap = useSessionStore((s) => s.consumeBootstrap)
    const setStoreRunId = useSessionStore((s) => s.setRunId)
    const clearRun = useSessionStore((s) => s.clearRun)
    const focusChatInput = () => {
        window.requestAnimationFrame(() => {
            chatInputRef.current?.focus()
        })
    }
    const scrollChatToEnd = () => {
        window.requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ block: 'end' })
        })
    }
    const renderContactAvatar = (contact) => {
        if (contact.profilePhotoUrl) {
            return (
                <img
                    src={contact.profilePhotoUrl}
                    alt={`${contact.name} profile`}
                    className="h-9 w-9 rounded-full object-cover"
                />
            )
        }
        return (
            <div
                className={`grid h-9 w-9 place-items-center rounded-full text-xs font-semibold ${
                    contact.id === activeContactId
                        ? 'bg-[#5b5fc7] text-white'
                        : 'bg-slate-200 text-slate-600'
                }`}
            >
                {contact.initials}
            </div>
        )
    }
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
                const bootstrapData = consumeBootstrap()
                if (bootstrapData) {
                    setRunId(bootstrapData.run_id)
                    setStoreRunId(bootstrapData.run_id)
                    setCaseData(bootstrapData.case)
                    const normalizedContacts = (bootstrapData.contacts ?? []).map(mapContact)
                    setContacts(normalizedContacts)
                    if (normalizedContacts.length > 0) {
                        const active = bootstrapData.active_persona_id || normalizedContacts[0].id
                        setActiveContactId(active)
                        setActivePersonaId(active)
                    }
                    setSharedFiles(bootstrapData.shared_files ?? [])
                    setMessagesByPersona(normalizeHistories(bootstrapData.histories))
                    return
                }
                const storedRun = storeRunId
                const storedAccessCode = accessCode
                let response
                if (storedRun) {
                    response = await fetch(`${apiBase}/api/simulations/${storedRun}`, {
                        method: 'GET',
                    })
                } else if (storedAccessCode) {
                    response = await fetch(`${apiBase}/api/simulations/start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ access_code: storedAccessCode }),
                    })
                } else {
                    navigate('/')
                    return
                }
                if (storedRun && response.status === 404) {
                    setStoreRunId('')
                    if (!storedAccessCode) {
                        navigate('/')
                        return
                    }
                    response = await fetch(`${apiBase}/api/simulations/start`, {
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
                    setStoreRunId(data.run_id)
                } else if (storedRun) {
                    setRunId(storedRun)
                }
                setCaseData(data.case)
                const normalizedContacts = (data.contacts ?? []).map(mapContact)
                setContacts(normalizedContacts)
                if (normalizedContacts.length > 0) {
                    const active = data.active_persona_id || normalizedContacts[0].id
                    setActiveContactId(active)
                    setActivePersonaId(active)
                }
                setSharedFiles(data.shared_files ?? [])
                setMessagesByPersona(normalizeHistories(data.histories))
            } catch (error) {
                console.error(error)
            }
        }
        loadSimulation()
    }, [apiBase, navigate, consumeBootstrap, storeRunId, accessCode, setStoreRunId])
    useEffect(() => {
        const intervalId = window.setInterval(() => {
            const start = startTime ?? Date.now()
            const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
            setElapsedSeconds(elapsed)
        }, 1000)
        return () => window.clearInterval(intervalId)
    }, [startTime])

    const totalDurationSeconds = useMemo(() => {
        if (typeof caseData?.simulation_duration === 'number') {
            return caseData.simulation_duration * 60
        }
        return null
    }, [caseData])

    useEffect(() => {
        if (typeof totalDurationSeconds === 'number' && elapsedSeconds >= totalDurationSeconds) {
            clearRun()
            navigate('/')
        }
    }, [elapsedSeconds, totalDurationSeconds, navigate, clearRun])

    const formatTime = (totalSeconds) => {
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = totalSeconds % 60
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }

    const handleEndSimulation = () => {
        clearRun()
        navigate('/')
    }
    const exportMutation = useMutation({
        mutationFn: () => apiFetch(`/api/simulations/${runId}/export`),
        onSuccess: (data) => {
            const blob = buildChatPdfBlob(data.personas ?? [], notes)
            const url = window.URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${slugifyFileName(data.case?.case_name)}-chat-history.pdf`
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.setTimeout(() => window.URL.revokeObjectURL(url), 1000)
        },
        onError: (error) => {
            console.error(error)
            pushNotification('Unable to export PDF. Please try again.')
        },
    })

    const isExporting = exportMutation.isPending

    const handleExportPdf = () => {
        if (!runId || isExporting) return
        exportMutation.mutate()
    }
    const activeContact = contacts.find((contact) => contact.id === activeContactId) || contacts[0]
    const activePersonaAvailable =
        activeContactId === activePersonaId &&
        contacts.find((c) => c.id === activeContactId)?.available &&
        !contacts.find((c) => c.id === activeContactId)?.chatEnded

    const sendMutation = useMutation({
        mutationFn: async ({ personaId, message }) => {
            const data = await apiFetch(`/api/simulations/${runId}/message`, {
                method: 'POST',
                body: { persona_id: personaId, message },
            })
            return { data, personaId }
        },
        onSuccess: ({ data, personaId }) => {
            setMessagesByPersona((prev) => {
                const next = { ...prev }
                if (Array.isArray(data.history)) {
                    next[personaId] = normalizeMessages(data.history)
                } else {
                    const current = next[personaId] ?? []
                    next[personaId] = [...current, { role: 'assistant', content: data.reply }]
                }
                return next
            })
            setContacts((prev) =>
                prev.map((contact) =>
                    contact.id === personaId
                        ? {
                              ...contact,
                              chatEnded: data.chat_ended ?? contact.chatEnded,
                              chatEndReason: data.chat_end_reason ?? contact.chatEndReason,
                              warningCount: data.warning_count ?? contact.warningCount,
                          }
                        : contact,
                ),
            )
            if (data.new_contacts?.length) {
                setContacts((prev) => {
                    const existingIds = new Set(prev.map((c) => c.id))
                    const additional = data.new_contacts
                        .filter((c) => !existingIds.has(c.id))
                        .map((persona) => ({
                            ...mapContact(persona),
                            status: 'Available',
                            isReferred: true,
                            available: persona.available ?? true,
                        }))
                    additional.forEach((contact) => {
                        pushNotification(`New contact unlocked: ${contact.name} (${contact.title})`)
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
        },
        onError: (error, { personaId }) => {
            console.error(error)
            if (error.message === 'This conversation has ended.') {
                setContacts((prev) =>
                    prev.map((contact) =>
                        contact.id === personaId
                            ? {
                                  ...contact,
                                  chatEnded: true,
                                  chatEndReason: contact.chatEndReason || 'harassment',
                              }
                            : contact,
                    ),
                )
            }
        },
        onSettled: (_data, _error, { personaId }) => {
            if (sendingPersonaIdRef.current === personaId) {
                sendingPersonaIdRef.current = null
            }
            focusChatInput()
        },
    })

    const isSending = sendMutation.isPending

    const sendMessage = () => {
        if (!runId || !activeContactId || !inputValue.trim()) return
        if (!activePersonaAvailable || isSending) return
        const personaId = activeContactId
        const message = inputValue.trim()
        setMessagesByPersona((prev) => {
            const next = { ...prev }
            const current = next[personaId] ?? []
            next[personaId] = [...current, { role: 'user', content: message }]
            return next
        })
        setInputValue('')
        sendingPersonaIdRef.current = personaId
        sendMutation.mutate({ personaId, message })
    }

    useEffect(() => {
        if (!activeContactId || !activePersonaAvailable || isSending) return
        focusChatInput()
    }, [activeContactId, activePersonaAvailable, isSending])

    useEffect(() => {
        if (!activeContactId) return
        scrollChatToEnd()
    }, [activeContactId, messagesByPersona])

    useQuery({
        queryKey: ['simulation', runId],
        enabled: Boolean(runId),
        refetchInterval: 15000,
        refetchOnWindowFocus: false,
        queryFn: async () => {
            if (!runId) return null
            const data = await apiFetch(`/api/simulations/${runId}`)
            const normalizedContacts = (data.contacts ?? []).map((persona) => ({
                ...mapContact(persona),
                status: persona.available ? 'Available' : 'Unavailable',
            }))
            setContacts((prev) => {
                const prevIds = new Set(prev.map((contact) => contact.id))
                const newOnes = normalizedContacts.filter((contact) => !prevIds.has(contact.id))
                newOnes.forEach((contact) => {
                    pushNotification(`New contact unlocked: ${contact.name} (${contact.title})`)
                })
                return normalizedContacts
            })
            if (data.shared_files) {
                setSharedFiles((prev) => {
                    const prevIds = new Set(prev.map((file) => file.file_id))
                    const newOnes = data.shared_files.filter((file) => !prevIds.has(file.file_id))
                    newOnes.forEach((file) => {
                        pushNotification(`File shared: ${file.file_name}`)
                    })
                    return data.shared_files
                })
            }
            setMessagesByPersona((prev) => {
                const incomingHistories = normalizeHistories(data.histories)
                const pendingPersonaId = sendingPersonaIdRef.current
                if (pendingPersonaId) {
                    delete incomingHistories[pendingPersonaId]
                }
                return { ...prev, ...incomingHistories }
            })
            return data
        },
    })

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
                    <button
                        type="button"
                        disabled={!runId || isExporting}
                        onClick={handleExportPdf}
                        className="rounded-md bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isExporting ? 'Exporting...' : 'Export PDF'}
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
                                    {renderContactAvatar(contact)}
                                    <div className="flex-1">
                                        <p className="font-semibold text-slate-900">
                                            {contact.name}
                                        </p>
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
                                        {typeof contact.expiresIn === 'number' &&
                                            contact.expiresIn > 0 && (
                                                <p className="text-[11px] text-slate-400">
                                                    Expires in {contact.expiresIn} min
                                                </p>
                                            )}
                                        {contact.chatEnded && (
                                            <p className="text-[11px] text-rose-500">
                                                Conversation ended
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
                            <p className="text-sm text-slate-500">{activeContact?.title ?? ''}</p>
                        </div>
                        {activeContact?.chatEnded ? (
                            <span className="inline-flex items-center gap-2 text-xs text-rose-600">
                                <span className="h-2 w-2 rounded-full bg-rose-500" />
                                Conversation ended
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-2 text-xs text-emerald-600">
                                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                                Available
                            </span>
                        )}
                    </div>

                    {activeContact?.chatEnded && (
                        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                            This persona has ended the conversation for this chat.
                        </div>
                    )}

                    <div className="mt-5 max-h-[55vh] min-h-72 overflow-y-auto rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
                        {(messagesByPersona[activeContactId] ?? []).length === 0 ? (
                            'Chat history is empty.'
                        ) : (
                            <div className="space-y-3 text-left">
                                {(messagesByPersona[activeContactId] ?? []).map((msg, index) => (
                                    <div
                                        key={`${msg.role}-${index}`}
                                        className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm ${
                                            msg.role === 'user'
                                                ? 'bg-[#eef0ff] text-slate-700'
                                                : 'bg-slate-50 text-slate-700'
                                        }`}
                                    >
                                        {msg.content}
                                    </div>
                                ))}
                                <div ref={messagesEndRef} />
                            </div>
                        )}
                    </div>

                    <div className="mt-6 flex items-center gap-3 border-t pt-4">
                        <textarea
                            ref={chatInputRef}
                            autoFocus
                            placeholder={
                                activeContact?.chatEnded
                                    ? 'This conversation has ended.'
                                    : 'Type your message...'
                            }
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
                            onMouseDown={(event) => {
                                event.preventDefault()
                            }}
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
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Case Brief
                        </h3>
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
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Your Notes
                        </h3>
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
