import { notifications } from '@mantine/notifications'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../client.js'
import { useSimulationRun } from '../../hooks/useSimulationRun.js'
import SimulationClock from './SimulationClock.jsx'

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
    } = useSimulationRun()

    const [inputValue, setInputValue] = useState('')
    const [notes, setNotes] = useState('')

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
                        ? 'bg-[#5b5fc7] text-white'
                        : 'bg-slate-200 text-slate-600'
                }`}
            >
                {contact.initials}
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-slate-50">
            <header className="bg-[#5b5fc7] text-white">
                <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
                    <div>
                        <h1 className="text-lg font-semibold tracking-wide font-display">
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
                                            selectContact(contact.id)
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
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault()
                                    handleSend()
                                }
                            }}
                        />
                        <button
                            type="button"
                            disabled={!activePersonaAvailable || isSending || !inputValue.trim()}
                            onMouseDown={(event) => {
                                event.preventDefault()
                            }}
                            onClick={handleSend}
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

                    <SimulationClock
                        startTime={startTime}
                        totalDurationSeconds={totalDurationSeconds}
                    />

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

export default Home
