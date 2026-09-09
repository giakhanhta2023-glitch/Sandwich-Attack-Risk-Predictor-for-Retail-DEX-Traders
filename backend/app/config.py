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
ARTIFACT_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)


def _load_dotenv() -> None:
    """Minimal .env loader so there is no hard dependency on python-dotenv."""
    for candidate in (BASE_DIR.parent / ".env", BASE_DIR / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


@dataclass(frozen=True)
class Settings:
    helius_api_key: str = os.getenv("HELIUS_API_KEY", "")
    helius_rpc_url: str = os.getenv("HELIUS_RPC_URL", "")
    bigquery_project: str = os.getenv("BIGQUERY_PROJECT", "")
    google_credentials: str = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    max_blocks_per_pull: int = int(os.getenv("MAX_BLOCKS_PER_PULL", "200"))
    bigquery_max_bytes: int = int(os.getenv("BIGQUERY_MAX_BYTES", str(20 * 1024**3)))

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
