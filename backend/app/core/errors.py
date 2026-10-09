from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.schemas.responses import ErrorDetail, ErrorResponse, ValidationIssue

HTTP_ERRORS = {
    400: ("BAD_REQUEST", "请求无效。"),
    401: ("AUTH_REQUIRED", "请先登录。"),
    403: ("FORBIDDEN", "无权访问此资源。"),
    404: ("NOT_FOUND", "资源不存在。"),
    405: ("METHOD_NOT_ALLOWED", "此接口不支持该请求方法。"),
    409: ("CONFLICT", "数据已改变，请刷新后重试。"),
    422: ("VALIDATION_FAILED", "请求参数无效。"),
    429: ("RATE_LIMITED", "请求过于频繁，请稍后重试。"),
}


def error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: list[ValidationIssue] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    payload = ErrorResponse(
        error=ErrorDetail(code=code, message=message, details=details),
        request_id=request.state.request_id,
    )
    return JSONResponse(payload.model_dump(mode="json"), status_code=status_code, headers=headers)


async def http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
    code, message = HTTP_ERRORS.get(
        exc.status_code,
        ("INTERNAL_ERROR", "服务暂时不可用，请稍后重试。")
        if exc.status_code >= 500
        else ("REQUEST_FAILED", "请求未能完成。"),
    )
    # Exception detail is untrusted and can contain credentials or personal data.
    headers = {
        key: value
        for key, value in (exc.headers or {}).items()
        if key.lower() in {"allow", "www-authenticate", "retry-after"}
    }
    return error_response(request, exc.status_code, code, message, headers=headers)


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    issues = [
        ValidationIssue(location=list(error["loc"]), type=error["type"]) for error in exc.errors()
    ]
    # Do not echo Pydantic input, exception context, or arbitrary validation messages.
    return error_response(request, 422, "VALIDATION_FAILED", "请求参数无效。", issues)


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, http_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
