# Wisconsin Case Lab

A simulation platform for business-school case studies: students enter an access
code and interact with LLM-driven personas in a timed chat, while admins author
cases (personas, referral trees, shared files) through a Google-authenticated
dashboard.

## Tech stack

**Backend** — FastAPI (Python 3.14, [uv](https://docs.astral.sh/uv/)), SQLModel +
Alembic over Neon Postgres (`asyncpg`), DigitalOcean Spaces for file storage,
Anthropic Claude for persona replies, Google Identity Services (FedCM ID-token
sign-in) + hand-rolled JWT for admin auth.

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
  Postgres), `FRONTEND_URLS`, `LLM_KEY`, `GOOGLE_CLIENT_ID`, `JWT_SECRET`.
  See `backend/infra/settings.py` for the full list and defaults. No client
  secret is needed — admin auth only verifies ID tokens locally, it never
  calls Google to exchange one (see Workflows below).
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

**Auth (admins only).** GIS (`accounts.google.com/gsi/client`) is loaded lazily
— only on the first click of "Admin Login" — since the vast majority of
landing-page visitors are students who never touch it. That click opens a
small popover and renders Google's own icon-only Sign In With Google button
into it (`accounts.id.renderButton`, not `.prompt()`/One Tap — One Tap only
works via FedCM, which Safari and Firefox don't support, so it fails
silently there; `renderButton`'s click falls back to a real popup on those
browsers instead, making it the one mechanism here that works everywhere).
It has to be Google's actual rendered element, not a custom-styled one —
Google's branding guidelines require their button be shown unmodified and
unobscured, and a custom trigger can only invoke `.prompt()` (i.e. the
FedCM-only path). Clicking it hands the frontend a signed ID token (a JWT)
directly, which gets POSTed as `credential` to `/api/admin/login`. The
backend verifies its signature against Google's cached public keys locally
— no outbound call to Google, unlike the authorization-code flow this
replaced. Once verified, the backend checks the token's email against the
`admins` table and — if found — signs its own JWT and sets it as an
httpOnly, `SameSite=Lax` cookie. The frontend never sees that JWT itself;
the browser just attaches the cookie automatically.


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
turn-specific block (this turn's eligible referrals/files). The reply itself 
is requested as an Anthropic structured output (`{reply, introduce, send_files}`) 
and streamed via SSE; a JSON parser (`ReplyExtractor`) extracts just the 
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
