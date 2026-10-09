from fastapi import APIRouter, Request

from app import __version__
from app.schemas.responses import HealthData, HealthResponse

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    """Public liveness only; does not assert database/provider/Auth readiness."""
    return HealthResponse(data=HealthData(version=__version__), request_id=request.state.request_id)
