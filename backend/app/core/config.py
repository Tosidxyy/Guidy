from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GUIDY_", env_file=".env", extra="ignore")

    environment: Literal["local", "test", "staging", "production"] = "local"

    @property
    def docs_enabled(self) -> bool:
        return self.environment in {"local", "test"}
