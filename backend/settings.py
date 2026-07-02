import os
from pathlib import Path

from dotenv import load_dotenv
from functools import lru_cache

# Fixed in code (not env-configurable) so there's one place to change models.
LLM_MODEL = "anthropic/claude-sonnet-5"  # frontier model for the persona reply
LLM_CLASSIFIER_MODEL = "anthropic/claude-haiku-4.5"  # cheap model for YES/NO judges + intros


class Settings:
    def __init__(self) -> None:
        base_dir = Path(__file__).resolve().parent
        load_dotenv(base_dir / ".env")
        self.spaces_key = os.getenv("SPACES_KEY", "")
        self.spaces_secret = os.getenv("SPACES_SECRET", "")
        self.spaces_bucket = os.getenv("SPACES_BUCKET", "")
        self.spaces_region = os.getenv("SPACES_REGION", "sfo3")
        self.spaces_endpoint = os.getenv(
            "SPACES_ENDPOINT",
            f"https://{self.spaces_region}.digitaloceanspaces.com",
        )
        self.spaces_presign_expiry_seconds = int(
            os.getenv("SPACES_PRESIGN_EXPIRY_SECONDS", "900"),
        )
        self.db_url = os.getenv("DB_URL", "")
        self.db_token = os.getenv("DB_TOKEN", "")
        raw_frontend_urls = os.getenv("FRONTEND_URLS", "")
        self.frontend_urls = [
            url.strip()
            for url in raw_frontend_urls.split(",")
            if url.strip()
        ]
        self.admin_token = os.getenv("ADMIN_TOKEN", "Admin")
        self.llm_key = os.getenv("LLM_KEY", "")
        self.llm_model = LLM_MODEL
        self.llm_classifier_model = LLM_CLASSIFIER_MODEL
        self.llm_base_url = os.getenv(
            "LLM_BASE_URL",
            "https://openrouter.ai/api/v1/chat/completions",
        )
        self.sim_debug = os.getenv("SIM_DEBUG", "false").lower() in {"1", "true", "yes"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
