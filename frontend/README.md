# caseLab frontend

React + Vite SPA for Wisconsin CaseForm Lab.

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

- `VITE_API_BASE` — base URL of the backend. No trailing slash. See `.env.example`.
- `VITE_GOOGLE_CLIENT_ID` — Google OAuth client id for admin Google Sign-In
  (`frontend/src/pages/admin/Login.jsx`). Must be the same client id the
  backend's `GOOGLE_CLIENT_ID` checks the ID token's `aud` claim against
  (`backend/settings.py`).
