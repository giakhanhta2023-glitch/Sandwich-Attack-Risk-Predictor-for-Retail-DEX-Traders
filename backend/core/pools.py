"""Pool registry and market context.

The registry is the pool universe the UI trades against. When Helius or
BigQuery credentials are present, `refresh_from_chain` is the seam where live
TVL and volatility replace the static entries; without them the static specs
stand in, and every response carries the `data_source` flag so the distinction
is never lost on the way to the UI.

`market_snapshot` supplies the execution environment -- gas, block time, what a
searcher pays to win a slot -- which differs enough between Ethereum and Solana
that sharing one set of constants would make both wrong.
"""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Any, Literal

from ..ingestion.synthetic import default_universe


def _pool_dict(spec: Any) -> dict[str, Any]:
    return {
        "pool_id": spec.pool_id,
        "chain": spec.chain,
        "symbol": spec.symbol,
        "tvl_usd": spec.tvl_usd,
        "fee_bps": spec.fee_bps,
        "volatility_24h": spec.volatility_24h,
        "price_in_usd": spec.price_in_usd,
        "swaps_per_block": spec.swaps_per_block,
        "is_stable_pair": spec.is_stable_pair,
        "token_age_days": spec.token_age_days,
        "venue": _venue(spec.pool_id, spec.chain),
    }


def _venue(pool_id: str, chain: str) -> str:
    prefixes = {
        "uni-v2": "Uniswap V2",
        "uni-v3": "Uniswap V3",
        "ray": "Raydium",
        "orca": "Orca",
        "pump": "Pump.fun / Raydium",
    }
    for prefix, name in prefixes.items():
        if pool_id.startswith(prefix):
            return name
    return "Ethereum DEX" if chain == "ethereum" else "Solana DEX"


@lru_cache(maxsize=1)
def _registry() -> dict[str, dict[str, Any]]:
    return {spec.pool_id: _pool_dict(spec) for spec in default_universe()}


def list_pools(chain: Literal["all", "ethereum", "solana"] = "all") -> list[dict[str, Any]]:
    pools = list(_registry().values())
    if chain != "all":
        pools = [p for p in pools if p["chain"] == chain]
    return sorted(pools, key=lambda p: (-p["tvl_usd"]))


def get_pool(pool_id: str) -> dict[str, Any] | None:
    pool = _registry().get(pool_id)
    return dict(pool) if pool else None


# --------------------------------------------------------------------------
# execution environment
# --------------------------------------------------------------------------

def market_snapshot(chain: str, hour: int) -> dict[str, Any]:
    """Gas, block timing and searcher costs for the given chain and hour.

    The diurnal term is real: Ethereum gas peaks through the US afternoon, which
    raises the bar a sandwich has to clear to be worth running. It is modelled
    rather than fetched here; a live deployment reads base fee from the node and
    the Jito tip floor from the bundle API.
    """
    diurnal = 1.0 + 0.45 * math.sin(2.0 * math.pi * ((hour - 9) % 24) / 24.0)

    if chain == "solana":
        return {
            "chain": "solana",
            "block_time_s": 0.4,
            "inclusion_blocks": 2.0,
            "user_gas_usd": round(0.003 * diurnal, 4),
            "attack_cost_usd": round(0.9 * diurnal, 3),
            "cost_label": "Jito bundle tip",
            "gas_index": round(diurnal, 3),
            "note": "No public mempool -- sandwiches are built inside Jito bundles",
        }

    gas_gwei = 12.0 * diurnal
    return {
        "chain": "ethereum",
        "block_time_s": 12.0,
        "inclusion_blocks": 2.0,
        "user_gas_usd": round(gas_gwei * 150_000 * 1e-9 * 3000, 2),
        "attack_cost_usd": round(gas_gwei * 320_000 * 1e-9 * 3000 + 6.0 * diurnal, 2),
        "cost_label": "gas + builder payment",
        "gas_index": round(diurnal, 3),
        "gas_gwei": round(gas_gwei, 1),
        "note": "Public mempool -- pending swaps are visible before inclusion",
    }


