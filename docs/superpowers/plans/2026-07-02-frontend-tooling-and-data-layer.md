# Frontend Tooling + Data-Layer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the `frontend/` app to pnpm + biome, adopt TanStack Query for data fetching, and centralize `sessionStorage` session state in a Zustand store.

**Architecture:** Four sequential phases. Each phase ends green on `pnpm lint` + `pnpm build`. Phase 3 introduces a single `apiFetch` wrapper + React Query; Phase 4 replaces raw `sessionStorage` access with a Zustand `persist` store. Routing stays on `react-router-dom`.

**Tech Stack:** React 19, Vite 7, Mantine 8, Tailwind 4, pnpm, Biome, `@tanstack/react-query`, Zustand.

**No test suite exists.** Verification for every task = `pnpm lint` && `pnpm build` (run from `frontend/`), plus the manual flow checks noted in the final task. All commands run from `C:\Users\risha\PycharmProjects\caseLab\frontend` unless stated.

---

## Phase 1 — pnpm

### Task 1: Switch package manager to pnpm

**Files:**
- Modify: `frontend/pnpm-workspace.yaml`
- Delete: `frontend/package-lock.json`
- Modify: `frontend/README.md`

- [ ] **Step 1: Fix `pnpm-workspace.yaml`**

It currently holds placeholder text. Replace the entire file with:

```yaml
onlyBuiltDependencies:
  - '@swc/core'
  - esbuild
```

- [ ] **Step 2: Remove the npm lockfile**

```bash
rm -f package-lock.json
```

- [ ] **Step 3: Reinstall with pnpm**

```bash
rm -rf node_modules
pnpm install
```
Expected: completes, `pnpm-lock.yaml` updated, no errors. If pnpm prompts to approve build scripts for `@swc/core`/`esbuild`, the `onlyBuiltDependencies` entry pre-approves them.

- [ ] **Step 4: Verify build works under pnpm**

```bash
pnpm build
```
Expected: Vite build succeeds, `dist/` produced.

- [ ] **Step 5: Update README**

Replace the stock Vite template `frontend/README.md` with project-accurate content:

```markdown
# caseLab frontend

React + Vite SPA for Wisconsin Case Lab.

## Prerequisites

- Node 20+
- pnpm (`npm i -g pnpm`)

## Setup

```bash
pnpm install
cp .env.example .env   # set VITE_API_BASE
```

## Scripts

- `pnpm dev` — start the dev server (proxies `/api` to `http://127.0.0.1:8000`)
- `pnpm build` — production build to `dist/`
- `pnpm preview` — preview the production build
- `pnpm lint` — Biome lint + checks
- `pnpm format` — Biome auto-format

## Environment

`VITE_API_BASE` — base URL of the backend. No trailing slash. See `.env.example`.
```

- [ ] **Step 6: Commit**

```bash
git add frontend/pnpm-workspace.yaml frontend/pnpm-lock.yaml frontend/README.md
git rm --cached frontend/package-lock.json 2>/dev/null; git add -A frontend/package-lock.json
git commit -m "chore(frontend): switch package manager from npm to pnpm"
```

---

## Phase 2 — Biome

### Task 2: Replace ESLint with Biome

**Files:**
- Delete: `frontend/eslint.config.js`
- Create: `frontend/biome.json`
- Modify: `frontend/package.json`

- [ ] **Step 1: Add Biome, remove ESLint packages**

```bash
pnpm remove eslint @eslint/js eslint-plugin-react-hooks eslint-plugin-react-refresh globals
pnpm add -D @biomejs/biome
```

- [ ] **Step 2: Delete the ESLint config**

```bash
rm -f eslint.config.js
```

- [ ] **Step 3: Create `frontend/biome.json`**

Matches the existing style (4-space indent, single quotes, no semicolons — as seen across the source). `dist` is ignored.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignoreUnknown": true, "includes": ["src/**", "*.js", "*.jsx"] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 4,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded",
      "jsxQuoteStyle": "double",
      "trailingCommas": "all"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "useExhaustiveDependencies": "warn"
      }
    }
  }
}
```

- [ ] **Step 4: Update `package.json` scripts**

Replace the `lint` script and add `format`:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "lint": "biome check",
    "format": "biome format --write .",
    "preview": "vite preview"
  },
