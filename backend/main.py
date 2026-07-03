import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.router import api_router
from services.db import close_db_client
from services.llm import close_client, init_client
from services.simulation_service import cleanup_expired_runs_forever
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
    # (see services.simulation_service.RUN_TTL_SECONDS).
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


app = FastAPI(title="caseLab API", version="1.0.0", lifespan=lifespan)

if settings.frontend_urls:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.frontend_urls,
        # No cookies/session credentials are used — admin auth travels as an
        # explicit X-Admin-Token header, not a cookie — so credentialed CORS
        # isn't needed. Keeping this False is strictly tighter.
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    logger.warning(
        "FRONTEND_URLS is empty; CORS is disabled and browsers will block "
        "cross-origin requests from the frontend."
    )

app.include_router(api_router, prefix="/api")
