import { toast } from 'svelte-sonner'
import { goto } from '$app/navigation'
import { apiFetch, streamChat } from '../api/client.js'
import { session } from '../session.svelte.js'
import { mapContact, normalizeHistories } from './Helpers.js'

const notify = (message) => toast(message, { duration: 4000 })

// How long to wait after the last keystroke before persisting notes, so
// typing doesn't fire a write per character. flushNotes() bypasses this.
const NOTES_SAVE_DEBOUNCE_MS = 800

class RunStore {
	raw = $state(null)
	loadError = $state('')
	activeContactId = $state(null)
	streamingTurn = $state(null)
	notes = $state('')
	isSending = $state(false)

	#initialized = false
	#notesInitialized = false
	#notesSaveTimer = null
	#seenContacts = new Set()
	#seenFiles = new Set()
	#seenInitialized = false
	#expiryInterval = null

	caseData = $derived(this.raw?.case ?? null)
	contacts = $derived((this.raw?.contacts ?? []).map(mapContact))
	sharedFiles = $derived(this.raw?.shared_files ?? [])
	serverHistories = $derived(normalizeHistories(this.raw?.histories ?? {}))
	messagesByPersona = $derived(
		this.streamingTurn
			? { ...this.serverHistories, [this.streamingTurn.personaId]: this.streamingTurn.messages }
			: this.serverHistories,
	)
	activeContact = $derived(this.contacts.find((c) => c.id === this.activeContactId) ?? this.contacts[0] ?? null)
	selectedContact = $derived(this.contacts.find((c) => c.id === this.activeContactId) ?? null)
	activePersonaAvailable = $derived(Boolean(this.selectedContact?.available && !this.selectedContact?.chatEnded))
	totalDurationSeconds = $derived(
		typeof this.caseData?.simulation_duration === 'number' ? this.caseData.simulation_duration * 60 : null,
	)

	// Establishes a run exactly once: resume a persisted runId, else start
	// from the access code, else bail home.
	async init() {
		if (this.#initialized) return
		this.#initialized = true
		if (session.runId) {
			await this.refresh(session.runId)
		} else if (session.accessCode) {
			await this.startSession(session.accessCode)
		} else {
			goto('/')
		}
	}

	async startSession(code) {
		try {
			const fresh = await apiFetch('/api/simulations/start', {
				method: 'POST',
				body: { access_code: code },
			})
			this.raw = fresh
			session.startRun({ runId: fresh.run_id, accessCode: code, startTime: Date.now() })
			this.#afterLoad()
		} catch {
			goto('/')
		}
	}

	async refresh(runId) {
		try {
			const data = await apiFetch(`/api/simulations/${runId}`)
			this.raw = data
			this.#afterLoad()
		} catch (err) {
			if (err.status === 404) {
				this.#handleExpired()
			} else {
				this.loadError = err.message || 'Failed to load the simulation.'
			}
		}
	}

	#afterLoad() {
		if (!this.#notesInitialized && this.raw?.notes !== undefined) {
			this.notes = this.raw.notes
			this.#notesInitialized = true
		}
		if (this.activeContactId == null) {
			const rows = this.raw?.contacts ?? []
			if (rows.length > 0) this.activeContactId = this.raw.active_persona_id || rows[0].id
		}
		this.#diffAndNotify()
		this.#ensureExpiryWatch()
	}

	// Notifies on newly-unlocked contacts / newly-shared files by diffing
	// against what's already been surfaced (never fires for the initial roster).
	#diffAndNotify() {
		const rows = this.raw?.contacts ?? []
		const files = this.raw?.shared_files ?? []
		if (this.#seenInitialized) {
			for (const c of rows) {
				if (!this.#seenContacts.has(c.id)) notify(`New contact unlocked: ${c.name} (${c.role})`)
			}
			for (const f of files) {
				if (!this.#seenFiles.has(f.file_id)) notify(`File shared: ${f.file_name}`)
			}
		}
		this.#seenContacts = new Set(rows.map((c) => c.id))
		this.#seenFiles = new Set(files.map((f) => f.file_id))
		this.#seenInitialized = true
	}

	#handleExpired() {
		session.setRunId('')
		this.activeContactId = null
		if (session.accessCode) this.startSession(session.accessCode)
		else goto('/')
	}

