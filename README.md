# Wisconsin Case Lab

A simulation platform for business-school case studies. Students enter an
access code and chat with LLM-driven personas in a timed simulation; admins
author the cases (personas, who refers to whom, files the personas can share)
in a Google-authenticated dashboard.

## How it works

**Students** need no account. The landing page takes an access code and starts
a run. In the simulation they message the personas that are available to
them, keep private notes, watch a clock, and can export their conversations as
a PDF. A persona can introduce another persona or hand over a file when the
student meets the conditions the admin wrote for it, and a persona can only be
available for a limited window. A run lasts the case's duration plus a
15-minute grace period, capped at 2 hours, and is then deleted with all of its
messages.

**Admins** sign in with Google, and only emails on the admin roster can get in.
They create cases from scratch, from an existing case as a template, or by
importing an exported case form. They edit cases, add collaborators, and can
look at the demo cases. **Super admins** also manage the roster (adding admins,
and deleting them with their cases reassigned or removed) and choose which
cases are shown as demos for new admins. The demo view is read-only and never
shows a case's access code.

## Tech stack

- **Backend:** [Convex](https://convex.dev) for functions, the reactive
  database and file storage. Auth is [Better Auth](https://better-auth.com)
  with Google sign-in (`@convex-dev/better-auth`). Persona replies come from
  Claude Sonnet (`anthropic/claude-sonnet-5.5`) and a harassment/nonsense
  check from Claude Haiku (`anthropic/claude-haiku-5.5`), both through
  [OpenRouter](https://openrouter.ai) with plain `fetch`.
- **Frontend:** SvelteKit (Svelte 5 runes) as a client-rendered SPA, Tailwind 4,
  Bits UI and svelte-sonner, built with `adapter-static`.
- **Hosting:** everything runs on Convex. The built frontend is served from
  Convex too, through `@convex-dev/static-hosting`, so there is no separate
  host.

## Repository layout

| Path | What lives there |
|---|---|
| `convex/*.ts` | The public Convex functions, one file per area: `admins`, `cases`, `simulations`, `turn`, `files`, `uploads`. Also `schema.ts`, `auth.ts` and `http.ts`. |
| `convex/services/` | The logic behind those functions, as plain functions that never register a Convex function. |
| `convex/lib/` | Pure helpers shared with the browser (`constants`, `caseRules`, `caseGraph`, `turnState`, `studentErrors`) and the LLM code (`llm`, `prompt`). |
| `convex/models/` | Validators for the stored case structure. |
| `convex/migrations.ts` | Temporary one-off data migrations. Delete them once every deployment has run them. |
| `src/routes/` | SvelteKit routes: the landing page, `/student`, and `/admin/...`. |
| `src/lib/` | Components, the student run store, and the case form code (`case/`). |
| `tests/`, `e2e/` | Frontend unit tests, and Playwright tests against a mocked backend. Backend tests sit next to the code in `convex/`. |

## Setup

Requires Node 26 and pnpm 12.9, plus a Convex account.

```bash
pnpm install
npx convex dev      # first run: log in and create or link a dev deployment
```

`npx convex dev` writes `.env.local` (`CONVEX_DEPLOYMENT` and
`PUBLIC_CONVEX_URL`; the frontend works out the `.convex.site` URL from the
latter). Do not edit it by hand.

The backend reads its secrets from **Convex environment variables**, not from a
local file. Set them on each deployment:

```bash
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set GOOGLE_CLIENT_ID "<google oauth client id>"
npx convex env set GOOGLE_CLIENT_SECRET "<google oauth client secret>"
npx convex env set LLM_KEY "<openrouter api key>"
npx convex env set SITE_URL "http://localhost:5173"   # the frontend's origin
```

In Google Cloud, add `<your .convex.site URL>/api/auth/callback/google` as an
authorized redirect URI for the OAuth client.

**First admin.** Only emails on the roster can sign in, so add the first one
yourself: in the Convex dashboard open the `admins` table and insert a row
with your `email` and `role: "super"`. After that, super admins add everyone
else from `/admin/admins`.

## Running locally

```bash
npx convex dev      # backend: pushes convex/ on every save
pnpm run dev:web    # frontend: http://localhost:5173
```

## Testing

```bash
pnpm run lint          # biome
pnpm run typecheck     # tsc over convex/
pnpm run check         # svelte-check over src/
pnpm test              # vitest: backend (convex-test) and frontend (node + jsdom)
pnpm run test:e2e      # Playwright, against a fully mocked backend
pnpm run test:all      # check, typecheck, test and test:e2e in one go
```

## Deploying

```bash
pnpm run deploy
```

This one command builds the frontend, deploys the Convex backend, and uploads
the static files, so the two stay in step. Run it against the deployment you
mean to ship to; production asks for confirmation in an interactive terminal.

A few cautions:

- Deploy when no student is in the middle of a run. A reply that is being
  generated is dropped, and scheduled cleanup jobs refer to function names.
- Schema changes that rewrite existing data are done in three steps: widen the
  schema, run the matching function in `convex/migrations.ts`, then tighten the
  schema again.

## Design notes

**Chat turns are database rows.** Sending a message calls the `turn.sendMessage`
mutation. It checks the message (50 words at most), saves it, adds a pending
reply row, and schedules the reply. The student's screen is subscribed to that
persona's history, so the reply appears when it is saved, and the send box is
locked exactly while the reply is pending. If a reply fails, or is still
pending after 30 seconds, the turn is failed: the student's message is removed
and they are asked to send it again.

**Reply generation.** Each message triggers two OpenRouter calls in parallel: a
Haiku classifier that flags nonsense or abusive messages, and one Sonnet call
that writes the reply and decides which referrals and files to unlock, using a
strict JSON schema. A flagged message gets a boundary reply instead and counts
as a warning; three warnings end that conversation. Only the last 10 turns are
sent to the model.

**Access control.** Every admin function goes through `adminQuery`,
`adminMutation` or `superAdminMutation`, built with `convex-helpers`. The
student-facing functions are public by design and are identified by the run id.
A test scans all of `convex/` and fails if any other function is callable
without being an admin, or if a function is registered outside the top-level
modules.

**Files.** Admins upload files straight to Convex storage with short-lived
upload URLs, and only the resulting storage ids are submitted with the case. A
`caseFiles` row per case and file counts the references, so a file is deleted
from storage only when no case uses it any more.

**Shared code.** The case field rules and messages, the cycle check on
referrals, and the availability logic each live once in `convex/lib/` and are
used by both the backend and the browser.

## Working on the Convex code

`AGENTS.md` and `CLAUDE.md` point to `convex/_generated/ai/guidelines.md`, which
holds the rules for writing Convex code in this repo. Read it before changing
anything under `convex/`.
