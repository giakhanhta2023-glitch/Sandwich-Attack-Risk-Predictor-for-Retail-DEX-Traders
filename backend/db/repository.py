"""Data access for the Supabase tables.

Every function here degrades rather than raises when the database is absent, so
callers do not have to branch on configuration. Reads return `None` or an empty
result and the caller falls back to the local corpus; telemetry writes are
fire-and-forget and never take down a request that would otherwise have
succeeded: a risk score is worth more to the user than a log line is to us.

Bulk inserts go through `upsert` with the tables' natural keys, so re-ingesting
a block range is idempotent instead of duplicating the corpus.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from .client import read_client, require_write_client, write_client

logger = logging.getLogger(__name__)

# PostgREST rejects very large payloads; batches keep each request modest and
# give partial progress if a long ingest is interrupted.
BATCH = 500


def _iso(ts: int | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _chunks(rows: Sequence[dict[str, Any]], size: int = BATCH):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


# --------------------------------------------------------------------- pools

def sync_pools(specs: Iterable[Any]) -> int:
    """Upsert the static registry into `pools`.

    The Python registry stays the source of truth for seeded pools; this pushes
    it into the database so foreign keys resolve and so live TVL refreshes have
    a row to update.
    """
    client = require_write_client()
    rows = [
        {
            "pool_id": s.pool_id,
            "chain": s.chain,
            "symbol": s.symbol,
            "venue": _venue(s.pool_id, s.chain),
            "tvl_usd": float(s.tvl_usd),
            "fee_bps": float(s.fee_bps),
            "volatility_24h": float(s.volatility_24h),
            "price_in_usd": float(s.price_in_usd),
            "swaps_per_block": float(s.swaps_per_block),
            "is_stable_pair": bool(s.is_stable_pair),
            "token_age_days": float(s.token_age_days),
            "is_seed": True,
        }
        for s in specs
    ]
    client.table("pools").upsert(rows, on_conflict="pool_id").execute()
    return len(rows)


def _venue(pool_id: str, chain: str) -> str:
    for prefix, name in {
        "uni-v2": "Uniswap V2",
        "uni-v3": "Uniswap V3",
        "ray": "Raydium",
        "orca": "Orca",
        "pump": "Pump.fun / Raydium",
    }.items():
        if pool_id.startswith(prefix):
            return name
    return "Ethereum DEX" if chain == "ethereum" else "Solana DEX"


def fetch_pools() -> list[dict[str, Any]] | None:
    """Pools from the database, or None when it is not configured."""
    client = read_client()
    if client is None:
        return None
    try:
        res = client.table("pools").select("*").order("tvl_usd", desc=True).execute()
        return res.data or []
    except Exception as exc:
        logger.warning("pool fetch failed, falling back to static registry: %s", exc)
        return None


# --------------------------------------------------------------------- swaps

def insert_swaps(swaps: Sequence[Any]) -> int:
    """Persist normalised swaps. Idempotent on (chain, tx_hash, pool_id, token_in)."""
    if not swaps:
        return 0
    client = require_write_client()
    rows = [
        {
            "chain": s.chain,
            "block": int(s.block),
            "tx_index": int(s.tx_index),
            "tx_hash": s.tx_hash,
            "pool_id": s.pool_id,
            "trader": s.trader,
            "token_in": s.token_in,
            "token_out": s.token_out,
            "amount_in": float(s.amount_in),
            "amount_out": float(s.amount_out),
            "amount_in_usd": float(s.amount_in_usd) or None,
            "fee_bps": float(s.fee_bps),
            "reserve_in": float(s.reserve_in) if s.reserve_in is not None else None,
            "reserve_out": float(s.reserve_out) if s.reserve_out is not None else None,
            "bundle_id": s.bundle_id,
            "block_time": _iso(s.timestamp),
        }
        for s in swaps
    ]
    written = 0
    for batch in _chunks(rows):
        client.table("swaps").upsert(
            batch, on_conflict="chain,tx_hash,pool_id,token_in", ignore_duplicates=True
        ).execute()
        written += len(batch)
    return written


def recent_sandwiches(limit: int = 50) -> list[dict[str, Any]]:
    client = read_client()
    if client is None:
        return []
    try:
        res = (
            client.table("sandwich_events")
            .select("*")
            .order("detected_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as exc:
        logger.warning("sandwich fetch failed: %s", exc)
        return []


# ------------------------------------------------------------------ cursors

def get_cursor(source: str) -> dict[str, Any] | None:
    client = read_client()
    if client is None:
        return None
    try:
        res = client.table("ingestion_cursors").select("*").eq("source", source).execute()
        return (res.data or [None])[0]
    except Exception:
        return None


def update_cursor(
    source: str,
    last_block: int,
    swaps_ingested: int = 0,
    events_detected: int = 0,
    status: str = "idle",
    last_error: str | None = None,
) -> None:
    client = write_client()
    if client is None:
        return
    prior = get_cursor(source) or {}
    try:
        client.table("ingestion_cursors").upsert(
            {
                "source": source,
                "last_block": max(int(last_block), int(prior.get("last_block") or 0)),
                "last_run_at": datetime.now(timezone.utc).isoformat(),
                # counters accumulate across runs rather than reporting the last batch
                "swaps_ingested": int(prior.get("swaps_ingested") or 0) + swaps_ingested,
                "events_detected": int(prior.get("events_detected") or 0) + events_detected,
                "status": status,
                "last_error": last_error,
            },
            on_conflict="source",
        ).execute()
    except Exception as exc:
        logger.warning("cursor update failed for %s: %s", source, exc)


# ---------------------------------------------------------------- telemetry

def log_analysis(payload: dict[str, Any]) -> None:
    """Record one risk query. Never raises: telemetry must not break a request."""
    client = write_client()
    if client is None:
        return
    try:
        client.table("analyses").insert(payload).execute()
    except Exception as exc:
        logger.debug("analysis telemetry dropped: %s", exc)


def record_model_run(report: dict[str, Any]) -> str | None:
    """Store a training run so drift is visible across runs."""
    client = write_client()
    if client is None:
        return None
    metrics = report.get("metrics", {})
    try:
        res = client.table("model_runs").insert(
            {
                "data_source": report.get("data_source", "simulated"),
                "rows": report.get("rows", 0),
                "train_rows": report.get("train_rows", 0),
                "test_rows": report.get("test_rows", 0),
                "split_strategy": report.get("split", "chronological"),
                "roc_auc": metrics.get("roc_auc"),
                "pr_auc": metrics.get("pr_auc"),
                "brier": metrics.get("brier"),
                "base_rate": metrics.get("base_rate"),
                "loss_mae_bps": metrics.get("loss_mae_bps"),
                "training_seconds": report.get("training_seconds"),
                "features": report.get("features", []),
                "feature_importance": report.get("feature_importance", []),
                "reliability": metrics.get("reliability", []),
                "pool_priors": report.get("pool_priors", {}),
            }
        ).execute()
        rows = res.data or []
        return rows[0].get("id") if rows else None
    except Exception as exc:
        logger.warning("model run not recorded: %s", exc)
        return None


def model_run_history(limit: int = 20) -> list[dict[str, Any]]:
    client = read_client()
    if client is None:
        return []
    try:
        res = (
            client.table("model_runs")
            .select("id,trained_at,data_source,rows,roc_auc,pr_auc,brier,loss_mae_bps")
            .order("trained_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception:
        return []


# ------------------------------------------------------------------- views

def pool_risk_stats() -> list[dict[str, Any]]:
    """Per-pool attack rates over the last 7 days, measured by the live ingester."""
    client = read_client()
    if client is None:
        return []
    try:
        res = client.table("live_pool_risk").select("*").order("swaps", desc=True).limit(300).execute()
        return res.data or []
    except Exception as exc:
        logger.warning("live_pool_risk unavailable: %s", exc)
        return []


def latest_sol_usd() -> float | None:
    """SOL's price as the live scanner last measured it from on-chain swaps."""
    client = read_client()
    if client is None:
        return None
    try:
        res = (
            client.table("ingest_runs").select("sol_usd").filter("sol_usd", "not.is", "null")
            .order("id", desc=True).limit(1).execute()
        )
        rows = res.data or []
        return float(rows[0]["sol_usd"]) if rows else None
    except Exception as exc:
        logger.warning("ingest_runs unavailable: %s", exc)
        return None


