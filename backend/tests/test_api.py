import asyncio
import json
import logging
from uuid import UUID, uuid4

import httpx2 as httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.logging import PrivacyFormatter
from app.main import create_app


def assert_request_id(response: httpx.Response) -> str:
    value = response.json()["request_id"]
    assert str(UUID(value)) == value
    assert response.headers["X-Request-ID"] == value
    return value


def test_health_contract_and_unique_request_ids(client: TestClient) -> None:
    first = client.get("/health")
    second = client.get("/health")
    assert first.status_code == 200
    assert first.json()["data"] == {"status": "ok", "service": "guidy-api", "version": "0.1.0"}
    assert first.json()["error"] is None
    assert assert_request_id(first) != assert_request_id(second)


def test_valid_client_request_id_is_canonicalized(client: TestClient) -> None:
    request_id = str(uuid4())
    response = client.get("/health", headers={"X-Request-ID": request_id.upper()})
    assert assert_request_id(response) == request_id


@pytest.mark.parametrize("request_id", ["", "personal-secret", "x" * 500, "-" * 36])
def test_invalid_request_id_is_replaced(client: TestClient, request_id: str) -> None:
    response = client.get("/health", headers={"X-Request-ID": request_id})
    assert assert_request_id(response) != request_id


@pytest.mark.parametrize(
    ("method", "path", "status", "code"),
    [("GET", "/missing", 404, "NOT_FOUND"), ("POST", "/health", 405, "METHOD_NOT_ALLOWED")],
)
def test_http_error_envelope(
    client: TestClient, method: str, path: str, status: int, code: str
) -> None:
    response = client.request(method, path)
    assert response.status_code == status
    assert response.json()["data"] is None
    assert response.json()["error"]["code"] == code
    assert_request_id(response)
    if status == 405:
        assert "GET" in response.headers["allow"]


def test_auth_error_retains_protocol_header_without_private_detail(client: TestClient) -> None:
    response = client.get("/_test/auth")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"
    assert response.headers["www-authenticate"] == "Bearer"
    assert "x-private" not in response.headers
    assert "auth-secret" not in response.text
    assert_request_id(response)


@pytest.mark.parametrize("payload", [{"minutes": "private-health-secret"}, {"minutes": -1}, {}])
def test_validation_errors_omit_sensitive_input_and_context(
    client: TestClient, payload: dict
) -> None:
    response = client.post("/_test/validate", json=payload)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"][0]["location"] == ["body", "minutes"]
    assert set(error["details"][0]) == {"location", "type"}
    assert "private-health-secret" not in response.text
    assert_request_id(response)


def test_invalid_json_uses_error_envelope(client: TestClient) -> None:
    response = client.post(
        "/_test/validate",
        content='{"private-health-secret":',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert "private-health-secret" not in response.text
    assert_request_id(response)


def test_unhandled_error_is_generic_and_correlated(
    client: TestClient, request_logs: pytest.LogCaptureFixture
) -> None:
    response = client.get("/_test/crash")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "secret" not in response.text
    request_id = assert_request_id(response)
    record = next(r for r in request_logs.records if r.name == "guidy.requests")
    assert record.request_id == request_id
    assert record.status_code == 500
    assert record.exc_info is None


def test_logs_use_route_template_and_omit_request_secrets(
    client: TestClient, request_logs: pytest.LogCaptureFixture
) -> None:
    client.get(
        "/_test/private/path-secret?email=query-secret",
        headers={"Authorization": "Bearer token-secret", "X-Request-ID": "header-secret"},
    )
    client.post("/_test/validate", json={"minutes": "body-secret"})
    client.get("/unknown-path-secret?key=query-secret")
    records = [r for r in request_logs.records if r.name == "guidy.requests"]
    assert [r.route for r in records] == [
        "/_test/private/{item_id}",
        "/_test/validate",
        "unmatched",
    ]
    serialized = "\n".join(PrivacyFormatter().format(r) for r in records)
    assert "secret" not in serialized
    for line in serialized.splitlines():
        assert set(json.loads(line)) == {
            "event",
            "level",
            "request_id",
            "method",
            "route",
            "status_code",
            "duration_ms",
        }


def test_server_formatter_never_prints_raw_message_or_traceback() -> None:
    record = logging.LogRecord("uvicorn.error", logging.ERROR, "", 0, "token-secret", (), None)
    record.exc_text = "traceback-secret"
    assert "secret" not in PrivacyFormatter().format(record)


def test_request_ids_are_isolated_across_concurrent_requests(api: FastAPI) -> None:
    @api.get("/_test/concurrent")
    async def concurrent(request: Request) -> dict:
        before = request.state.request_id
        await asyncio.sleep(0.01)
        return {"request_id": request.state.request_id, "before": before}

    async def exercise() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api), base_url="http://test"
        ) as async_client:
            ids = [str(uuid4()) for _ in range(12)]
            responses = await asyncio.gather(
                *[
                    async_client.get("/_test/concurrent", headers={"X-Request-ID": value})
                    for value in ids
                ]
            )
            assert [assert_request_id(r) for r in responses] == ids
            assert [r.json()["before"] for r in responses] == ids

    asyncio.run(exercise())


def test_openapi_matches_error_and_health_contracts(client: TestClient) -> None:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    assert schema["paths"]["/health"]["get"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ]["$ref"].endswith("HealthResponse")
    assert schema["paths"]["/_test/validate"]["post"]["responses"]["422"]["content"][
        "application/json"
    ]["schema"]["$ref"].endswith("ErrorResponse")


def test_production_disables_debug_and_docs() -> None:
    application = create_app(Settings(environment="production", _env_file=None))
    assert application.debug is False
    with TestClient(application) as client:
        assert client.get("/health").status_code == 200
        for path in ["/docs", "/redoc", "/openapi.json"]:
            response = client.get(path)
            assert response.status_code == 404
            assert_request_id(response)


def test_test_only_routes_do_not_exist_in_runtime_app() -> None:
    application = create_app(Settings(environment="local", _env_file=None))
    assert not any(path.startswith("/_test") for path in application.openapi()["paths"])
    with TestClient(application) as client:
        assert client.get("/_test/crash").status_code == 404
