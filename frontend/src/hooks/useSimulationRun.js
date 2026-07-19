import { notifications } from '@mantine/notifications'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, streamChat } from '../client.js'
import { mapContact, normalizeHistories } from '../pages/student/Helpers.js'
import { useSessionStore } from './sessionStore.js'

const notify = (message) => notifications.show({ message, autoClose: 4000 })

const SIMULATION_KEY = (runId) => ['simulation', runId]

// How long to wait after the last keystroke before persisting notes, so
// typing doesn't fire a write per character. A blur or unmount flushes any
// pending save immediately regardless of this window — see flushNotes below.
const NOTES_SAVE_DEBOUNCE_MS = 800

/**
 * Owns the simulation-run lifecycle for the student view. The `useQuery`
 * fetched once on mount is the single source of truth for server state —
 * contacts, shared files, histories, and the case all derive from `data`,
 * kept current afterward by the sending tab's own streamed-reply handlers
 * (applyMeta/commitHistory below) rather than any background refresh. The only
 * local state is view selection (which contact is open), the elapsed-time
 * clock, and the in-flight streamed reply (an overlay that masks the sending
 * persona's history until the turn commits back into the query cache). New
 * contacts/files fire notifications from a single effect that diffs `data`.
 *
 * The chat-input and messages-end refs live here (not in the view) because
 * the run lifecycle drives them directly: onSettled refocuses the input, and
 * each streamed delta re-scrolls to the newest message.
 */
