import logging
import re
from time import perf_counter
from uuid import UUID, uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import error_response

request_logger = logging.getLogger("guidy.requests")
UUID_HEADER = re.compile(r"[0-9a-fA-F-]{36}\Z")
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


def resolve_request_id(value: str | None) -> str:
    if value and UUID_HEADER.fullmatch(value):
        try:
            return str(UUID(value))
        except ValueError:
            pass
    return str(uuid4())


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = resolve_request_id(Headers(scope=scope).get("x-request-id"))
        scope.setdefault("state", {})["request_id"] = request_id
        started = perf_counter()
        status_code = 500
        response_started = False

        async def send_with_context(message: Message) -> None:
            nonlocal status_code, response_started
            if message["type"] == "http.response.start":
                status_code = message["status"]
                response_started = True
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_context)
        except Exception:
            # Never include exception text, request body or auth headers in a log/response.
            if response_started:
                raise  # A streaming response cannot be replaced after its headers were sent.
            response = error_response(
                Request(scope), 500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。"
            )
            await response(scope, receive, send_with_context)
        finally:
            route = scope.get("route")
            method = scope.get("method", "")
            request_logger.log(
                logging.ERROR if status_code >= 500 else logging.INFO,
                "request_completed",
                extra={
                    "request_id": request_id,
                    "method": method if method in METHODS else "OTHER",
                    "route": getattr(route, "path", "unmatched"),
                    "status_code": status_code,
                    "duration_ms": round((perf_counter() - started) * 1000, 2),
                },
            )
