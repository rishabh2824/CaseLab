# Wisconsin Case Lab

A simulation platform for business-school case studies: students enter an access
code and interact with LLM-driven personas in a timed chat, while admins author
cases (personas, referral trees, shared files) through a Google-authenticated
dashboard.

## Tech stack

**Backend** — FastAPI (Python 3.14, [uv](https://docs.astral.sh/uv/)), SQLModel +
Alembic over Neon Postgres (`asyncpg`), DigitalOcean Spaces for file storage,
Claude (via [OpenRouter](https://openrouter.ai)) for persona replies, Google
Identity Services (FedCM ID-token sign-in) + hand-rolled JWT for admin auth.

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
  Postgres), `FRONTEND_URLS`, `LLM_KEY` (an [OpenRouter](https://openrouter.ai)
  API key), `GOOGLE_CLIENT_ID`, `JWT_SECRET`. See `backend/infra/settings.py`
  for the full list and defaults.
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

## Testing

Everything below runs in CI on every push and pull request
(`.github/workflows/ci.yml`).

```bash
# backend — fast suite: no database, no network, runs in ~1s
cd backend
uv run pytest -m "not db"

# backend — everything, including the Postgres-backed tests
uv run pytest
uv run ruff check .

# frontend
cd frontend
pnpm exec vitest run     # unit (node + jsdom projects)
pnpm run check           # svelte-check
pnpm run lint            # biome
pnpm run test:e2e        # Playwright, against a fully-mocked backend
```

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

**Auth (admins only).** GIS is loaded lazily only on the first click of 
"Admin Login". The click opens a small popover and renders Google's own Sign 
In With Google button. (`accounts.id.renderButton`, not `.prompt()`/One Tap — 
One Tap only works via FedCM, which Safari and Firefox don't support. It also 
has to be Google's actual rendered element, not a custom-styled one. Clicking 
it hands the frontend a signed ID token (a JWT) directly, which gets POSTed as 
`credential` to `/api/admin/login`. The backend verifies its signature against 
Google's cached public keys locally. Once verified, the backend checks the 
token's email against the `admins` table and — if found — signs its own JWT 
and sets it as an httpOnly, `SameSite=Lax` cookie. The frontend never sees that 
JWT itself; the browser just attaches the cookie automatically.


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
four kinds of OpenRouter calls. One Claude Sonnet call generates the reply, 
and up to three kinds of Claude Haiku classifier calls run concurrently:
1. A harassment/nonsense check on the message
2. One referral-unlock check for each still-locked referral the current persona could introduce
3. One file-share check for each still-withheld file the current persona could send

All classifier calls run concurrently (`asyncio.gather`); the Sonnet reply 
call runs strictly after, since its prompt depends on the other 3. The 
system prompt is split into a stable block (common case information) which
is cached, and a turn-specific block (this turn's eligible referrals/files). 
The reply text itself streams straight to the client via SSE as plain text. 
In the same streaming response, the model separately calls a 
`report_reply_metadata` tool to report which contacts it introduced and which 
files it sent this turn, driving referral/file unlocking once the stream ends.


**File uploads (two-phase, direct-to-Spaces).** The browser never sends file
bytes through the backend. It first calls `/api/uploads/presign` to get a
presigned URL, then `PUT`s the file straight to DigitalOcean Spaces from the
browser. Only the resulting object key is submitted with the case/persona
data. Spaces' CORS policy must allow `GET`/`PUT` from every origin in
`FRONTEND_URLS` for this to work.
