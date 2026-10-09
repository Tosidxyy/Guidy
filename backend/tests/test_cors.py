import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings
from app.main import create_app


def test_cors_allows_only_explicit_origin_and_exposes_request_id() -> None:
    application = create_app(
        Settings(environment="test", cors_origins=["http://localhost:8082/"], _env_file=None)
    )
    with TestClient(application) as client:
        response = client.get("/health", headers={"Origin": "http://localhost:8082"})
        assert response.headers["access-control-allow-origin"] == "http://localhost:8082"
        assert response.headers["access-control-expose-headers"] == "X-Request-ID"
        assert "access-control-allow-credentials" not in response.headers
        assert response.headers["x-request-id"] == response.json()["request_id"]
        rejected = client.get("/health", headers={"Origin": "https://untrusted.example"})
        assert "access-control-allow-origin" not in rejected.headers


def test_preflight_permits_get_but_not_write_methods() -> None:
    application = create_app(
        Settings(environment="test", cors_origins=["http://localhost:8082"], _env_file=None)
    )
    with TestClient(application) as client:
        for method, expected in [("GET", 200), ("POST", 400)]:
            response = client.options(
                "/health",
                headers={
                    "Origin": "http://localhost:8082",
                    "Access-Control-Request-Method": method,
                },
            )
            assert response.status_code == expected
            assert "x-request-id" in response.headers


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "https://user:secret@example.com",
        "https://example.com/api",
        "https://example.com?secret=1",
        "https://example.com:invalid",
    ],
)
def test_unsafe_cors_config_is_rejected(origin: str) -> None:
    with pytest.raises(ValidationError):
        Settings(cors_origins=[origin], _env_file=None)


def test_cors_is_disabled_without_configuration() -> None:
    application = create_app(Settings(environment="test", _env_file=None))
    with TestClient(application) as client:
        response = client.get("/health", headers={"Origin": "http://localhost:8082"})
        assert "access-control-allow-origin" not in response.headers
