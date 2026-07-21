# Wisconsin Case Lab

A simulation platform for business-school case studies: students enter an access
code and interact with LLM-driven personas in a timed chat, while admins author
cases (personas, referral trees, shared files) through a Google-authenticated
dashboard.

## Tech stack

**Backend** — FastAPI (Python 3.14, [uv](https://docs.astral.sh/uv/)), SQLModel +
Alembic over Neon Postgres (`asyncpg`), DigitalOcean Spaces for file storage,
Anthropic Claude for persona replies, Google Sign-In + hand-rolled JWT for
admin auth.

**Frontend** — SvelteKit (Svelte 5 runes) in SPA mode, Tailwind 4, shadcn-svelte
(Bits UI) + svelte-sonner, built with `adapter-static` and served from
DigitalOcean App Platform alongside the API under one domain.

## Installation

```bash
# backend
cd backend
uv sync

# frontend
cd frontend
pnpm install
```

Each app reads its config from a git-ignored `.env` file in its own folder:

- `backend/.env` — `SPACES_KEY`, `SPACES_SECRET`, `POOLING`/`DIRECT` (Neon
  Postgres), `FRONTEND_URLS`, `LLM_KEY`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
  `JWT_SECRET`. See `backend/infra/settings.py` for the full list and defaults.
- `frontend/.env` — `VITE_GOOGLE_CLIENT_ID`.

Set `ENABLE_OPENAPI=true` in `backend/.env` to serve `/openapi.json` locally
(off by default — production doesn't publish its schema). Needed only to
regenerate `frontend/src/lib/api/schema.d.ts` (see below).

## Running locally

```bash
# backend — http://localhost:8000
cd backend
uv run uvicorn main:app --reload --port 8000

# frontend — http://localhost:5173
cd frontend
pnpm run dev
```

The frontend's dev server proxies `/api` to `127.0.0.1:8000`
(`/api` → backend, everything else → the static frontend, one domain).

## API types

`frontend/src/lib/api/schema.d.ts` is generated from the backend's OpenAPI
schema and checked into git — the frontend does not regenerate it at build
time. Regenerate it whenever a Pydantic request/response model changes:

```bash
# backend, with ENABLE_OPENAPI=true in .env
uv run uvicorn main:app --port 8000

# frontend
pnpm gen:api
```

## Workflows

**Auth (admins only).** The frontend calls Google's Identity Services SDK to
get an authorization code, POSTs it to `/api/admin/login`. The backend
exchanges it for a Google ID token, checks the email against the `admins`
table, and — if found — signs a JWT and sets it as an httpOnly, `SameSite=Lax`
cookie. The frontend never sees the token itself; the browser just attaches
the cookie automatically. Every admin request re-verifies the cookie and
re-fetches the admin row, so a deleted admin's session stops working
immediately rather than lingering until it expires.

**Simulation chat (SSE streaming).** Sending a student message opens a
`POST` request that stays open as a Server-Sent-Events stream
(`sse-starlette` on the backend, a `ReadableStream` + `eventsource-parser` on
the frontend). Frames arrive in order: `delta` events append tokens to the
reply as they're generated, `meta` carries side effects (newly unlocked
contacts/files, chat-ended state), and a final `done` event commits the
authoritative message history. The frontend renders an optimistic overlay
during streaming and reconciles it with `done`'s payload once the turn
completes.

**Persona reply generation (LLM pipeline).** Each student message triggers
four kinds of Anthropic calls: one Claude Sonnet call that generates the
reply, and up to three kinds of Claude Haiku classifier calls — a
harassment/nonsense check on the message, one referral-unlock check per
still-locked referral the active persona could introduce, and one
file-share check per still-withheld file they could send. All classifier
calls run concurrently (`asyncio.gather`); the Sonnet reply call runs
strictly after, since its system prompt depends on which referrals/files
the classifiers just deemed eligible. The system prompt is split into a
stable block (case brief, common information, and the active persona's own
traits/known facts) marked with a one-hour ephemeral `cache_control`, and a
turn-specific block (this turn's eligible referrals/files) that changes
every message and is never cached — conversation history is also never
cached and is resent in full (the last 6 messages of that persona's own
thread) on every call. The reply itself is requested as an Anthropic
structured output (`{reply, introduce, send_files}`) and streamed via SSE;
a small incremental JSON parser (`ReplyExtractor`) extracts just the
`reply` string's characters as they arrive for a live-typing effect, but
this is a best-effort preview only — once the stream ends, the full raw
text is re-parsed from scratch, and that authoritative parse is what gets
persisted and what drives referral/file unlocking.

**File uploads (two-phase, direct-to-Spaces).** The browser never sends file
bytes through the backend. It first calls `/api/uploads/presign` to get a
presigned URL, then `PUT`s the file straight to DigitalOcean Spaces from the
browser. Only the resulting object key is submitted with the case/persona
data. Spaces' CORS policy must allow `GET`/`PUT` from every origin in
`FRONTEND_URLS` for this to work.