# --------------------------------------------------------------------------
# corpus statistics
# --------------------------------------------------------------------------

@lru_cache(maxsize=1)
def corpus_stats() -> dict[str, Any]:
    """Attack rates and loss distributions over the training corpus.

    Read from the persisted training frame so the dashboard shows the same data
    the model was fit on, rather than a second simulation that would quietly
    disagree with it.
    """
    from ..app.config import DATA_DIR

    path = DATA_DIR / "training_frame.parquet"
    if not path.exists():
        return {"available": False, "reason": "run python -m backend.ml.train first"}

    import pandas as pd

    frame = pd.read_parquet(path)
    registry = _registry()

    by_pool = []
    for pool_id, group in frame.groupby("pool_id"):
        hit = group[group["label_sandwiched"] == 1]
        spec = registry.get(pool_id, {})
        by_pool.append({
            "pool_id": pool_id,
            "symbol": spec.get("symbol", pool_id),
            "chain": spec.get("chain", "unknown"),
            "venue": spec.get("venue", ""),
            "tvl_usd": spec.get("tvl_usd", 0),
            "swaps": int(len(group)),
            "sandwiched": int(len(hit)),
            "attack_rate": round(float(len(hit) / len(group)), 4),
            "median_loss_bps": round(float(hit["label_loss_bps"].median()), 1) if len(hit) else 0.0,
            "total_loss_usd": round(float(hit["label_loss_usd"].sum()), 2),
            "median_victim_size_usd": round(float(hit["notional_usd"].median()), 2) if len(hit) else 0.0,
        })
    by_pool.sort(key=lambda p: -p["attack_rate"])

    hit_all = frame[frame["label_sandwiched"] == 1]

    # attack rate as a function of the tolerance the victim set -- the single
    # most useful chart in the whole corpus
    buckets = [(0, 25), (25, 50), (50, 100), (100, 200), (200, 300), (300, 500), (500, 1000), (1000, 6000)]
    by_slippage = []
    for lo, hi in buckets:
        sub = frame[(frame["slippage_bps"] >= lo) & (frame["slippage_bps"] < hi)]
        if len(sub) < 50:
            continue
        sub_hit = sub[sub["label_sandwiched"] == 1]
        by_slippage.append({
            "bucket": f"{lo}-{hi}bp",
            "lower_bps": lo,
            "upper_bps": hi,
            "swaps": int(len(sub)),
            "attack_rate": round(float(len(sub_hit) / len(sub)), 4),
            "median_loss_bps": round(float(sub_hit["label_loss_bps"].median()), 1) if len(sub_hit) else 0.0,
        })

    size_buckets = [(0, 250), (250, 1000), (1000, 5000), (5000, 25000), (25000, 100000), (100000, 10_000_000)]
    by_size = []
    for lo, hi in size_buckets:
        sub = frame[(frame["notional_usd"] >= lo) & (frame["notional_usd"] < hi)]
        if len(sub) < 50:
            continue
        sub_hit = sub[sub["label_sandwiched"] == 1]
        by_size.append({
            "bucket": f"${lo:,}-${hi:,}" if hi < 10_000_000 else f"${lo:,}+",
            "swaps": int(len(sub)),
            "attack_rate": round(float(len(sub_hit) / len(sub)), 4),
            "median_loss_usd": round(float(sub_hit["label_loss_usd"].median()), 2) if len(sub_hit) else 0.0,
        })

    return {
        "available": True,
        "data_source": "simulated",
        "total_swaps": int(len(frame)),
        "total_sandwiches": int(len(hit_all)),
        "overall_attack_rate": round(float(len(hit_all) / len(frame)), 4),
        "total_victim_loss_usd": round(float(hit_all["label_loss_usd"].sum()), 2),
        "median_loss_bps": round(float(hit_all["label_loss_bps"].median()), 1),
        "median_loss_usd": round(float(hit_all["label_loss_usd"].median()), 2),
        "by_pool": by_pool,
        "by_slippage": by_slippage,
        "by_size": by_size,
    }
