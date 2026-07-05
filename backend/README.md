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
│   ├── cases.py    #   /api/cases...
│   ├── simulations.py  # /api/simulations...
│   └── uploads.py  #   /api/uploads...
├── models/         # Pydantic request/response models (validate the data shape)
│   ├── cases.py
│   └── uploads.py
└── services/       # Talk to the DB and external systems; hold the actual logic
    ├── db.py       #   libSQL / Turso client + row-to-dict helpers
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
| `ADMIN_TOKEN` | no | Shared admin code that unlocks the admin API. Defaults to `Admin`; set a strong value in production. Admins enter it on the home screen; it is sent as the `X-Admin-Token` header on admin/write requests. |
| `LLM_KEY` / `LLM_BASE_URL` | yes | OpenRouter-compatible chat completions |

The chat models themselves are **not** env-configurable — they're fixed constants
at the top of [`settings.py`](settings.py): `LLM_MODEL` (frontier, used for the
persona reply) and `LLM_CLASSIFIER_MODEL` (cheap, used for the YES/NO judges and
intro sentences). Change them there if you need a different model.

## Run locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

> The app **must** be launched with `backend/` as the working directory (that is
> what puts `main`, `api`, `models`, `services` on the import path — no `sys.path`
> hacks). On DigitalOcean App Platform, set the component's **Source Directory**
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
[`schema.txt`](schema.txt) so it stays an accurate mirror of the live
database:

```sql
SELECT sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type, name;
```