	// Auto-ends the run once the case's configured duration elapses.
	#ensureExpiryWatch() {
		if (this.#expiryInterval) return
		if (typeof this.totalDurationSeconds !== 'number') return
		const start = session.startTime ?? Date.now()
		const checkExpiry = () => {
			const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000))
			if (elapsed >= this.totalDurationSeconds) {
				window.clearInterval(this.#expiryInterval)
				this.#expiryInterval = null
				this.endSimulation()
			}
		}
		checkExpiry()
		this.#expiryInterval = window.setInterval(checkExpiry, 1000)
	}

	selectContact(contactId) {
		this.activeContactId = contactId
	}

	setNotes(value) {
		this.notes = value
		if (this.#notesSaveTimer) window.clearTimeout(this.#notesSaveTimer)
		this.#notesSaveTimer = window.setTimeout(() => {
			this.#notesSaveTimer = null
			this.#saveNotesNow()
		}, NOTES_SAVE_DEBOUNCE_MS)
	}

	// Saves immediately, skipping the debounce — call on blur so a click away
	// from the textarea doesn't leave an edit unsaved.
	flushNotes() {
		if (this.#notesSaveTimer) {
			window.clearTimeout(this.#notesSaveTimer)
			this.#notesSaveTimer = null
		}
		this.#saveNotesNow()
	}

	async #saveNotesNow() {
		const id = session.runId
		if (!id) return
		try {
			await apiFetch(`/api/simulations/${id}/notes`, {
				method: 'PUT',
				body: { notes: this.notes },
			})
		} catch (err) {
			console.error(err)
			notify('Could not save your notes. Please try again.')
		}
	}

	endSimulation() {
		this.flushNotes()
		session.clearRun()
		goto('/')
	}

	// Folds a turn's meta (unlocked contacts, shared files, chat-state) into
	// raw so it shows immediately; mutated in place since raw is deep $state.
	applyMeta(personaId, meta) {
		if (!this.raw) return
		if (meta.new_contacts?.length) {
			const existing = new Set(this.raw.contacts.map((c) => c.id))
			for (const c of meta.new_contacts) {
				if (existing.has(c.id)) continue
				this.raw.contacts.push({ ...c, available: c.available ?? true })
			}
		}
		const target = this.raw.contacts.find((c) => c.id === personaId)
		if (target) {
			target.chat_ended = meta.chat_ended ?? target.chat_ended
			target.chat_end_reason = meta.chat_end_reason ?? target.chat_end_reason
			target.warning_count = meta.warning_count ?? target.warning_count
		}
		if (meta.shared_files?.length) {
			const existingFiles = new Set(this.raw.shared_files.map((f) => f.file_id))
			for (const f of meta.shared_files) {
				if (existingFiles.has(f.file_id)) continue
				this.raw.shared_files.push(f)
			}
		}
		this.#diffAndNotify()
	}

	// Overwrites a persona's history — used to commit a completed turn.
	commitHistory(personaId, messages) {
		if (!this.raw) return
		if (!this.raw.histories) this.raw.histories = {}
		this.raw.histories[personaId] = messages
	}

	// Returns true when the message was accepted (all guards passed), so the
	// caller can clear its input exactly when the send actually starts. The
	// streaming work itself runs fire-and-forget — not awaited here — so this
	// stays synchronous, same as the old mutation's immediate `.mutate()`.
	sendMessage(rawMessage) {
		const message = (rawMessage ?? '').trim()
		if (!session.runId || !this.activeContactId || !message) return false
		if (!this.activePersonaAvailable || this.isSending) return false
		this.#runSend(this.activeContactId, message)
		return true
	}

	async #runSend(personaId, message) {
		const priorMessages = this.serverHistories[personaId] ?? []
		const overlayMessages = (streamedText) => [
			...priorMessages,
			{ role: 'user', content: message },
			{ role: 'assistant', content: streamedText },
		]

		this.streamingTurn = { personaId, messages: overlayMessages('') }
		this.isSending = true
		let streamed = ''
		let receivedDone = false
		let streamError = null
		try {
			await streamChat(`/api/simulations/${session.runId}/message`, {
				body: { persona_id: personaId, message },
				onEvent: (event) => {
					if (event.type === 'meta') {
						this.applyMeta(personaId, event.data)
					} else if (event.type === 'delta') {
						streamed += event.data.text ?? ''
						if (this.streamingTurn?.personaId === personaId) {
							this.streamingTurn = { personaId, messages: overlayMessages(streamed) }
						}
					} else if (event.type === 'done') {
						receivedDone = true
						if (Array.isArray(event.data.history)) this.commitHistory(personaId, event.data.history)
					} else if (event.type === 'error') {
						streamError = new Error(event.data.detail || 'The reply could not be generated.')
					}
				},
			})
			if (streamError) throw streamError
			// No `done` frame (e.g. the connection closed cleanly mid-reply):
			// keep what streamed rather than losing it.
			if (!receivedDone) this.commitHistory(personaId, overlayMessages(streamed))
		} catch (err) {
			console.error(err)
			// The user's turn is kept (the server recorded it before streaming
			// began); the un-generated assistant reply is dropped.
			this.commitHistory(personaId, [...priorMessages, { role: 'user', content: message }])
			if (err.message === 'This conversation has ended.') {
				const target = this.raw?.contacts?.find((c) => c.id === personaId)
				if (target) {
					target.chat_ended = true
					target.chat_end_reason = target.chat_end_reason || 'harassment'
				}
			} else {
				notify(err.message || 'Message failed. Please try again.')
			}
		} finally {
			this.streamingTurn = null
			this.isSending = false
		}
	}
}

export const run = new RunStore()
