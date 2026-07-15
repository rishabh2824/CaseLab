# caseLab API

FastAPI backend for the Wisconsin Case Lab simulation platform.

## Layout

Five layers. The app is launched from **inside `backend/`**, so imports are
plain top-level (`from models... import`, `from services... import`,
`from infra... import`) with no `sys.path` manipulation.

```
backend/
├── main.py         # FastAPI app + CORS; mounts the API router under /api
├── infra/          # Env-facing infrastructure: settings + external clients
│   ├── settings.py     #   Env-driven settings (Spaces, DB, LLM, CORS origins)
│   ├── schema.txt       #   Reference snapshot of the live DB schema
│   ├── db.py             #   libSQL / Turso client + row-to-dict helpers
│   ├── spaces.py          #   DigitalOcean Spaces (object storage)
│   ├── llm.py              #   Anthropic API calls (persona replies, judges)
│   └── rate_limit.py        #   fixed-window rate limiting for the student-facing endpoints
├── api/            # Receives requests from the frontend (thin HTTP routers)
│   ├── router.py   #   aggregates the routers below
│   ├── admin.py    #   /api/admin/login, /api/admin/admins... (Google SSO)
│   ├── dependencies.py  # get_current_admin / require_super_admin (JWT auth)
│   ├── cases.py    #   /api/cases...
│   ├── simulations.py  # /api/simulations...
│   └── uploads.py  #   /api/uploads...
├── models/         # Pydantic request/response models (validate the data shape)
│   ├── admin.py
│   ├── cases.py
│   ├── simulations.py
│   └── uploads.py
├── repositories/   # Pure data access — every file here runs SQL, nothing else
│   ├── cases.py       #   SQL for cases/personas/files/referrals
│   ├── admin.py        #   CRUD for the `admins` table
│   ├── rate_limits.py   #   SQL for the fixed-window `rate_limits` table
│   └── simulation/       #   SQL for the live student-simulation engine
│       ├── repository.py  #     reads for cases/personas/files/referrals
│       └── runs.py         #     DB-backed run store (`RunStore`), TTL/cleanup
└── services/       # Business logic and orchestration — no raw SQL in here
    ├── admin_auth.py        #   admin session JWTs + Google ID-token verification
    ├── cases.py             #   case domain logic, orchestrates repositories.cases
    ├── persona_shapes.py    #   the one shared, SQL-free persona-photo shaping
    │                        #   helper used by both the case editor and the
    │                        #   simulation domain
    └── simulation/          #   the live student-simulation engine
        ├── reads.py         #     repository reads shaped for the API/prompts
        ├── prompt.py        #     system-prompt construction, reply envelope
        ├── turn_state.py    #     pure per-turn helpers (availability, chat state)
        └── service.py       #     orchestration: what api/simulations.py calls
```

`infra/` holds the app's env-facing layer — settings plus the four modules
that talk to something outside the process (Turso, Spaces, Anthropic) or
otherwise sit on the DB/env boundary (`rate_limit.py`, which enforces the
abuse-prevention policy on top of `repositories/rate_limits.py`). `services/`
keeps the actual business logic and orchestration.

Database schema changes are applied by hand via the Turso SQL console;
[`infra/schema.txt`](infra/schema.txt) is a reference snapshot kept in sync
with the live schema (there is no migration runner).

Repository functions (`repositories/*.py`) return **dicts keyed by column
name** (via `libsql_client`'s `Row.asdict()`), not positional tuples — so a
caller reads `row["case_name"]`, and reordering a `SELECT`'s columns can't
silently shift which value lands in which field.

## Environment variables

Create `backend/.env` (git-ignored). See the keys below:

| Key | Required | Notes |
| --- | --- | --- |
| `SPACES_KEY` / `SPACES_SECRET` | yes | DigitalOcean Spaces credentials |
| `SPACES_BUCKET` | yes | Bucket name |
| `SPACES_REGION` | no | Defaults to `sfo3` |
| `SPACES_ENDPOINT` | no | Defaults to `https://<region>.digitaloceanspaces.com` |
| `SPACES_PRESIGN_EXPIRY_SECONDS` | no | Defaults to `900` |
| `DB_URL` / `DB_TOKEN` | yes | Turso / libSQL connection |
| `FRONTEND_URLS` | yes | Comma-separated allowed origins for CORS |
| `LLM_KEY` | yes | Anthropic API key (`sk-ant-...`) |
| `LLM_BASE_URL` | no | Defaults to `https://api.anthropic.com/v1/messages` |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID for admin Google Sign-In; checked against the ID token's `aud` claim |
| `GOOGLE_CLIENT_SECRET` | yes | Secret for the same OAuth client, used server-side to exchange the frontend popup flow's authorization code for an ID token |
| `ADMIN_JWT_SECRET` | yes | Signing key for admin session JWTs. Use a long random value (32+ bytes) — PyJWT warns on short HMAC keys |
| `ADMIN_COOKIE_SECURE` | no | Defaults to `true`. The admin session cookie is `Secure` + `SameSite=None` (frontend and backend are on different domains in production). Set to `false` for local dev, where the frontend calls the backend over plain http — the cookie then falls back to `SameSite=Lax`, which still works since both sides are `localhost` |

The chat models are **not** env-configurable — they're fixed constants at the
top of [`infra/settings.py`](infra/settings.py): `llm_model` (frontier, used
for the persona reply) and `llm_classifier_model` (cheap, used for the
YES/NO judges and intro sentences). Change them there if you need different
values.

Admin identity is Google Sign-In, not a shared secret: an admin's row in
the `admins` table (see "Database schema" below) *is* their access grant.
`POST /api/admin/login` verifies a Google ID token, looks the email up in
`admins`, and — if found — mints a short-lived JWT (signed with
`ADMIN_JWT_SECRET`) and sets it as an httpOnly `admin_session` cookie
(`services/admin_auth.set_admin_cookie`) rather than returning it in the
response body — the frontend never has JS access to the token, only the
browser attaching the cookie automatically on every request. `POST
/api/admin/logout` clears it. `api/dependencies.get_current_admin` re-verifies
that cookie and re-fetches the admin row by id on *every* request (cheap at
~20 admins), so a deleted admin's still-unexpired session stops working
immediately rather than lingering until it naturally expires. There is no
in-app way to create the first super admin — see `infra/schema.txt` for the
manual seed `INSERT`.

## Run locally

```bash
cd backend
uv sync
uv run uvicorn main:app --reload --port 8000
```

> The app **must** be launched with `backend/` as the working directory (that is
> what puts `main`, `api`, `models`, `services`, `infra` on the import path — no
> `sys.path` hacks). On DigitalOcean App Platform, set the component's **Source Directory**
> to `backend` and the **Run Command** to
> `uvicorn main:app --host 0.0.0.0 --port 8080`. (The old root `app.py` shim has
> been removed.)

## One-time: configure Spaces CORS (required for uploads)

Browser uploads PUT directly to Spaces, so the bucket needs a CORS policy that
allows your frontend origin. Without it, uploads fail with `Failed to fetch`.
Set this in the DigitalOcean control panel: **Spaces Object Storage → your
bucket → Settings → CORS Configurations → Add**, allowing `GET`/`PUT` from
each origin in `FRONTEND_URLS` (plus your local dev origin). Redo this
whenever `FRONTEND_URLS` changes.

## Database schema

There is no migration tool — schema changes are applied by hand via the Turso
SQL console. After changing the schema, re-export it and update
[`infra/schema.txt`](infra/schema.txt) so it stays an accurate mirror of the
live database:

```sql
SELECT sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type, name;
```
