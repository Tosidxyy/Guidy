import json
import logging
from logging.config import dictConfig


class PrivacyFormatter(logging.Formatter):
    """Serialize a field allowlist; never format messages or exception tracebacks."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {"level": record.levelname, "event": "server_event"}
        if record.name == "guidy.requests":
            payload["event"] = "request_completed"
            for key in ("request_id", "method", "route", "status_code", "duration_ms"):
                payload[key] = getattr(record, key, None)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"private": {"()": PrivacyFormatter}},
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "private",
                    "stream": "ext://sys.stdout",
                }
            },
            "loggers": {
                "guidy.requests": {"handlers": ["console"], "level": "INFO", "propagate": False},
                # Uvicorn access lines would otherwise include raw URLs and query strings.
                "uvicorn.access": {"handlers": [], "propagate": False},
                "uvicorn.error": {"handlers": ["console"], "level": "INFO", "propagate": False},
            },
        }
    )
