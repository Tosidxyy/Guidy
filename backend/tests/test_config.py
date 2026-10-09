import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_settings_read_prefixed_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GUIDY_ENVIRONMENT", "staging")
    assert Settings(_env_file=None).docs_enabled is False


def test_unknown_environment_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GUIDY_ENVIRONMENT", "invalid")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
