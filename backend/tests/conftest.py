import logging
from collections.abc import Iterator

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from app.core.config import Settings
from app.main import create_app


class SampleInput(BaseModel):
    minutes: int = Field(gt=0)


@pytest.fixture
def api() -> FastAPI:
    application = create_app(Settings(environment="test", _env_file=None))

    @application.post("/_test/validate")
    async def validate(payload: SampleInput) -> dict[str, int]:
        return {"minutes": payload.minutes}

    @application.get("/_test/private/{item_id}")
    async def forbidden(item_id: str) -> None:
        raise HTTPException(403, detail=f"private value: {item_id}")

    @application.get("/_test/auth")
    async def unauthenticated() -> None:
        raise HTTPException(
            401,
            detail="auth-secret",
            headers={"WWW-Authenticate": "Bearer", "X-Private": "auth-secret"},
        )

    @application.get("/_test/crash")
    async def crash() -> None:
        raise RuntimeError("server-secret and private health data")

    return application


@pytest.fixture
def client(api: FastAPI) -> Iterator[TestClient]:
    with TestClient(api) as test_client:
        yield test_client


@pytest.fixture
def request_logs(caplog: pytest.LogCaptureFixture) -> Iterator[pytest.LogCaptureFixture]:
    logger = logging.getLogger("guidy.requests")
    logger.addHandler(caplog.handler)
    try:
        yield caplog
    finally:
        logger.removeHandler(caplog.handler)
