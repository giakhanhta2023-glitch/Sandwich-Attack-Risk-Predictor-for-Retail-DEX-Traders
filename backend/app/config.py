"""Runtime configuration.

Credentials are read from the environment, never checked in. Each data source
reports whether it is actually live so the UI can label every number honestly
rather than passing simulated figures off as chain data.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
ARTIFACT_DIR = BASE_DIR / "artifacts"
DATA_DIR = BASE_DIR / "data"
# Creating these at import is a convenience for local development. A serverless
# filesystem is read-only outside /tmp, and `backend/data` is not shipped, so the
# attempt raises there, which would crash the function before it serves a
# single request. Nothing on the serving path writes to either directory, so
# failing to create them is not an error worth propagating.
for _directory in (ARTIFACT_DIR, DATA_DIR):
    try:
        _directory.mkdir(exist_ok=True)
    except OSError:
        pass


def _load_dotenv() -> None:
    """Minimal .env loader so there is no hard dependency on python-dotenv."""
    # public.env comes last and only fills gaps, so real configuration always wins.
    for candidate in (BASE_DIR.parent / ".env", BASE_DIR / ".env", BASE_DIR / "public.env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            # Blank counts as unset: a hosting dashboard entry that was created and
            # left empty must not block a real value from a file.
            if not os.environ.get(key, "").strip():
                os.environ[key] = value.strip().strip('"').strip("'")


_load_dotenv()


def _env_str(name: str, default: str = "") -> str:
    """Environment string, treating a blank value as unset.

    Hosting dashboards routinely hold a variable that has been created but left
    empty. `os.getenv(name, default)` only falls back when the name is *absent*,
    so an empty value silently wins over the default.
    """
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


def _env_int(name: str, default: int) -> int:
    """Environment integer that tolerates blank and malformed values.

    An empty variable previously reached `int("")` and raised at import time,
    which on a serverless host kills the function before it serves anything.
    A bad value is not worth crashing over when a sane default exists.
    """
    raw = _env_str(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    helius_api_key: str = _env_str("HELIUS_API_KEY")
    # Supabase. The publishable key is safe to ship: RLS constrains it to the
    # public research tables. The service key bypasses RLS and must never be
    # committed or sent anywhere but the database.
    supabase_url: str = _env_str("SUPABASE_URL")
    supabase_publishable_key: str = _env_str("SUPABASE_PUBLISHABLE_KEY")
    supabase_service_key: str = _env_str("SUPABASE_SERVICE_KEY")
    helius_rpc_url: str = _env_str("HELIUS_RPC_URL")
    bigquery_project: str = _env_str("BIGQUERY_PROJECT")
    google_credentials: str = _env_str("GOOGLE_APPLICATION_CREDENTIALS")
    max_blocks_per_pull: int = _env_int("MAX_BLOCKS_PER_PULL", 200)
    bigquery_max_bytes: int = _env_int("BIGQUERY_MAX_BYTES", 20 * 1024**3)

    @property
    def db_configured(self) -> bool:
        return bool(self.supabase_url and (self.supabase_publishable_key or self.supabase_service_key))

    @property
    def db_writable(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_key)

    @property
    def helius_live(self) -> bool:
        return bool(self.helius_api_key or self.helius_rpc_url)

    @property
    def bigquery_live(self) -> bool:
        return bool(self.bigquery_project and self.google_credentials)

    def solana_rpc(self) -> str:
        if self.helius_rpc_url:
            return self.helius_rpc_url
        return f"https://mainnet.helius-rpc.com/?api-key={self.helius_api_key}"

    def source_status(self) -> dict[str, dict[str, object]]:
        return {
            "database": {
                "provider": "Supabase Postgres",
                "live": self.db_configured,
                "detail": (
                    "persisting swaps, detections and model runs"
                    if self.db_writable
                    else "read-only: add SUPABASE_SERVICE_KEY to persist"
                    if self.db_configured
                    else "set SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY to enable"
                ),
            },
            "solana": {
                "provider": "Helius",
                "live": self.helius_live,
                "detail": "Enhanced Transactions API + RPC"
                if self.helius_live
                else "set HELIUS_API_KEY to stream live Solana swaps",
            },
            "ethereum": {
                "provider": "Google BigQuery",
                "live": self.bigquery_live,
                "detail": "bigquery-public-data.crypto_ethereum"
                if self.bigquery_live
                else "set BIGQUERY_PROJECT + GOOGLE_APPLICATION_CREDENTIALS to query live",
            },
        }


settings = Settings()
