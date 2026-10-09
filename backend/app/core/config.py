from typing import Literal
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GUIDY_", env_file=".env", extra="ignore")

    environment: Literal["local", "test", "staging", "production"] = "local"
    cors_origins: list[str] = []

    @field_validator("cors_origins")
    @classmethod
    def validate_origins(cls, origins: list[str]) -> list[str]:
        normalized = []
        for origin in origins:
            parts = urlsplit(origin)
            if (
                parts.scheme not in {"http", "https"}
                or not parts.hostname
                or parts.username
                or parts.password
                or parts.query
                or parts.fragment
                or parts.path not in {"", "/"}
            ):
                raise ValueError("CORS must contain explicit HTTP origins without credentials")
            _ = parts.port
            normalized.append(origin.rstrip("/"))
        return normalized

    @property
    def docs_enabled(self) -> bool:
        return self.environment in {"local", "test"}
