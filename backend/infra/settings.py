from functools import lru_cache
from pathlib import Path
from typing import ClassVar
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

JWT_EXPIRY = 24 * 60 * 60  # 24h
JWT_ALGORITHM = "HS256"
MAX_SIMULATION_DURATION = 120


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    llm_model: ClassVar[str] = "claude-sonnet-5"
    llm_classifier_model: ClassVar[str] = "claude-haiku-4-5"
    spaces_key: str
    spaces_secret: str
    spaces_bucket: str
    spaces_region: str = "sfo3"
    spaces_endpoint: str = ""
    spaces_presign_expiry: int = 900
    db_url: str
    db_token: str
    frontend_urls_raw: str = Field(default="", validation_alias="FRONTEND_URLS")
    google_client_id: str
    google_client_secret: str
    jwt_secret: str = Field(min_length=32)
    llm_key: str
    llm_base_url: str = "https://api.anthropic.com/v1/messages"
    admin_cookie_secure: bool = Field(default=True, validation_alias="ADMIN_COOKIE_SECURE")

    @property
    def frontendUrls(self) -> list[str]:
        return [url.strip() for url in self.frontend_urls_raw.split(",") if url.strip()]

    @property
    def adminCookie(self) -> str:
        return "none" if self.admin_cookie_secure else "lax"


@lru_cache(maxsize=1)
def get_settings() -> Settings: return Settings()
