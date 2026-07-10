# caseLab API

FastAPI backend for the Wisconsin CaseForm Lab simulation platform.

## Layout

Three layers. The app is launched from **inside `backend/`**, so imports are
plain top-level (`from models... import`, `from services... import`) with no
`sys.path` manipulation.

```
backend/
├── main.py         # FastAPI app + CORS; mounts the API router under /api
├── settings.py     # Env-driven settings (Spaces, DB, LLM, CORS origins)
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
│   └── uploads.py
└── services/       # Talk to the DB and external systems; hold the actual logic
    ├── db.py       #   libSQL / Turso client + row-to-dict helpers
    ├── admin_auth.py       #   admin session JWTs + Google ID-token verification
    ├── admin_repository.py #   CRUD for the `admins` table
    ├── spaces.py   #   DigitalOcean Spaces (object storage)
    └── llm.py      #   model calls
```

Database schema changes are applied by hand via the Turso SQL console;
[`schema.txt`](schema.txt) is a reference snapshot kept in sync with the live
schema (there is no migration runner).

Repository functions (`services/*_repository.py`) return **dicts keyed by
column name** (via `libsql_client`'s `Row.asdict()`), not positional tuples —
so a caller reads `row["case_name"]`, and reordering a `SELECT`'s columns
can't silently shift which value lands in which field.

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
| `LLM_KEY` / `LLM_BASE_URL` | yes | OpenRouter-compatible chat completions |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID for admin Google Sign-In; checked against the ID token's `aud` claim |
| `ADMIN_ALLOWED_DOMAIN` | yes | Google Workspace domain (e.g. `wisc.edu`) admins must belong to — checked against the ID token's `hd` claim, in addition to the `admins` table lookup |
| `ADMIN_JWT_SECRET` | yes | Signing key for admin session JWTs. Use a long random value (32+ bytes) — PyJWT warns on short HMAC keys |

The chat models are **not** env-configurable — they're fixed constants at the
top of [`settings.py`](settings.py): `LLM_MODEL` (frontier, used for the
persona reply) and `LLM_CLASSIFIER_MODEL` (cheap, used for the YES/NO judges
and intro sentences). Change them there if you need different values.

Admin identity is Google Workspace SSO, not a shared secret: an admin's row in
the `admins` table (see "Database schema" below) *is* their access grant.
`POST /api/admin/login` verifies a Google ID token, checks its `hd` claim
against `ADMIN_ALLOWED_DOMAIN`, looks the email up in `admins`, and — if
found — mints a short-lived JWT (signed with `ADMIN_JWT_SECRET`) that the
frontend then sends as `Authorization: Bearer <jwt>` on every admin/write
request. `api/dependencies.get_current_admin` re-verifies that JWT and
re-fetches the admin row by id on *every* request (cheap at ~20 admins), so a
deleted admin's still-unexpired token stops working immediately rather than
lingering until it naturally expires. There is no in-app way to create the
first super admin — see `schema.txt` for the manual seed `INSERT`.

## Run locally

```bash
cd backend
uv sync
uv run uvicorn main:app --reload --port 8000
```

> The app **must** be launched with `backend/` as the working directory (that is
> what puts `main`, `api`, `models`, `services` on the import path — no `sys.path`
> hacks). On DigitalOcean App Platform, set the component's **Source Directory**
> to `backend` and the **Run Command** to
> `uvicorn main:app --host 0.0.0.0 --port 8080`. (The old root `app.py` shim has
> been removed.)

## Tests

```bash
cd backend
uv run pytest
```

Auth-critical logic (JWT issuance/verification, the Google ID-token
verification + domain/allowlist check, case-ownership authorization) is
covered under `tests/`. Google's network call
(`google.oauth2.id_token.verify_oauth2_token`) and the DB layer are mocked;
everything else runs for real.

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
[`schema.txt`](schema.txt) so it stays an accurate mirror of the live
database:

```sql
SELECT sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type, name;
```