```

- [ ] **Step 5: Run Biome and normalize formatting**

```bash
pnpm biome check --write .
```
Expected: applies formatting/safe fixes. Review the diff — it should be whitespace/quote/import-order only. If Biome reports unfixable lint errors, read each and fix by hand; do not change runtime behavior.

- [ ] **Step 6: Verify lint + build pass**

```bash
pnpm lint && pnpm build
```
Expected: `pnpm lint` exits 0, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/biome.json frontend/package.json frontend/pnpm-lock.yaml frontend/eslint.config.js frontend/src
git commit -m "chore(frontend): replace eslint with biome"
```

---

## Phase 3 — TanStack Query

### Task 3: Add the API client wrapper + QueryClientProvider

**Files:**
- Create: `frontend/src/api/client.js`
- Modify: `frontend/src/main.jsx`
- Modify: `frontend/package.json` (via pnpm add)

- [ ] **Step 1: Install React Query**

```bash
pnpm add @tanstack/react-query
```

- [ ] **Step 2: Create `frontend/src/api/client.js`**

Centralizes the `apiBase` resolution + `X-Admin-Token` header + JSON handling currently duplicated across ~12 call sites.

```js
// Base URL of the backend. No trailing slash. All routes live under `${API_BASE}/api/...`.
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

/**
 * Fetch a JSON endpoint under the API base.
 * Throws an Error (with the backend `detail` when present) on non-2xx.
 *
 * @param {string} path        e.g. `/api/cases`
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {any}    [opts.body]        JSON-serialized automatically
 * @param {string} [opts.adminToken]  sent as `X-Admin-Token`
 * @param {object} [opts.headers]     extra headers
 */
export async function apiFetch(path, { method = 'GET', body, adminToken, headers } = {}) {
    const finalHeaders = { ...headers }
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
    if (adminToken) finalHeaders['X-Admin-Token'] = adminToken

    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
        let detail
        try {
            detail = (await response.json())?.detail
        } catch {
            // non-JSON error body; fall through to status text
        }
        const error = new Error(detail || `Request failed: ${response.status}`)
        error.status = response.status
        throw error
    }
    // 204 / empty bodies
    const text = await response.text()
    return text ? JSON.parse(text) : null
}
```

- [ ] **Step 3: Wrap the app in `QueryClientProvider`**

Rewrite `frontend/src/main.jsx`:

```jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import '@mantine/core/styles.css'
import './index.css'
import App from './App.jsx'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false },
    },
})

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <MantineProvider>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </MantineProvider>
        </QueryClientProvider>
    </StrictMode>,
)
```

- [ ] **Step 4: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.js frontend/src/main.jsx frontend/package.json frontend/pnpm-lock.yaml
git commit -m "feat(frontend): add apiFetch client and React Query provider"
```

---

### Task 4: Convert AdminTemplatePicker cases list to useQuery

**Files:**
- Modify: `frontend/src/pages/AdminTemplatePicker.jsx:1-30`

- [ ] **Step 1: Replace the manual fetch/useEffect with useQuery**

Replace the imports and the state/effect block (lines 1–30) with:

```jsx
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'

