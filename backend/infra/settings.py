from functools import lru_cache
from pathlib import Path
from typing import ClassVar
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from domain_constants import SIMULATION_DURATION

JWT_EXPIRY = 24 * 60 * 60  # 24h
JWT_ALGORITHM = "HS256"

# --- LLM timeout budget ---------------------------------------------------
# Every timeout on the message -> persona-reply path is derived from these two
# numbers instead of being invented independently at each call site:
#
#   LLM_ATTEMPT_TIMEOUT (s)    Longest a single upstream call may run before
#                              that attempt gives up. Used by the persona-reply
#                              stream and by classifyHarassment (infra/llm.py)
#                              — both call the persona-reply-scale model.
#   LLM_CLASSIFIER_TIMEOUT (s) Shorter budget for the cheap YES/NO classifier
#                              calls (infra/llm.py::classifier, backing
#                              classifyReferral/classifyFileShare).
#   PERSONA_REPLY_RETRIES      Max attempts for personaReplyStream. Worst case
#                              before it raises to the caller is
#                              LLM_ATTEMPT_TIMEOUT * PERSONA_REPLY_RETRIES.
#   GENERATION_WALL_CLOCK_TIMEOUT (s)
#                              Hard cap (services/simulation/stream.py) on
#                              the whole prepare+stream+persist turn.
#                              Deliberately well above LLM_ATTEMPT_TIMEOUT *
#                              PERSONA_REPLY_RETRIES so it only fires on a
#                              genuinely stuck task, never as the normal
#                              failure path for a slow-but-answering upstream.
#
# The frontend idle timeout (frontend/src/lib/api/client.ts, 30s) lives in a
# separate runtime and can't import these, but is deliberately set equal to
# LLM_ATTEMPT_TIMEOUT. It resets on any received byte, including
# sse-starlette's keepalive ping, which the backend keeps sending for the
# full duration of a generation — so that timer only fires on a genuinely
# stalled connection (no bytes at all), not as a race against
# LLM_ATTEMPT_TIMEOUT retries. If any value here changes, re-check that
# client.ts comment still holds.
LLM_ATTEMPT_TIMEOUT = 30
LLM_CLASSIFIER_TIMEOUT = 20
PERSONA_REPLY_RETRIES = 2
GENERATION_WALL_CLOCK_TIMEOUT = 120


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    llm_model: ClassVar[str] = "anthropic/claude-sonnet-5"
    llm_classifier_model: ClassVar[str] = "anthropic/claude-haiku-4.5"
    spaces_key: str
    spaces_secret: str
    spaces_upload_expiry: int = 900
    spaces_download_expiry: int = (SIMULATION_DURATION + 30) * 60
    direct_url: str = Field(default="", validation_alias="DIRECT")
    frontend_urls_raw: str = Field(default="", validation_alias="FRONTEND_URLS")
    google_client_id: str
    jwt_secret: str = Field(min_length=32)
    llm_key: str
    llm_base_url: str = "https://openrouter.ai/api/v1"
    # Off by default (production doesn't publish its schema); set ENABLE_OPENAPI=true
    # in a local .env to serve /openapi.json for frontend codegen (see frontend/package.json's gen:api).
    enable_openapi: bool = Field(default=False, validation_alias="ENABLE_OPENAPI")

    @property
    def frontendUrls(self) -> list[str]:
        return [url.strip() for url in self.frontend_urls_raw.split(",") if url.strip()]


@lru_cache(maxsize=1)
def getSettings() -> Settings: return Settings()
