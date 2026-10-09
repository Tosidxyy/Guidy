from fastapi import FastAPI

from app import __version__
from app.api.health import router as health_router
from app.core.config import Settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware
from app.schemas.responses import ErrorResponse


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings if settings is not None else Settings()
    application = FastAPI(
        title="Guidy API",
        version=__version__,
        debug=False,
        docs_url="/docs" if config.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if config.docs_enabled else None,
        responses={422: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    )
    application.state.settings = config
    register_error_handlers(application)
    application.add_middleware(RequestContextMiddleware)
    application.include_router(health_router)
    return application


configure_logging()
app = create_app()
