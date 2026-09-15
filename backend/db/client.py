"""Supabase connection handling.

Two clients, deliberately separated:

  * a **read** client using the publishable key, which is subject to row level
    security: it can see pools, swaps, detected sandwiches and model runs,
    and nothing else;
  * a **write** client using the service role key, which bypasses RLS and is
    the only way anything gets inserted.

The service key is never fetched programmatically and never logged. It comes
from the environment or it does not exist, and if it does not exist the app
runs read-only against the database and falls back to local files for
everything else. That fallback is not a nicety: it is what keeps a fresh
checkout runnable with no credentials at all.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from ..app.config import settings

logger = logging.getLogger(__name__)

# Tables that the read client is allowed to see, mirroring the RLS policies.
# Listed here so a policy change and a code change are visibly out of step.
PUBLIC_TABLES = ("pools", "swaps", "sandwich_events", "model_runs")


class DatabaseUnavailable(RuntimeError):
    """Raised when an operation needs the database and it is not configured."""


@lru_cache(maxsize=2)
def _client(write: bool) -> Any | None:
    if not settings.supabase_url:
        return None

    key = settings.supabase_service_key if write else settings.supabase_publishable_key
    if not key:
        return None

    try:
        from supabase import create_client
    except ImportError:  # pragma: no cover - optional dependency
        logger.warning("supabase-py is not installed; database features are off")
        return None

    try:
        return create_client(settings.supabase_url, key)
    except Exception as exc:  # pragma: no cover - network/config failure
        logger.warning("could not create Supabase client: %s", type(exc).__name__)
        return None


def read_client() -> Any | None:
    """RLS-constrained client for reads. None when not configured."""
    return _client(False) or _client(True)


def write_client() -> Any | None:
    """Service-role client for writes. None unless SUPABASE_SERVICE_KEY is set."""
    return _client(True)


def require_write_client() -> Any:
    client = write_client()
    if client is None:
        raise DatabaseUnavailable(
            "Writes need SUPABASE_URL and SUPABASE_SERVICE_KEY. "
            "Copy the service_role key from your Supabase dashboard into .env."
        )
    return client


def db_status() -> dict[str, Any]:
    """What the API reports about its own storage layer."""
    return {
        "configured": bool(settings.supabase_url),
        "readable": read_client() is not None,
        "writable": write_client() is not None,
        "url": settings.supabase_url or None,
        "detail": (
            "connected"
            if write_client() is not None
            else "read-only: set SUPABASE_SERVICE_KEY to persist swaps and detections"
            if read_client() is not None
            else "not configured: the app runs on local files and the simulator"
        ),
    }
