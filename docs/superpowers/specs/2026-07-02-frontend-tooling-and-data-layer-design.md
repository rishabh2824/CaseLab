# Frontend tooling + data-layer migration

**Date:** 2026-07-02
**Scope:** `frontend/` only. No backend changes.

## Goal

Modernize the frontend's tooling and data layer:

1. Switch package manager from **npm → pnpm**.
2. Replace **eslint → biome** (lint + format in one tool; no prettier exists today).
3. Adopt **TanStack Query** for data fetching (keep `react-router-dom` for routing).
4. Add a **Zustand** store to centralize scattered `sessionStorage` session state.

## Decisions & rationale

- **Routing stays on `react-router-dom` v7.** TanStack *Query* does data fetching, not
  routing. TanStack *Router* would be a separate, larger, riskier rewrite of `App.jsx`,
  the `RequireAdmin` guard, and every `useNavigate` call — not justified here.
- **Zustand is NOT about prop drilling.** There is no significant prop drilling; components
  share state via `sessionStorage`, not props. Zustand's value here is replacing stringly-typed,
  scattered session access (~30 call sites, raw keys) with one typed source of truth.
- **`StudentHome.jsx` keeps local merge state.** Its optimistic message sends, notification
  queue, and poll-driven dedup/merge logic will not collapse cleanly into Query primitives.
  Polling becomes `refetchInterval`; the send becomes `useMutation`; local `messagesByPersona`
  and notification state remain.

## Current state (as explored)

- 9 components, ~2200 lines. Heavy files: `case.jsx` (906), `StudentHome.jsx` (890).
- ~12 `fetch()` call sites across 5 files, each with hand-rolled `useState`/`useEffect`/
  loading/error handling and a repeated `apiBase`/`X-Admin-Token` preamble.
- Routing: `react-router-dom` v7 (`main.jsx` + `App.jsx`).
- Shared state: entirely via `sessionStorage` keys — `caseLabAdminToken`, `caseLabRunId`,
  `caseLabAccessCode`, `caseLabBootstrap`, `caseLabStart`.
- pnpm files half-exist: `pnpm-lock.yaml` present, `pnpm-workspace.yaml` contains broken
  placeholder text, `package-lock.json` still present.
- No tests exist. Verification is `pnpm lint` + `pnpm build` + manual flow checks.

## Design

### Phase 1 — pnpm

- Delete `package-lock.json` and `node_modules/`.
- Fix `pnpm-workspace.yaml`: replace placeholder text with a real
  `onlyBuiltDependencies: ['@swc/core', 'esbuild']` list.
- `pnpm install` → clean `pnpm-lock.yaml`.
- Update `frontend/README.md` (currently the stock Vite template) and any docs referencing
  `npm run` to use `pnpm`.

### Phase 2 — biome

- Remove: `eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`,
  `globals`, and `eslint.config.js`.
- Add `@biomejs/biome`; add `biome.json` configured for JSX + the existing **4-space indent,
  single-quote** style the code already uses (so formatting doesn't churn the whole tree).
  Enable the React/hooks recommended rules.
- Scripts: `lint` → `biome check`, `format` → `biome format --write`.
- Run `biome check --write` once; review the diff; keep formatting changes minimal.

### Phase 3 — TanStack Query

- Add `@tanstack/react-query`. Wrap app in `QueryClientProvider` in `main.jsx` (inside the
  existing `MantineProvider`/`BrowserRouter`).
- **`src/api/client.js`** — an `apiFetch(path, { method, body, adminToken })` wrapper that
  centralizes `apiBase` resolution, the `X-Admin-Token` header, JSON body/parse, and
  throw-on-!ok. Replaces the ~12 duplicated preambles.
- **Queries (`useQuery`):**
  - `AdminTemplatePicker` — cases list (`/api/cases`).
  - `case.jsx` — load template/case (`/api/cases/:id`), enabled only when a source id exists.
  - `StudentHome` — simulation state (`/api/simulations/:runId`), with `refetchInterval`
    replacing the manual 1s polling `setInterval`. Merge logic stays in `onSuccess`/local state.
- **Mutations (`useMutation`):**
  - `Home` — admin verify + simulation start.
  - `case.jsx` — presign → upload → save (the multi-step upload flow wrapped in one mutation).
  - `StudentHome` — send message; export PDF.
- Query keys namespaced: `['cases']`, `['case', id]`, `['simulation', runId]`.

### Phase 4 — Zustand session store

- **`src/stores/sessionStore.js`** — Zustand store with `persist` middleware backed by
  `sessionStorage`, so a refresh keeps the session (matching today's behavior).
- State: `adminToken`, `runId`, `accessCode`, `bootstrap`, `startTime`.
- Actions: `setAdminToken(token)`, `startRun({ runId, accessCode, bootstrap, startTime })`,
  `consumeBootstrap()` (returns bootstrap once, then clears it), `clearRun()`, `clearAll()`.
- Replaces raw `sessionStorage.*` calls in `App.jsx` (`RequireAdmin`), `Home.jsx`,
  `case.jsx`, and `StudentHome.jsx`.
- The Home → StudentHome `bootstrap` handoff becomes a store field consumed via
  `consumeBootstrap()` instead of a JSON string round-trip through `sessionStorage`.

## Verification

No automated tests exist. After **each** phase:

- `pnpm lint` passes.
- `pnpm build` passes.

After Phases 3–4, manually verify the two risky flows:

1. **Admin:** login (access code = admin token) → `/admin` → case list loads → edit a case →
   save succeeds.
2. **Student:** access code → `/student` → chat loads → send a message (optimistic echo +
   reply) → poll-driven contact/file unlock still fires notifications → timer counts down.

## Out of scope

- TanStack Router / any routing rewrite.
- Backend changes.
- TypeScript migration.
- Restructuring `case.jsx` / `StudentHome.jsx` beyond what the data-layer swap requires.