def hottest_pools(min_swaps: int, min_victims: int, limit: int = 50) -> list[dict[str, Any]]:
    """Real pools where sandwiches caught the largest share of trades this week."""
    client = read_client()
    if client is None:
        return []
    try:
        res = (
            client.table("live_pool_risk").select("*")
            .gte("swaps", min_swaps).gte("victims", min_victims)
            .order("victim_rate", desc=True).limit(limit).execute()
        )
        return res.data or []
    except Exception as exc:
        logger.warning("live_pool_risk unavailable: %s", exc)
        return []


def measured_pool(pool_key: str) -> dict[str, Any] | None:
    """One pool's last seven days, as the live scanner measured them."""
    client = read_client()
    if client is None:
        return None
    try:
        rows = client.table("live_pool_risk").select("*").eq("pool_key", pool_key).limit(1).execute().data or []
        return rows[0] if rows else None
    except Exception as exc:
        logger.warning("live_pool_risk unavailable: %s", exc)
        return None


def severity_buckets() -> list[dict[str, Any]]:
    client = read_client()
    if client is None:
        return []
    try:
        return client.table("sandwich_severity_buckets").select("*").execute().data or []
    except Exception:
        return []


def live_summary() -> dict[str, Any]:
    """Freshness and 24h totals for the live pipeline. Empty when unreachable."""
    client = read_client()
    if client is None:
        return {}
    try:
        rows = client.table("live_summary").select("*").execute().data or []
        return rows[0] if rows else {}
    except Exception:
        return {}


def size_buckets() -> list[dict[str, Any]]:
    """Attack rate by trade size, from the weighted swap sample."""
    client = read_client()
    if client is None:
        return []
    try:
        return client.table("live_size_buckets").select("*").order("lower_usd").execute().data or []
    except Exception:
        return []


def ingestion_health() -> list[dict[str, Any]]:
    client = read_client()
    if client is None:
        return []
    try:
        return client.table("ingestion_health").select("*").execute().data or []
    except Exception:
        return []


def counts() -> dict[str, int]:
    """Row counts, used to decide whether real data has displaced the simulator."""
    client = read_client()
    if client is None:
        return {}
    out: dict[str, int] = {}
    for table in ("pools", "sandwich_events", "ingest_runs", "swap_samples", "model_runs"):
        try:
            res = client.table(table).select("*", count="exact", head=True).execute()
            out[table] = res.count or 0
        except Exception:
            out[table] = 0
    return out