function AdminTemplatePicker({ mode = 'template' }) {
    const navigate = useNavigate()
    const adminToken = sessionStorage.getItem('caseLabAdminToken') || ''

    const {
        data,
        isLoading: loading,
        error: queryError,
    } = useQuery({
        queryKey: ['cases'],
        queryFn: () => apiFetch('/api/cases', { adminToken }),
    })

    const cases = data?.cases ?? []
    const error = queryError ? queryError.message || 'Failed to load cases.' : ''
```

Leave the rest of the component (the JSX from `const isEditMode = ...` onward) unchanged — it already reads `loading`, `error`, and `cases`.

- [ ] **Step 2: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/AdminTemplatePicker.jsx
git commit -m "refactor(frontend): load cases via useQuery"
```

---

### Task 5: Convert Home verify/start to useMutation

**Files:**
- Modify: `frontend/src/pages/Home.jsx:1-55`

- [ ] **Step 1: Rewrite the top of the component**

Replace imports + the state + `handleSubmit` (lines 1–55) with the version below. Behavior is identical: try admin verify first, else start a student simulation; sessionStorage writes are unchanged in this task (Zustand comes in Phase 4).

```jsx
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'

function Home() {
    const [accessCode, setAccessCode] = useState('')
    const [error, setError] = useState('')
    const navigate = useNavigate()

    const { mutate: submit, isPending: isSubmitting } = useMutation({
        mutationFn: async (code) => {
            // Admin path: verify the token server-side.
            try {
                await apiFetch('/api/admin/verify', { adminToken: code })
                return { kind: 'admin', code }
            } catch {
                // Not an admin token — treat as a student access code.
            }
            const normalized = code.toUpperCase()
            const data = await apiFetch('/api/simulations/start', {
                method: 'POST',
                body: { access_code: normalized },
            })
            return { kind: 'student', normalized, data }
        },
        onSuccess: (result) => {
            setError('')
            if (result.kind === 'admin') {
                sessionStorage.setItem('caseLabAdminToken', result.code)
                navigate('/admin')
                return
            }
            sessionStorage.setItem('caseLabStart', String(Date.now()))
            sessionStorage.setItem('caseLabAccessCode', result.normalized)
            sessionStorage.setItem('caseLabRunId', result.data.run_id)
            sessionStorage.setItem('caseLabBootstrap', JSON.stringify(result.data))
            navigate('/student')
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
```

Leave the JSX return block unchanged — it already reads `accessCode`, `error`, `isSubmitting`, `handleSubmit`.

- [ ] **Step 2: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Home.jsx
git commit -m "refactor(frontend): submit access code via useMutation"
```

---

### Task 6: Convert case.jsx load to useQuery and save to useMutation

**Files:**
- Modify: `frontend/src/case.jsx:1-36` (imports + top-of-component)
- Modify: `frontend/src/case.jsx:113-160` (load template effect)
- Modify: `frontend/src/case.jsx:264-305` (save flow)

- [ ] **Step 1: Update imports and add hooks**

At the top import block, add:

```jsx
import { useQuery, useMutation } from '@tanstack/react-query'
import { apiFetch } from './api/client'
```

Keep `useEffect`/`useState` imports (still used elsewhere in the file).

- [ ] **Step 2: Replace the load-template effect (lines 113–160) with a useQuery + sync effect**

The component holds form field state, so we fetch via `useQuery` (enabled only when there's a source id) and copy the result into the fields when it arrives.

```jsx
    const sourceCaseId = editCaseId || templateId

    const { data: loadedCase, isFetching: isLoadingTemplate, error: loadError } = useQuery({
        queryKey: ['case', sourceCaseId],
        queryFn: () => apiFetch(`/api/cases/${sourceCaseId}`, { adminToken }),
        enabled: Boolean(sourceCaseId),
    })

    useEffect(() => {
        if (!loadedCase?.case) return
        const templateCase = loadedCase.case
        setCaseName(templateCase.caseName ?? '')
        setInitialBrief(templateCase.initialBrief ?? '')
        setCommonInformation(templateCase.commonInformation ?? '')
        setSimulationDurationMinutes(templateCase.simulationDurationMinutes ?? null)
        setAccessCode(templateCase.accessCode ?? '')
        setTotalPersonas(templateCase.totalNonReferredPersonas ?? null)
        setPersonas((templateCase.personas ?? []).map((persona) => normalizePersona(persona)))
    }, [loadedCase])

    useEffect(() => {
        if (loadError) {
            setSubmitError(
                loadError.message ||
                    (isEditMode
                        ? 'Failed to load case for editing.'
                        : 'Failed to load case template.'),
            )
        }
    }, [loadError, isEditMode])
```

Delete the old `useEffect(() => { const loadTemplate = ... }, [...])` block and the `setIsLoadingTemplate` state declaration (replaced by `isLoadingTemplate` from the query). Remove `const [isLoadingTemplate, setIsLoadingTemplate] = useState(false)` from the state block near line 21.

- [ ] **Step 3: Wrap the save flow in useMutation**

The `uploadFile`, `normalizeFileEntry`, `normalizeProfilePhoto`, `buildPersonaPayload`, and `buildPrefix` helpers stay as-is. Replace the raw presign/PUT/save fetches so the save POST/PUT goes through `apiFetch`, and the whole submit is a mutation. Keep `uploadFile`'s presign call through `apiFetch`, but the S3/Spaces PUT stays a raw `fetch` (it targets an external presigned URL, not our API).

Change `uploadFile`'s presign call to:

```jsx
        const uploadFile = async (file, prefix) => {
            const presign = await apiFetch('/api/uploads/presign', {
                method: 'POST',
                adminToken,
                body: {
                    file_name: file.name,
                    content_type: file.type || null,
                    prefix,
                },
            })
            const putResponse = await fetch(presign.upload_url, {
                method: 'PUT',
                headers: {
                    'Content-Type': presign.content_type || 'application/octet-stream',
                },
                body: file,
            })
            if (!putResponse.ok) {
                throw new Error('Failed to upload file to Spaces.')
            }
            return {
                bucket: presign.bucket,
                object_key: presign.object_key,
                file_name: presign.file_name,
                content_type: presign.content_type,
            }
        }
```

Add a save mutation (place it near the other hooks, above `handleSubmit`):

```jsx
    const saveMutation = useMutation({
        mutationFn: (payload) =>
            apiFetch(isEditMode ? `/api/cases/${editCaseId}` : '/api/cases', {
                method: isEditMode ? 'PUT' : 'POST',
                adminToken,
                body: payload,
            }),
        onSuccess: () =>
            setSubmitSuccess(
                isEditMode ? 'Case updated successfully.' : 'Case saved successfully.',
            ),
        onError: (error) => {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        },
    })
```

Replace the `try { ... const saveResponse = await fetch(...) ... }` block (lines ~264–304) with:

```jsx
        try {
            const prefix = buildPrefix()
            const personasPayload = await Promise.all(
                personas.map((persona) => buildPersonaPayload(persona, prefix)),
            )
            const payload = {
                caseName: caseName.trim(),
                initialBrief: initialBrief.trim(),
                commonInformation: commonInformation.trim(),
                simulationDurationMinutes,
                accessCode: accessCode.trim(),
                totalNonReferredPersonas: totalPersonas,
                personas: personasPayload,
            }
            saveMutation.mutate(payload)
        } catch (error) {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        }
```

(The uploads run before `saveMutation.mutate`; their failures are caught by this `try`. The save's own success/error are handled by the mutation callbacks.)

- [ ] **Step 4: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/case.jsx
git commit -m "refactor(frontend): load case via useQuery, save via useMutation"
```

---

### Task 7: Convert StudentHome polling to refetchInterval and send/export to useMutation

**Files:**
- Modify: `frontend/src/pages/StudentHome.jsx:1-2` (imports)
- Modify: `frontend/src/pages/StudentHome.jsx:546-600` (15s polling effect → query)
- Modify: `frontend/src/pages/StudentHome.jsx:429-544` (sendMessage → mutation)
- Modify: `frontend/src/pages/StudentHome.jsx:387-411` (export → mutation)

> This is the highest-risk file. Keep all local state (`messagesByPersona`, `contacts`, `sharedFiles`, notifications, `sendingPersonaIdRef`) and the dedup/merge logic. React Query owns only the *transport + interval*; the merge stays in callbacks. The 1s elapsed-time interval (lines 343–355) is NOT a fetch — leave it untouched.

- [ ] **Step 1: Update imports**

```jsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
```

- [ ] **Step 2: Replace the 15s polling `setInterval` (lines 546–600) with a polling useQuery**

The existing initial-load effect (lines 267–342) stays as-is for now — it handles the bootstrap handoff and first paint. Add a polling query whose `queryFn` reads the stored run id and whose merge logic mirrors the old interval body exactly:

```jsx
    useQuery({
        queryKey: ['simulation', runId],
        enabled: Boolean(runId),
        refetchInterval: 15000,
        refetchOnWindowFocus: false,
        queryFn: async () => {
            const storedRun = sessionStorage.getItem('caseLabRunId')
            if (!storedRun) return null
            const data = await apiFetch(`/api/simulations/${storedRun}`)
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
```

Delete the entire old `useEffect(() => { const intervalId = window.setInterval(async () => { ... }, 15000); return () => window.clearInterval(intervalId) }, [apiBase])` block (lines ~546–600).

- [ ] **Step 3: Convert `sendMessage` (lines 429–544) to useMutation**

Keep the optimistic echo and all `onSuccess` merge logic. Replace the `sendMessage` function definition with a mutation + a thin `sendMessage` caller so the JSX `onClick`/`onKeyDown` handlers keep working unchanged:

```jsx
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
```

Remove the old `const [isSending, setIsSending] = useState(false)` declaration and every `setIsSending(...)` call — `isSending` now derives from `sendMutation.isPending`.

- [ ] **Step 4: Convert `handleExportPdf` (lines 387–411) to useMutation**

```jsx
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
```

Remove the old `const [isExporting, setIsExporting] = useState(false)` declaration.

> Note: the initial-load effect (lines 267–342) still uses raw `fetch`. Leave it in this task — it's the bootstrap/first-paint path and will be simplified in Phase 4 when the store owns `runId`/`bootstrap`. Its `apiBase` local may remain.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass. Fix any "unused variable" (e.g. leftover `apiBase`) or exhaustive-deps warnings Biome/build surface.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/StudentHome.jsx
git commit -m "refactor(frontend): poll via refetchInterval, send/export via useMutation"
```

---

## Phase 4 — Zustand session store

### Task 8: Create the session store

**Files:**
- Create: `frontend/src/stores/sessionStore.js`
- Modify: `frontend/package.json` (via pnpm add)

- [ ] **Step 1: Install Zustand**

```bash
pnpm add zustand
```

- [ ] **Step 2: Create `frontend/src/stores/sessionStore.js`**

Backed by `sessionStorage` via `persist`, so refresh keeps the session (matching current behavior). Exposes typed actions replacing the raw key access.

```js
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Centralized session state. Previously stored as loose `caseLab*` keys in
// sessionStorage across four files; now one typed source of truth.
export const useSessionStore = create(
    persist(
        (set, get) => ({
            adminToken: '',
            runId: '',
            accessCode: '',
            bootstrap: null,
            startTime: null,

            setAdminToken: (token) => set({ adminToken: token }),

            // Called when a student simulation starts. `bootstrap` is the full
            // start-response payload, consumed once by StudentHome.
            startRun: ({ runId, accessCode, bootstrap, startTime }) =>
                set({
                    runId: runId ?? '',
                    accessCode: accessCode ?? '',
                    bootstrap: bootstrap ?? null,
                    startTime: startTime ?? Date.now(),
                }),

            setRunId: (runId) => set({ runId }),

            // Read the bootstrap payload exactly once, then clear it.
            consumeBootstrap: () => {
                const { bootstrap } = get()
                if (bootstrap) set({ bootstrap: null })
                return bootstrap
            },

            // Clear a student run (keeps adminToken).
            clearRun: () =>
                set({ runId: '', accessCode: '', bootstrap: null, startTime: null }),

            // Clear everything (logout).
            clearAll: () =>
                set({
                    adminToken: '',
                    runId: '',
                    accessCode: '',
                    bootstrap: null,
                    startTime: null,
                }),
        }),
        {
            name: 'caseLabSession',
            storage: createJSONStorage(() => sessionStorage),
        },
    ),
)
```

- [ ] **Step 3: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/stores/sessionStore.js frontend/package.json frontend/pnpm-lock.yaml
git commit -m "feat(frontend): add zustand session store"
```

---

### Task 9: Point RequireAdmin, Home, and AdminTemplatePicker at the store

**Files:**
- Modify: `frontend/src/App.jsx:12-15`
- Modify: `frontend/src/pages/Home.jsx`
- Modify: `frontend/src/pages/AdminTemplatePicker.jsx`

- [ ] **Step 1: `App.jsx` RequireAdmin reads the store**

```jsx
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useSessionStore } from './stores/sessionStore'
// ...other imports unchanged

function RequireAdmin() {
    const hasAdminToken = useSessionStore((s) => Boolean(s.adminToken))
    return hasAdminToken ? <Outlet /> : <Navigate to="/" replace />
}
```

- [ ] **Step 2: `Home.jsx` writes via the store**

Import the store and replace the four `sessionStorage.setItem` calls in `onSuccess`:

```jsx
import { useSessionStore } from '../stores/sessionStore'
// ...

    const setAdminToken = useSessionStore((s) => s.setAdminToken)
    const startRun = useSessionStore((s) => s.startRun)
```

In the mutation `onSuccess`:

```jsx
        onSuccess: (result) => {
            setError('')
            if (result.kind === 'admin') {
                setAdminToken(result.code)
                navigate('/admin')
                return
            }
            startRun({
                runId: result.data.run_id,
                accessCode: result.normalized,
                bootstrap: result.data,
                startTime: Date.now(),
            })
            navigate('/student')
        },
```

- [ ] **Step 3: `AdminTemplatePicker.jsx` reads the token from the store**

Replace `const adminToken = sessionStorage.getItem('caseLabAdminToken') || ''` with:

```jsx
    const adminToken = useSessionStore((s) => s.adminToken)
```

and add `import { useSessionStore } from '../stores/sessionStore'`.

- [ ] **Step 4: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx frontend/src/pages/Home.jsx frontend/src/pages/AdminTemplatePicker.jsx
git commit -m "refactor(frontend): read admin/session state from zustand store"
```

---

### Task 10: Point case.jsx and StudentHome at the store

**Files:**
- Modify: `frontend/src/case.jsx:33`
- Modify: `frontend/src/pages/StudentHome.jsx` (session reads/writes)

- [ ] **Step 1: `case.jsx` reads adminToken from the store**

Replace `const adminToken = sessionStorage.getItem('caseLabAdminToken') || ''` (line 33) with:

```jsx
    const adminToken = useSessionStore((s) => s.adminToken)
```

Add `import { useSessionStore } from './stores/sessionStore'`.

- [ ] **Step 2: `StudentHome.jsx` — replace session reads/writes with store**

Add imports and selectors:

```jsx
import { useSessionStore } from '../stores/sessionStore'
// inside the component:
    const storeRunId = useSessionStore((s) => s.runId)
    const accessCode = useSessionStore((s) => s.accessCode)
    const startTime = useSessionStore((s) => s.startTime)
    const consumeBootstrap = useSessionStore((s) => s.consumeBootstrap)
    const setStoreRunId = useSessionStore((s) => s.setRunId)
    const clearRun = useSessionStore((s) => s.clearRun)
```

Update the touch points (keep behavior identical):

- **Initial load effect (267–342):** replace `sessionStorage.getItem('caseLabBootstrap')`/`JSON.parse` with `const bootstrap = consumeBootstrap()` (already an object; drop `JSON.parse` and the `removeItem`). Replace reads of `caseLabRunId`/`caseLabAccessCode` with `storeRunId`/`accessCode`. Replace `sessionStorage.setItem('caseLabRunId', ...)` with `setStoreRunId(...)`.
- **Elapsed-time effect (343–355):** replace the `caseLabStart` read with `startTime` from the store (fall back to `Date.now()` if null). The store now owns `startTime` (set in `startRun`), so drop the `sessionStorage.setItem('caseLabStart', ...)` seeding.
- **Duration-expiry effect (364–372) and `handleEndSimulation` (380–386):** replace the four `sessionStorage.removeItem('caseLab*')` calls with a single `clearRun()`.
- **Polling query `queryFn` (Task 7):** replace `sessionStorage.getItem('caseLabRunId')` with `storeRunId`; guard `enabled: Boolean(storeRunId)` and use `runId || storeRunId` where the run id is needed.

- [ ] **Step 3: Verify no raw session keys remain**

```bash
grep -rn "caseLab" frontend/src --include=*.jsx --include=*.js | grep -i sessionStorage
```
Expected: no matches (all access now goes through the store; the only `caseLab` string left is the store's `name: 'caseLabSession'`).

- [ ] **Step 4: Verify**

```bash
pnpm lint && pnpm build
```
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/case.jsx frontend/src/pages/StudentHome.jsx
git commit -m "refactor(frontend): route case + student session state through store"
```

---

### Task 11: Final manual verification

**No code changes** — this task is a gate. Run the dev server against a running backend and walk both flows.

- [ ] **Step 1: Start backend + frontend**

Backend per its README (uvicorn on `127.0.0.1:8000`); then:

```bash
pnpm dev
```

- [ ] **Step 2: Admin flow**

Enter the admin access code → lands on `/admin` (RequireAdmin passes from store) → "Edit Existing Case" → case list loads (useQuery) → open a case → fields populate → change a field → Save → success message. Reload `/admin` mid-session: still authorized (persist works).

- [ ] **Step 3: Student flow**

Enter a student access code → `/student` → chat + contacts load → send a message: optimistic user bubble appears immediately, assistant reply follows → wait for the 15s poll: a scheduled/referred contact unlock or shared file fires a notification → the timer counts down and, at duration end, redirects to `/`. Export PDF downloads a file.

- [ ] **Step 4: Confirm clean console**

No uncaught errors, no React Query "missing queryFn" warnings, no exhaustive-deps runtime issues.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A frontend
git commit -m "fix(frontend): address issues found in manual verification"
```

---

## Self-review notes

- **Spec coverage:** Phase 1 (Task 1), Phase 2 (Task 2), Phase 3 = apiFetch + provider (Task 3) + all read/write conversions (Tasks 4–7), Phase 4 = store (Task 8) + all call-site swaps (Tasks 9–10), verification (Task 11). All spec sections covered.
- **StudentHome risk** is isolated to Task 7 (transport only) and Task 10 (session only), with local merge state explicitly preserved, per the spec caveat.
- **Routing untouched** — `react-router-dom` retained everywhere; no TanStack Router.
- **Naming consistency:** store actions (`setAdminToken`, `startRun`, `setRunId`, `consumeBootstrap`, `clearRun`, `clearAll`) are used identically across Tasks 8–10. `apiFetch` signature is stable across Tasks 3–7.
