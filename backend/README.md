# caseLab API

FastAPI backend for the Wisconsin Case Lab simulation platform.

## Layout

Three layers. The app is launched from **inside `backend/`**, so imports are
plain top-level (`from models... import`, `from services... import`) with no
`sys.path` manipulation.

```
backend/
├── main.py         # FastAPI app + CORS + /health; mounts the API router under /api
├── settings.py     # Env-driven settings (Spaces, DB, LLM, CORS origins)
├── api/            # Receives requests from the frontend (thin HTTP routers)
│   ├── router.py   #   aggregates the routers below
│   ├── cases.py    #   /api/cases...
│   ├── simulations.py  # /api/simulations...
│   └── uploads.py  #   /api/uploads...
├── models/         # Pydantic request/response models (validate the data shape)
│   ├── cases.py
│   └── uploads.py
├── services/       # Talk to the DB and external systems; hold the actual logic
│   ├── db.py       #   libSQL / Turso client
│   ├── spaces.py   #   DigitalOcean Spaces (object storage)
│   └── llm.py      #   model calls
└── scripts/        # One-off operational scripts (e.g. Spaces CORS setup)
```

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
| `SIM_DEBUG` | no | `true` to log simulation internals |

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
Run once (and again whenever `FRONTEND_URLS` changes):

```bash
cd backend
python -m scripts.configure_spaces_cors
```
