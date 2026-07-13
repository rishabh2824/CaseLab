# caseLab frontend

React + Vite SPA for Wisconsin Case Lab.

## Prerequisites

- Node 20+
- pnpm (`npm i -g pnpm`)

## Setup

```bash
pnpm install
```

Create `frontend/.env` (git-ignored) — see Environment below for the keys.

## Scripts

- `pnpm dev` — start the dev server (calls the backend directly at `VITE_API_BASE`; no dev proxy)
- `pnpm build` — production build to `dist/`
- `pnpm preview` — preview the production build
- `pnpm lint` — Biome lint + checks
- `pnpm format` — Biome auto-format

## Environment

- `VITE_API_BASE` — base URL of the backend. No trailing slash.
- `VITE_GOOGLE_CLIENT_ID` — Google OAuth client id for admin Google Sign-In
  (`frontend/src/pages/admin/SignInButton.jsx`). Must be the same client id the
  backend's `GOOGLE_CLIENT_ID` checks the ID token's `aud` claim against
  (`backend/settings.py`).
