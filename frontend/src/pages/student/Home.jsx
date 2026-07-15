import { notifications } from '@mantine/notifications'
import { useMutation } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { apiFetch } from '../../client.js'
import { MAX_MESSAGE_WORDS } from '../../constants.js'
import { useSimulationRun } from '../../hooks/useSimulationRun.js'
import { countWords } from './Helpers.js'
import SimulationClock from './SimulationClock.jsx'
import wsbLogo from '../../assets/WSBLogo-NoTagline.png'

const notify = (message) => notifications.show({ message, autoClose: 4000 })

function Home() {
    const {
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
    } = useSimulationRun()

    const [inputValue, setInputValue] = useState('')

    const wordCount = useMemo(() => countWords(inputValue), [inputValue])
    const overWordLimit = wordCount > MAX_MESSAGE_WORDS

    const exportMutation = useMutation({
        mutationFn: () => apiFetch(`/api/simulations/${runId}/export`),
        onSuccess: async (data) => {
            // jsPDF is only needed by the (rarely-clicked) export button — load
            // it on demand rather than in every student's initial bundle.
            const { buildChatPdfBlob, slugifyFileName } = await import('./pdf.js')
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
            notify('Unable to export PDF. Please try again.')
        },
    })

    const isExporting = exportMutation.isPending

    const handleExportPdf = () => {
        if (!runId || isExporting) return
        exportMutation.mutate()
    }

    // sendMessage clears nothing itself; clear the input only when it accepted.
    const handleSend = () => {
        if (overWordLimit) return
        if (sendMessage(inputValue)) setInputValue('')
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
                        ? 'bg-brand text-white'
                        : 'bg-line-soft text-stone'
                }`}
            >
                {contact.initials}
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-parchment">
            <header className="relative border-b border-line bg-white">
                <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
                <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-2 py-3.5">
                    <div className="flex items-center gap-4">
                        <img
                            src={wsbLogo}
                            alt="Wisconsin School of Business"
                            className="h-10 w-auto"
                        />
                        <span className="hidden h-9 w-px bg-line sm:block" aria-hidden="true" />
                        <div>
                            <h1 className="font-display text-base font-semibold tracking-tight text-ink">
                                Wisconsin Case Lab
                            </h1>
                            <p className="text-xs text-stone-soft">
                                {caseData?.case_name ?? 'Loading case…'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        disabled={!runId || isExporting}
                        onClick={handleExportPdf}
                        className="inline-flex items-center rounded-full border border-line bg-white px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isExporting ? 'Exporting…' : 'Export PDF'}
                    </button>
                </div>
            </header>

            <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[240px_minmax(0,1fr)_340px]">
                <aside className="space-y-6">
                    <div>
                        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                            People &amp; Contacts
                        </h2>
                        <div className="mt-3 space-y-2">
                            {contacts.map((contact) => (
                                <button
                                    key={contact.id}
                                    type="button"
                                    disabled={!contact.available}
                                    onClick={() => {
                                        if (contact.available) {
                                            selectContact(contact.id)
                                        }
                                    }}
                                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition ${
                                        contact.id === activeContactId
                                            ? 'border-brand bg-white shadow-soft'
                                            : 'border-line bg-white/70 hover:border-stone-soft hover:bg-white'
                                    }`}
                                >
                                    {renderContactAvatar(contact)}
                                    <div className="flex-1">
                                        <p className="font-semibold text-ink">{contact.name}</p>
                                        <p className="text-xs text-stone">{contact.title}</p>
                                        <p
                                            className={`text-[11px] font-medium ${
                                                contact.available
                                                    ? 'text-success'
                                                    : 'text-stone-soft'
                                            }`}
                                        >
                                            {contact.available
                                                ? 'Available'
                                                : contact.availableIn
                                                  ? `Available in ${contact.availableIn} min`
                                                  : 'Unavailable'}
                                        </p>
                                        {typeof contact.availability === 'number' && (
                                            <p className="text-[11px] text-stone-soft">
                                                Available for {contact.availability} min
                                            </p>
                                        )}
                                        {typeof contact.expiresIn === 'number' &&
                                            contact.expiresIn > 0 && (
                                                <p className="text-[11px] text-stone-soft">
                                                    Expires in {contact.expiresIn} min
                                                </p>
                                            )}
                                        {contact.chatEnded && (
                                            <p className="text-[11px] text-brand">
                                                Conversation ended
                                            </p>
                                        )}
                                        {contact.isReferred && (
                                            <p className="text-[11px] text-stone-soft">
                                                Referred contact
                                            </p>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                            Shared files
                        </h2>
                        <div className="mt-3 space-y-2 rounded-xl border border-line bg-white p-3 shadow-soft">
                            {sharedFiles.length === 0 ? (
                                <p className="text-xs text-stone-soft">No shared files yet.</p>
                            ) : (
                                sharedFiles.map((file) => (
                                    <div key={file.file_id}>
                                        <a
                                            className="text-sm font-semibold text-brand underline decoration-brand/30 underline-offset-2 transition hover:decoration-brand"
                                            href={file.url}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {file.file_name}
                                        </a>
                                        <p className="text-xs text-stone-soft">
                                            {file.content_type || 'File'}
                                        </p>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </aside>

                <section className="rounded-2xl border border-line bg-white p-6 shadow-soft">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="font-display text-lg font-semibold tracking-tight text-ink">
                                {activeContact?.name ?? 'Select a contact'}
                            </p>
                            <p className="text-sm text-stone">{activeContact?.title ?? ''}</p>
                        </div>
                        {activeContact?.chatEnded ? (
                            <span className="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1 text-xs font-medium text-brand">
                                <span className="h-2 w-2 rounded-full bg-brand" />
                                Conversation ended
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
                                <span className="h-2 w-2 rounded-full bg-success" />
                                Available
                            </span>
                        )}
                    </div>

                    {activeContact?.chatEnded && (
                        <div className="mt-4 rounded-xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
                            This persona has ended the conversation for this chat.
                        </div>
                    )}

                    <div className="mt-5 max-h-[55vh] min-h-72 overflow-y-auto rounded-2xl border border-dashed border-line bg-cream/40 p-6 text-center text-sm text-stone-soft">
                        {(messagesByPersona[activeContactId] ?? []).length === 0 ? (
                            'Chat history is empty.'
                        ) : (
                            <div className="space-y-3 text-left">
                                {(messagesByPersona[activeContactId] ?? []).map((msg, index) => (
                                    <div
                                        key={`${msg.role}-${index}`}
                                        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm ${
                                            msg.role === 'user'
                                                ? 'ml-auto bg-brand-tint text-ink-soft'
                                                : 'mr-auto border border-line bg-white text-stone'
                                        }`}
                                    >
                                        {msg.content}
                                    </div>
                                ))}
                                <div ref={messagesEndRef} />
                            </div>
                        )}
                    </div>

                    <div className="mt-6 flex items-end gap-3 border-t border-line pt-4">
                        <div className="flex-1">
                            <textarea
                                ref={chatInputRef}
                                autoFocus
                                placeholder={
                                    activeContact?.chatEnded
                                        ? 'This conversation has ended.'
                                        : 'Type your message...'
                                }
                                disabled={!activePersonaAvailable || isSending}
                                className={`w-full resize-none rounded-xl border px-4 py-3 text-sm transition focus:outline-none focus:ring-4 ${
                                    overWordLimit
                                        ? 'border-brand focus:border-brand focus:ring-brand/12'
                                        : 'border-line focus:border-brand focus:ring-brand/12'
                                } ${
                                    activePersonaAvailable
                                        ? 'bg-white text-ink-soft'
                                        : 'bg-cream text-stone-soft'
                                }`}
                                rows={2}
                                value={inputValue}
                                onChange={(event) => setInputValue(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault()
                                        handleSend()
                                    }
                                }}
                            />
                            <p
                                className={`mt-1 text-right text-xs ${
                                    overWordLimit ? 'text-brand' : 'text-stone-soft'
                                }`}
                            >
                                {wordCount}/{MAX_MESSAGE_WORDS} words
                            </p>
                        </div>
                        <button
                            type="button"
                            disabled={
                                !activePersonaAvailable ||
                                isSending ||
                                !inputValue.trim() ||
                                overWordLimit
                            }
                            onMouseDown={(event) => {
                                event.preventDefault()
                            }}
                            onClick={handleSend}
                            className={`rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-sm transition ${
                                !activePersonaAvailable ||
                                isSending ||
                                !inputValue.trim() ||
                                overWordLimit
                                    ? 'cursor-not-allowed bg-[#d6cfc2]'
                                    : 'bg-brand hover:brightness-95'
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
                    <div className="rounded-2xl border border-line bg-white p-4 shadow-soft">
                        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                            Case Brief
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-stone">
                            {caseData?.initial_brief ?? 'Loading brief...'}
                        </p>
                    </div>

                    <SimulationClock
                        startTime={startTime}
                        totalDurationSeconds={totalDurationSeconds}
                    />

                    <div className="rounded-2xl border border-line bg-white p-4 shadow-soft">
                        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                            Your Notes
                        </h3>
                        <textarea
                            className="mt-3 h-40 w-full resize-none rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
                            placeholder="Write your notes here..."
                            value={notes}
                            onChange={(event) => setNotes(event.currentTarget.value)}
                            onBlur={flushNotes}
                        />
                    </div>
                </aside>
            </main>
            <button
                type="button"
                onClick={handleEndSimulation}
                className="fixed bottom-6 left-6 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-ink-soft"
            >
                End simulation
            </button>
        </div>
    )
}

export default Home