export function useSimulationRun() {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    // runId lives in the session store (persisted across reload for resume);
    // it doubles as the query key, so there's no separate local mirror of it.
    const runId = useSessionStore((s) => s.runId)
    const accessCode = useSessionStore((s) => s.accessCode)
    const startTime = useSessionStore((s) => s.startTime)
    const startRun = useSessionStore((s) => s.startRun)
    const setStoreRunId = useSessionStore((s) => s.setRunId)
    const clearRun = useSessionStore((s) => s.clearRun)

    const [activeContactId, setActiveContactId] = useState(null)
    // The in-flight turn: { personaId, messages } — the displayed history for
    // the persona being messaged, held locally while the reply streams so the
    // 15s poll can refresh the cache underneath without clobbering it. null
    // when nothing is streaming.
    const [streamingTurn, setStreamingTurn] = useState(null)
    // Local, editable copy of the server-persisted notes. Seeded once from
    // `data.notes` on first load (notesInitializedRef below), then locally
    // authoritative — later polls never overwrite it, only a save round-trips
    // back through the server.
    const [notes, setNotesState] = useState('')

    const chatInputRef = useRef(null)
    const messagesEndRef = useRef(null)
    const initializedRef = useRef(false)
    // Ids already surfaced to the user, so the notification diff below only
    // fires for genuinely new unlocks/shares (and never for the initial roster).
    const seenRef = useRef({ contacts: new Set(), files: new Set(), initialized: false })
    const notesInitializedRef = useRef(false)
    // Mirrors `notes` / `runId` synchronously (state/props are stale inside a
    // setTimeout closure or an unmount cleanup) so the debounce timer and the
    // unmount flush always save the latest value against the right run.
    const notesRef = useRef('')
    const runIdRef = useRef(runId)
    const notesSaveTimerRef = useRef(null)

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

    // --- server state: one query owns it --------------------------------
    // Fetched once on mount; the sending tab's own streamed reply updates the
    // cache directly (see applyMeta/commitHistory below). A second viewer of
    // the same run (another tab, another device) only sees a change on their
    // own next load or manual refresh — there's no push channel back to them.
    const { data, error } = useQuery({
        queryKey: SIMULATION_KEY(runId),
        queryFn: () => apiFetch(`/api/simulations/${runId}`),
        enabled: Boolean(runId),
        refetchOnWindowFocus: false,
        // Home seeds the cache with the /start payload, so a short stale
        // window avoids an immediate redundant GET on mount.
        staleTime: 10000,
        // A 404 means the run expired — don't retry it (handled below); retry
        // other (transient) failures once.
        retry: (count, err) => err?.status !== 404 && count < 1,
    })

    useEffect(() => {
        runIdRef.current = runId
    }, [runId])

    // Seed local notes from the server exactly once (the first time `data`
    // carries them — e.g. on initial load or a reload). Not keyed to `runId`
    // alone: `data` itself may still be undefined for a tick after `runId` is
    // set, so this waits for the real value rather than racing it.
    useEffect(() => {
        if (notesInitializedRef.current) return
        if (data?.notes === undefined) return
        setNotesState(data.notes)
        notesRef.current = data.notes
        notesInitializedRef.current = true
    }, [data])

    // Fire-and-forget PUT; errors are surfaced but not retried automatically
    // (the next edit's debounce, or a manual retry via another edit, will
    // naturally try again).
    const saveNotesNow = useCallback(async (value, id) => {
        if (!id) return
        try {
            await apiFetch(`/api/simulations/${id}/notes`, {
                method: 'PUT',
                body: { notes: value },
            })
        } catch (err) {
            console.error(err)
            notify('Could not save your notes. Please try again.')
        }
    }, [])

    // Debounced setter for the notes textarea: updates local state
    // immediately (so typing feels instant) and schedules a save after
    // NOTES_SAVE_DEBOUNCE_MS of no further edits.
    const setNotes = useCallback(
        (value) => {
            setNotesState(value)
            notesRef.current = value
            if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current)
            notesSaveTimerRef.current = setTimeout(() => {
                notesSaveTimerRef.current = null
                saveNotesNow(notesRef.current, runIdRef.current)
            }, NOTES_SAVE_DEBOUNCE_MS)
        },
        [saveNotesNow],
    )

    // Save immediately, skipping the debounce — call on blur so a click away
    // from the textarea doesn't leave up to NOTES_SAVE_DEBOUNCE_MS of an edit
    // unsaved.
    const flushNotes = useCallback(() => {
        if (notesSaveTimerRef.current) {
            clearTimeout(notesSaveTimerRef.current)
            notesSaveTimerRef.current = null
        }
        saveNotesNow(notesRef.current, runIdRef.current)
    }, [saveNotesNow])

    // Flush any still-pending debounced save when the view unmounts (e.g.
    // navigating away right after typing), so it isn't silently dropped.
    useEffect(() => {
        return () => {
            if (notesSaveTimerRef.current) {
                clearTimeout(notesSaveTimerRef.current)
                saveNotesNow(notesRef.current, runIdRef.current)
            }
        }
    }, [saveNotesNow])

    // Start a fresh run from an access code, seeding the cache so the view
    // renders without waiting for the first GET.
    const startSession = useCallback(
        async (code) => {
            try {
                const fresh = await apiFetch('/api/simulations/start', {
                    method: 'POST',
                    body: { access_code: code },
                })
                queryClient.setQueryData(SIMULATION_KEY(fresh.run_id), fresh)
                startRun({ runId: fresh.run_id, accessCode: code, startTime: Date.now() })
            } catch {
                navigate({ to: '/' })
            }
        },
        [queryClient, startRun, navigate],
    )

    // Establish a runId exactly once per mount: reuse a persisted one (the
    // query loads it), else start from the access code, else bail home. The
    // ref guard makes StrictMode's double-invoke a no-op so it can't race two
    // POST /start calls.
    // biome-ignore lint/correctness/useExhaustiveDependencies: run-once init — see comment
    useEffect(() => {
        if (initializedRef.current) return
        initializedRef.current = true
        if (runId) return
        if (accessCode) startSession(accessCode)
        else navigate({ to: '/' })
    }, [])

    // Run expired: drop it, clear the stale selection, and restart (or bail
    // home). Triggered by a 404 on the server-state query.
    const handleRunExpired = useCallback(() => {
        setStoreRunId('')
        setActiveContactId(null)
        if (accessCode) startSession(accessCode)
        else navigate({ to: '/' })
    }, [accessCode, startSession, navigate, setStoreRunId])

    // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the query error only
    useEffect(() => {
        if (error?.status !== 404) return
        handleRunExpired()
    }, [error])

    // --- derive the view from server state (+ the streaming overlay) -------
    const caseData = data?.case ?? null
    const contacts = useMemo(() => (data?.contacts ?? []).map(mapContact), [data])
    const sharedFiles = data?.shared_files ?? []
    const serverHistories = useMemo(() => normalizeHistories(data?.histories ?? {}), [data])
    const messagesByPersona = useMemo(() => {
        if (!streamingTurn) return serverHistories
        return { ...serverHistories, [streamingTurn.personaId]: streamingTurn.messages }
    }, [serverHistories, streamingTurn])

    // Pick an initial open contact once the first data arrives (the 404 path
    // above clears the selection so a restart re-picks).
    useEffect(() => {
        if (activeContactId != null) return
        const rows = data?.contacts ?? []
        if (rows.length === 0) return
        setActiveContactId(data.active_persona_id || rows[0].id)
    }, [data, activeContactId])

    // Notify on newly-unlocked contacts / newly-shared files by diffing data.
    useEffect(() => {
        if (!data) return
        const seen = seenRef.current
        const rows = data.contacts ?? []
        const files = data.shared_files ?? []
        if (seen.initialized) {
            for (const c of rows) {
                if (!seen.contacts.has(c.id)) notify(`New contact unlocked: ${c.name} (${c.role})`)
            }
            for (const f of files) {
                if (!seen.files.has(f.file_id)) notify(`File shared: ${f.file_name}`)
            }
        }
        seen.contacts = new Set(rows.map((c) => c.id))
        seen.files = new Set(files.map((f) => f.file_id))
        seen.initialized = true
    }, [data])

    const totalDurationSeconds = useMemo(() => {
        if (typeof caseData?.simulation_duration === 'number') {
            return caseData.simulation_duration * 60
        }
        return null
    }, [caseData])

    // Auto-end when the simulation's configured duration elapses. This checks
    // the clock via a plain interval rather than reactive per-second state, so
    // it doesn't re-render the whole student Home every second — the visible
    // clock ticks independently in <SimulationClock startTime={startTime} />,
    // which only re-renders itself.
    useEffect(() => {
        if (typeof totalDurationSeconds !== 'number') return
        const start = startTime ?? Date.now()
        const checkExpiry = () => {
            const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
            if (elapsed >= totalDurationSeconds) {
                // Same ordering concern as handleEndSimulation: flush before
                // clearRun() clears the runId this save needs.
                flushNotes()
                clearRun()
                navigate({ to: '/' })
            }
        }
        checkExpiry()
        const intervalId = window.setInterval(checkExpiry, 1000)
        return () => window.clearInterval(intervalId)
    }, [startTime, totalDurationSeconds, navigate, clearRun, flushNotes])

    const handleEndSimulation = () => {
        // Flush BEFORE clearRun(): once runId is cleared, runIdRef (and the
        // unmount-flush fallback below) would have nothing to save against.
        flushNotes()
        clearRun()
        navigate({ to: '/' })
    }

    const activeContact = contacts.find((contact) => contact.id === activeContactId) || contacts[0]
    const selectedContact = contacts.find((contact) => contact.id === activeContactId)
    const activePersonaAvailable = Boolean(
        selectedContact?.available && !selectedContact?.chatEnded,
    )

    const selectContact = (contactId) => {
        setActiveContactId(contactId)
    }

    // --- streaming a reply -------------------------------------------------
    // Fold this turn's meta (unlocked contacts, shared files, chat-state) into
    // the cache so it shows immediately; the notification effect above picks up
    // the additions.
    const applyMeta = useCallback(
        (personaId, meta) => {
            queryClient.setQueryData(SIMULATION_KEY(runId), (old) => {
                if (!old) return old
                let nextContacts = old.contacts ?? []
                if (meta.new_contacts?.length) {
                    const existing = new Set(nextContacts.map((c) => c.id))
                    const additions = meta.new_contacts
                        .filter((c) => !existing.has(c.id))
                        // meta contacts carry chat-state but not availability;
                        // default to available (the next poll refines it).
                        .map((c) => ({ ...c, available: c.available ?? true }))
                    nextContacts = [...nextContacts, ...additions]
                }
                nextContacts = nextContacts.map((c) =>
                    c.id === personaId
                        ? {
                              ...c,
                              chat_ended: meta.chat_ended ?? c.chat_ended,
                              chat_end_reason: meta.chat_end_reason ?? c.chat_end_reason,
                              warning_count: meta.warning_count ?? c.warning_count,
                          }
                        : c,
                )
                let nextFiles = old.shared_files ?? []
                if (meta.shared_files?.length) {
                    const existing = new Set(nextFiles.map((f) => f.file_id))
                    nextFiles = [
                        ...nextFiles,
                        ...meta.shared_files.filter((f) => !existing.has(f.file_id)),
                    ]
                }
                return { ...old, contacts: nextContacts, shared_files: nextFiles }
            })
        },
        [queryClient, runId],
    )

    // Overwrite a persona's cached history — used to commit a completed turn.
    const commitHistory = useCallback(
        (personaId, messages) => {
            queryClient.setQueryData(SIMULATION_KEY(runId), (old) =>
                old ? { ...old, histories: { ...old.histories, [personaId]: messages } } : old,
            )
        },
        [queryClient, runId],
    )

    const sendMutation = useMutation({
        mutationFn: async ({ personaId, message, priorMessages }) => {
            let streamed = ''
            let receivedDone = false
            let streamError = null
            const overlayMessages = () => [
                ...priorMessages,
                { role: 'user', content: message },
                { role: 'assistant', content: streamed },
            ]
            await streamChat(`/api/simulations/${runId}/message`, {
                body: { persona_id: personaId, message },
                onEvent: (event) => {
                    if (event.type === 'meta') {
                        applyMeta(personaId, event.data)
                    } else if (event.type === 'delta') {
                        streamed += event.data.text ?? ''
                        setStreamingTurn((prev) =>
                            prev && prev.personaId === personaId
                                ? { ...prev, messages: overlayMessages() }
                                : prev,
                        )
                    } else if (event.type === 'done') {
                        receivedDone = true
                        if (Array.isArray(event.data.history)) {
                            commitHistory(personaId, event.data.history)
                        }
                    } else if (event.type === 'error') {
                        streamError = new Error(
                            event.data.detail || 'The reply could not be generated.',
                        )
                    }
                },
            })
            if (streamError) throw streamError
            // No `done` frame (e.g. the connection closed cleanly mid-reply):
            // keep what streamed rather than losing it.
            if (!receivedDone) commitHistory(personaId, overlayMessages())
            return { personaId }
        },
        onSuccess: () => {
            setStreamingTurn(null)
        },
        onError: (err, { personaId, message, priorMessages }) => {
            console.error(err)
            // The user's turn is kept (the server recorded it before streaming
            // began); the un-generated assistant reply is dropped. A later poll
            // reconciles against server truth.
            commitHistory(personaId, [...priorMessages, { role: 'user', content: message }])
            setStreamingTurn(null)
            if (err.message === 'This conversation has ended.') {
                queryClient.setQueryData(SIMULATION_KEY(runId), (old) =>
                    old
                        ? {
                              ...old,
                              contacts: (old.contacts ?? []).map((c) =>
                                  c.id === personaId
                                      ? {
                                            ...c,
                                            chat_ended: true,
                                            chat_end_reason: c.chat_end_reason || 'harassment',
                                        }
                                      : c,
                              ),
                          }
                        : old,
                )
            } else {
                notify(err.message || 'Message failed. Please try again.')
            }
        },
        onSettled: () => {
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
        const priorMessages = serverHistories[personaId] ?? []
        setStreamingTurn({
            personaId,
            messages: [
                ...priorMessages,
                { role: 'user', content: message },
                { role: 'assistant', content: '' },
            ],
        })
        sendMutation.mutate({ personaId, message, priorMessages })
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

    return {
        caseData,
        contacts,
        sharedFiles,
        messagesByPersona,
        activeContactId,
        selectContact,
        runId,
        startTime,
        totalDurationSeconds,
        activeContact,
        activePersonaAvailable,
        isSending,
        sendMessage,
        handleEndSimulation,
        chatInputRef,
        messagesEndRef,
        notes,
        setNotes,
        flushNotes,
    }
}
