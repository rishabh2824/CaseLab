# Wisconsin Case Lab

A simulation platform for business-school case studies: students enter an access
code and interact with LLM-driven personas in a timed chat, while admins author
cases (personas, referral trees, shared files) through a Google-authenticated
dashboard.

## Tech stack

**Backend** — [Convex](https://convex.dev) (TypeScript functions, reactive
database, and file storage, all on one deployment), `@convex-dev/auth` with
Google sign-in for admin auth, Claude (via
[OpenRouter](https://openrouter.ai)) for persona replies.

**Frontend** — SvelteKit (Svelte 5 runes) in SPA mode, Tailwind 4, Bits UI
(headless) + svelte-sonner, built with `adapter-static`. Everything —
backend functions, database, file storage, and the static frontend build —
runs on Convex; there's no separate hosting provider.

## Installation

```bash
pnpm install
```

Config comes from two git-ignored files at the repo root:

- `.env` — `LLM_KEY` (an [OpenRouter](https://openrouter.ai) API key),
  `GOOGLE_ID`/`GOOGLE_SECRET` (Google OAuth client), `JWT_SECRET`,
  `VITE_GOOGLE_CLIENT_ID`, `PUBLIC_CONVEX_URL`.
- `.env.local` — `CONVEX_DEPLOYMENT`, managed automatically by the Convex CLI
  (`npx convex dev` regenerates it if it's missing; don't hand-edit it).

## Running locally

```bash
npx convex dev     # backend — pushes convex/ on every save
pnpm run dev:web    # frontend — http://localhost:5173
```

## Testing

Everything below runs in CI on every push and pull request
(`.github/workflows/ci.yml`).

```bash
pnpm run lint           # biome
pnpm run typecheck      # tsc over convex/
pnpm run check           # svelte-check over src/
pnpm exec vitest run     # unit — convex (convex-test), and frontend node + jsdom projects
pnpm run test:e2e        # Playwright, against a fully-mocked backend
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
two OpenRouter calls: a Claude Haiku harassment/nonsense classifier
(`classifyHarassment` in `convex/lib/llm.ts`) on the message, and one Claude 
Sonnet call that decides the referral and file unlock and generates the reply.



**File uploads (two-phase, direct-to-Convex-storage).** The browser calls
`generateUploadUrl` (or the batched `generateUploadUrls`) to get a
short-lived upload URL, then `POST`s the file straight to Convex storage
from the browser. Only the resulting `storageId` is submitted with the
case/persona data.
