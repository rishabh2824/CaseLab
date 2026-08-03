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
  for the full list and defaults. No client secret is needed — admin auth only
  verifies ID tokens locally, it never calls Google to exchange one (see
  Workflows below).
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

**Backend layout.** `tests/unit/` never touches a database, the network, or the
LLM — the simulation runtime is driven through a hermetic harness
(`tests/unit/conftest.py`) that fakes only the run store, `reads.fetchCase`, the
LLM and Spaces, so the real service/prompt/turn-state code is under test.
`tests/integration/` is auto-marked `db` and hits a real Postgres, which is the
point: the schema depends on JSONB, CITEXT, `INSERT … ON CONFLICT` and
`SELECT … FOR UPDATE`, none of which SQLite can stand in for. Shared payload
builders live in `tests/factories.py`.

**Which database?** The DB-backed tests connect to `POOLING` and create and
delete real rows, so point it at a throwaway database — `pytest` prints the host
it is about to use in its header. CI runs them against a disposable `postgres:17`
service container, with the schema built by `alembic upgrade head` so the
migrations are exercised too.

**Frontend layout.** Two vitest projects: `*.test.ts` runs in node, while
`*.dom.test.ts` and `*.svelte.test.ts` run in jsdom. Backend calls are
intercepted by [MSW](https://mswjs.io) with `onUnhandledRequest: "error"`, so an
unstubbed request fails the test instead of reaching the network. Shared
fixtures and the MSW server live in `src/testing/`.

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

Forgetting this step used to go unnoticed until something broke at runtime;
`backend/tests/unit/test_openapi_contract.py` now compares the checked-in
`.d.ts` against the live OpenAPI schema and fails CI on drift.

`gen:api` runs openapi-typescript through `npm exec` with a pinned TypeScript
rather than the workspace install: openapi-typescript builds its output with
TypeScript's `ts.factory` AST API, which this project's TypeScript 7 no longer
exposes, so the locally-installed binary crashes on import.

## Workflows

**Auth (admins only).** GIS (`accounts.google.com/gsi/client`) is loaded lazily
— only on the first click of "Admin Login". That click opens a small popover 
and renders Google's own Sign In With Google button into it 
(`accounts.id.renderButton`, not `.prompt()`/One Tap — One Tap only works via 
FedCM, which Safari and Firefox don't support. It has to be Google's actual 
rendered element, not a custom-styled one — Google's branding guidelines 
require their button be shown unmodified and unobscured, and a custom 
trigger can only invoke `.prompt()` (i.e. the FedCM-only path). Clicking it 
hands the frontend a signed ID token (a JWT) directly, which gets POSTed as 
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
four kinds of OpenRouter calls (`anthropic/claude-sonnet-5` and
`anthropic/claude-haiku-4.5`, both through OpenRouter's OpenAI-compatible
`/chat/completions` endpoint): one Claude Sonnet call that generates the
reply, and up to three kinds of Claude Haiku classifier calls — a
harassment/nonsense check on the message, one referral-unlock check per
still-locked referral the active persona could introduce, and one
file-share check per still-withheld file they could send. All classifier
calls run concurrently (`asyncio.gather`); the Sonnet reply call runs
strictly after, since its system prompt depends on which referrals/files
the classifiers just deemed eligible. The system prompt is split into a
stable block (case brief, common information, and the active persona's own
traits/known facts) marked with a one-hour ephemeral `cache_control`, and a
turn-specific block (this turn's eligible referrals/files). The reply text
itself streams straight to the client via SSE as plain text, with no
wrapping or parsing in between; in the same streaming response, the model
separately calls a `report_reply_metadata` tool (via `tool_choice: "auto"`,
which — confirmed empirically — still returns the reply text alongside the
tool call) to report which contacts it introduced and which files it sent
this turn, which drives referral/file unlocking once the stream ends.


**File uploads (two-phase, direct-to-Spaces).** The browser never sends file
bytes through the backend. It first calls `/api/uploads/presign` to get a
presigned URL, then `PUT`s the file straight to DigitalOcean Spaces from the
browser. Only the resulting object key is submitted with the case/persona
data. Spaces' CORS policy must allow `GET`/`PUT` from every origin in
`FRONTEND_URLS` for this to work.
