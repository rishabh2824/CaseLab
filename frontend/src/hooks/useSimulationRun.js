import { notifications } from '@mantine/notifications'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, apiFetch, streamChat } from '../client.js'
import { mapContact, normalizeHistories, normalizeMessages } from '../pages/student/Helpers.js'
import { useSessionStore } from './sessionStore.js'

const notify = (message) => notifications.show({ message, autoClose: 4000 })

/**
 * Owns the entire simulation-run lifecycle for the student view: bootstrap,
 * the elapsed-time clock, auto-end, the streaming send mutation, and the
 * background poll that keeps contacts/files/histories fresh. The component
 * that consumes this stays a pure view over the returned state and actions.
 *
 * The chat-input and messages-end refs live here (not in the view) because
 * the run lifecycle drives them directly: onSettled refocuses the input, and
 * each streamed delta re-scrolls to the newest message.
 */
export function useSimulationRun() {
    const [caseData, setCaseData] = useState(null)
    const [contacts, setContacts] = useState([])
    const [activeContactId, setActiveContactId] = useState(null)
    const [activePersonaId, setActivePersonaId] = useState(null)
    const [elapsedSeconds, setElapsedSeconds] = useState(0)
    const [runId, setRunId] = useState(null)
    const [messagesByPersona, setMessagesByPersona] = useState({})
    const [sharedFiles, setSharedFiles] = useState([])
    const sendingPersonaIdRef = useRef(null)
    const chatInputRef = useRef(null)
    const messagesEndRef = useRef(null)
    const navigate = useNavigate()
    const storeRunId = useSessionStore((s) => s.runId)
    const accessCode = useSessionStore((s) => s.accessCode)
    const startTime = useSessionStore((s) => s.startTime)
    const consumeBootstrap = useSessionStore((s) => s.consumeBootstrap)
    const setStoreRunId = useSessionStore((s) => s.setRunId)
    const clearRun = useSessionStore((s) => s.clearRun)
    // Refs have stable identity, so these only need to be created once.
    const focusChatInput = useCallback(() => {
        window.requestAnimationFrame(() => {
            chatInputRef.current?.focus()
        })
    }, [])
    const scrollChatToEnd = useCallback(() => {
        window.requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ block: 'end' })
        })
    }, [])

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
                    response = await fetch(`${API_BASE}/api/simulations/${storedRun}`, {
                        method: 'GET',
                    })
                } else if (storedAccessCode) {
                    response = await fetch(`${API_BASE}/api/simulations/start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ access_code: storedAccessCode }),
                    })
                } else {
                    navigate({ to: '/' })
                    return
                }
                if (storedRun && response.status === 404) {
                    setStoreRunId('')
                    if (!storedAccessCode) {
                        navigate({ to: '/' })
                        return
                    }
                    response = await fetch(`${API_BASE}/api/simulations/start`, {
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
    }, [navigate, consumeBootstrap, storeRunId, accessCode, setStoreRunId])

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
            navigate({ to: '/' })
        }
    }, [elapsedSeconds, totalDurationSeconds, navigate, clearRun])

    const handleEndSimulation = () => {
        clearRun()
        navigate({ to: '/' })
    }

    const activeContact = contacts.find((contact) => contact.id === activeContactId) || contacts[0]
    const activePersonaAvailable =
        activeContactId === activePersonaId &&
        contacts.find((c) => c.id === activeContactId)?.available &&
        !contacts.find((c) => c.id === activeContactId)?.chatEnded

    const selectContact = (contactId) => {
        setActiveContactId(contactId)
        setActivePersonaId(contactId)
    }

    const applyMessageMeta = (personaId, data) => {
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
                    notify(`New contact unlocked: ${contact.name} (${contact.title})`)
                })
                return [...prev, ...additional]
            })
        }
        if (data.shared_files?.length) {
            setSharedFiles((prev) => {
                const existingIds = new Set(prev.map((f) => f.file_id))
                const additions = data.shared_files.filter((file) => !existingIds.has(file.file_id))
                additions.forEach((file) => {
                    notify(`File shared: ${file.file_name}`)
                })
                return [...prev, ...additions]
            })
        }
    }

    const sendMutation = useMutation({
        mutationFn: async ({ personaId, message }) => {
            // Append an empty assistant bubble that fills in as deltas stream.
            setMessagesByPersona((prev) => {
                const current = prev[personaId] ?? []
                return { ...prev, [personaId]: [...current, { role: 'assistant', content: '' }] }
            })
            let streamed = ''
            let streamError = null
            await streamChat(`/api/simulations/${runId}/message`, {
                body: { persona_id: personaId, message },
                onEvent: (event) => {
                    if (event.type === 'meta') {
                        // Contacts/files/chat-state are known up front — reflect
                        // them immediately, before the reply finishes streaming.
                        applyMessageMeta(personaId, event.data)
                    } else if (event.type === 'delta') {
                        streamed += event.data.text ?? ''
                        setMessagesByPersona((prev) => {
                            const msgs = [...(prev[personaId] ?? [])]
                            const last = msgs.length - 1
                            if (last >= 0 && msgs[last].role === 'assistant') {
                                msgs[last] = { ...msgs[last], content: streamed }
                            }
                            return { ...prev, [personaId]: msgs }
                        })
                    } else if (event.type === 'done') {
                        if (Array.isArray(event.data.history)) {
                            setMessagesByPersona((prev) => ({
                                ...prev,
                                [personaId]: normalizeMessages(event.data.history),
                            }))
                        }
                    } else if (event.type === 'error') {
                        streamError = new Error(
                            event.data.detail || 'The reply could not be generated.',
                        )
                    }
                },
            })
            if (streamError) throw streamError
            return { personaId }
        },
        onError: (error, { personaId }) => {
            console.error(error)
            // Drop a dangling empty assistant bubble if nothing streamed.
            setMessagesByPersona((prev) => {
                const msgs = prev[personaId] ?? []
                const last = msgs[msgs.length - 1]
                if (last && last.role === 'assistant' && !last.content) {
                    return { ...prev, [personaId]: msgs.slice(0, -1) }
                }
                return prev
            })
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
            } else {
                notify(error.message || 'Message failed. Please try again.')
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

    // Returns true when the message was accepted (all guards passed), so the
    // caller can clear its input exactly when the send actually starts.
    const sendMessage = (rawMessage) => {
        const message = (rawMessage ?? '').trim()
        if (!runId || !activeContactId || !message) return false
        if (!activePersonaAvailable || isSending) return false
        const personaId = activeContactId
        setMessagesByPersona((prev) => {
            const next = { ...prev }
            const current = next[personaId] ?? []
            next[personaId] = [...current, { role: 'user', content: message }]
            return next
        })
        sendingPersonaIdRef.current = personaId
        sendMutation.mutate({ personaId, message })
        return true
    }

    useEffect(() => {
        if (!activeContactId || !activePersonaAvailable || isSending) return
        focusChatInput()
    }, [activeContactId, activePersonaAvailable, isSending, focusChatInput])

    // messagesByPersona's value isn't read below, but it must stay a dependency:
    // its *change* (each streamed reply delta included) is what should re-scroll.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
    useEffect(() => {
        if (!activeContactId) return
        scrollChatToEnd()
    }, [activeContactId, messagesByPersona, scrollChatToEnd])

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
                    notify(`New contact unlocked: ${contact.name} (${contact.title})`)
                })
                return normalizedContacts
            })
            if (data.shared_files) {
                setSharedFiles((prev) => {
                    const prevIds = new Set(prev.map((file) => file.file_id))
                    const newOnes = data.shared_files.filter((file) => !prevIds.has(file.file_id))
                    newOnes.forEach((file) => {
                        notify(`File shared: ${file.file_name}`)
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

    return {
        caseData,
        contacts,
        sharedFiles,
        messagesByPersona,
        activeContactId,
        selectContact,
        runId,
        elapsedSeconds,
        totalDurationSeconds,
        activeContact,
        activePersonaAvailable,
        isSending,
        sendMessage,
        handleEndSimulation,
        chatInputRef,
        messagesEndRef,
    }
}
