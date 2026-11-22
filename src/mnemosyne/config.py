from functools import lru_cache

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://mnemosyne:mnemosyne@localhost:5432/mnemosyne"
    api_key: str | None = None
    embedding_provider: str = "hash"
    embedding_model: str = "all-minilm"
    ollama_url: str = "http://127.0.0.1:11434"
    openrouter_api_key: SecretStr | None = None
    job_max_attempts: int = 5

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    @field_validator("database_url")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        url = make_url(value)
        if url.drivername in {"postgres", "postgresql"}:
            url = url.set(drivername="postgresql+asyncpg")

        query = dict(url.query)
        if "sslmode" in query:
            query.setdefault("ssl", query.pop("sslmode"))
            url = url.set(query=query)
        return url.render_as_string(hide_password=False)


@lru_cache
def get_settings() -> Settings:
    return Settings()
