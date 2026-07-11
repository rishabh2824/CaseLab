import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.router import api_router
from services.db import close_db_client
from services.llm import close_client, init_client
from services.simulation.state import RunExpired, RunNotFound, cleanup_expired_runs_forever
from settings import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("caselab")

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Shared httpx client for all LLM calls, so the several requests one
    # student message fans out to reuse pooled/keep-alive connections instead
    # of a fresh TLS handshake each time.
    init_client()
    # Background sweeper that removes simulation runs 2 hours after they start
    # (see services.simulation.state.RUN_TTL_SECONDS).
    cleanup_task = asyncio.create_task(cleanup_expired_runs_forever())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        await close_client()
        await close_db_client()


app = FastAPI(title="caseLab API",
              version="0.1.0",  # keep in sync with pyproject.toml's [project].version
              lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)

if settings.frontend_urls:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.frontend_urls,
        # No cookies/session credentials are used — admin auth travels as an
        # explicit `Authorization: Bearer <jwt>` header, not a cookie — so
        # credentialed CORS isn't needed. Keeping this False is strictly tighter.
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    logger.warning(
        "FRONTEND_URLS is empty; CORS is disabled and browsers will block "
        "cross-origin requests from the frontend."
    )

# Domain exceptions from the simulation run store (services.simulation.state)
# are translated to HTTP here, at the app boundary, rather than the data layer
# raising HTTPException itself — RunStore stays a plain, testable component
# with no FastAPI dependency. Both map to 404 (matching the previous
# behavior); the frontend only branches on status code, not the detail text.
@app.exception_handler(RunNotFound)
async def _run_not_found_handler(request, exc: RunNotFound):
    return JSONResponse(status_code=404, content={"detail": "Simulation run not found."})


@app.exception_handler(RunExpired)
async def _run_expired_handler(request, exc: RunExpired):
    return JSONResponse(status_code=404, content={"detail": "Simulation run expired."})


app.include_router(api_router, prefix="/api")
