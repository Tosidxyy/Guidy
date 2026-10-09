from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class ValidationIssue(BaseModel):
    location: list[str | int]
    type: str


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: list[ValidationIssue] | None = None


class ErrorResponse(BaseModel):
    data: None = None
    error: ErrorDetail
    request_id: UUID


class HealthData(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["guidy-api"] = "guidy-api"
    version: str


class HealthResponse(BaseModel):
    data: HealthData
    error: None = None
    request_id: UUID
