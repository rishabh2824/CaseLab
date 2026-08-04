import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from api.router import api_router
from api.simulations import describeMessageStream
from domain_errors import DomainError
from infra.db import closeDb
from infra.llm import closeClient, initClient
from infra.rate_limit import cleanStaleLimits
from services.simulation.run_store import cleanupRuns
from infra.settings import getSettings


settings = getSettings()


# Shared httpx client for all LLM calls, so that the several requests from one student message reuses pooled instead of
# a fresh TLS handshake.
@asynccontextmanager
async def lifespan(app: FastAPI):
    initClient()

    # Sweepers
    cleanup_task = asyncio.create_task(cleanupRuns())
    rate_limit_cleanup = asyncio.create_task(cleanStaleLimits())
    try: yield
    finally:
        cleanup_task.cancel()
        rate_limit_cleanup.cancel()
        for task in (cleanup_task, rate_limit_cleanup):
            try: await task
            except asyncio.CancelledError: pass
        await closeClient()
        await closeDb()


app = FastAPI(
    title="caseLab API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url="/openapi.json" if settings.enable_openapi else None,
)


if settings.frontendUrls:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.frontendUrls,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )



# Single mapping from a domain exception to an HTTP response
@app.exception_handler(DomainError)
async def domainErrorHandler(request: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


app.include_router(api_router, prefix="/api")


# FastAPI's default generator has no way to see the SSE frame shapes streamed by
# POST /api/simulations/{run_id}/message (api/simulations.py) -- it returns a raw
# EventSourceResponse, not a response_model. describeMessageStream hand-registers
# those frame shapes into the generated schema so `pnpm gen:api` (frontend) picks
# them up like any other endpoint.
def customOpenapi() -> dict:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
    describeMessageStream(schema)
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = customOpenapi  # type: ignore[method-assign]  # FastAPI's own documented override pattern
