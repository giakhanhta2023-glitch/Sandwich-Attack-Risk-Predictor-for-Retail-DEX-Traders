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
import time
from functools import lru_cache
from typing import Any, Literal

from ..app.config import ARTIFACT_DIR
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


def _static_registry() -> dict[str, dict[str, Any]]:
    return {spec.pool_id: _pool_dict(spec) for spec in default_universe()}


@lru_cache(maxsize=1)
def _registry() -> dict[str, dict[str, Any]]:
    """Pool universe, preferring the database.

    When Supabase is configured the registry is whatever `pools` holds, so TVL
    and volatility can be refreshed from the chain without a redeploy. Without
    it -- or if the fetch fails -- the static registry stands in, which is what
    keeps a credential-free checkout working.
    """
    from ..db.repository import fetch_pools

    rows = fetch_pools()
    if not rows:
        return _static_registry()

    numeric = (
        "tvl_usd", "fee_bps", "volatility_24h", "price_in_usd",
        "swaps_per_block", "token_age_days",
    )
    registry: dict[str, dict[str, Any]] = {}
    for row in rows:
        pool = {k: row.get(k) for k in (
            "pool_id", "chain", "symbol", "venue", "is_stable_pair", "pool_address",
        )}
        # PostgREST returns `numeric` as strings to preserve precision; the
        # solver wants floats
        pool.update({k: float(row[k]) for k in numeric if row.get(k) is not None})
        pool["is_stable_pair"] = bool(pool.get("is_stable_pair"))
        registry[row["pool_id"]] = pool

    # anything the database has not caught up on yet still resolves
    for pool_id, spec in _static_registry().items():
        registry.setdefault(pool_id, spec)
    return registry


def refresh_registry() -> None:
    """Drop the cached registry so the next read re-queries the database."""
    _registry.cache_clear()


def list_pools(chain: Literal["all", "ethereum", "solana"] = "all") -> list[dict[str, Any]]:
    """Pools for the UI: real measured pools first, then the reference registry.

    The live pools are the real Solana pools where the scanner caught the
    largest share of trades in sandwiches this week, described by what it
    measured. The registry's pools are illustrative specs, kept as references.
    Solana leads because it is the source that runs live.
    """
    pools = list(_registry().values())
    if chain != "all":
        pools = [p for p in pools if p["chain"] == chain]
    pools = sorted(pools, key=lambda p: (p["chain"] != "solana", -p["tvl_usd"]))
    if chain in ("all", "solana"):
        pools = [dict(p) for p in live_pools()] + pools
    return pools


def get_pool(pool_id: str) -> dict[str, Any] | None:
    if pool_id.startswith(LIVE_POOL_PREFIX):
        pool = _measured_pools().get(pool_id) or _measured_pool(pool_id[len(LIVE_POOL_PREFIX):])
    else:
        pool = _registry().get(pool_id)
    return dict(pool) if pool else None


# --------------------------------------------------------------------------
# live pools: real pools the scanner measured
# --------------------------------------------------------------------------

LIVE_POOL_PREFIX = "live:"
LIVE_POOLS_SHOWN = 10
# What makes a rate trustworthy is the victims behind it, not the swaps: a pool
# where 67 of 69 trades were caught says more than a quiet pool with thousands.
# Requiring 150 swaps hid exactly the pools bots were working hardest.
LIVE_MIN_SWAPS = 60
LIVE_MIN_VICTIMS = 10
# Not measured per pool, so set from the venues these pools trade on: Raydium
# CPMM and PumpSwap both charge 0.25%, and a young memecoin swings about half
# its value in a day.
LIVE_FEE_BPS = 25.0
LIVE_VOLATILITY = 0.5
_measured_cache: tuple[float, dict[str, dict[str, Any]]] | None = None


def _live_pool(r: dict[str, Any], sol_usd: float) -> dict[str, Any] | None:
    """A real pool described by what the scanner saw over the last seven days --
    swaps, the traders caught inside sandwiches, the average trade, quote-side
    depth -- or None when there is too little flow to quote a rate."""
    swaps = int(r.get("swaps") or 0)
    victims = min(int(r.get("victims") or 0), swaps)
    quote = r.get("quote_symbol")
    tvl = float(r.get("est_tvl_usd") or 0)
    if swaps < LIVE_MIN_SWAPS or victims < LIVE_MIN_VICTIMS or quote not in ("SOL", "USDC", "USDT") or tvl <= 0:
        return None
    quote_usd = sol_usd if quote == "SOL" else 1.0
    pool_id = LIVE_POOL_PREFIX + r["pool_key"]
    return {
            "pool_id": pool_id,
            "chain": "solana",
            "symbol": f"{mint_label(r.get('base_mint'))}/{quote}",
            "tvl_usd": tvl,
            "fee_bps": LIVE_FEE_BPS,
            "volatility_24h": LIVE_VOLATILITY,
            "price_in_usd": quote_usd,
            "swaps_per_block": 1.0,
            "is_stable_pair": False,
            "token_age_days": 7.0,
            "venue": "Live pool \u00b7 measured on mainnet",
            "live": True,
            "measured": {
                "swaps": swaps,
                "victims": victims,
                "sandwiches": int(r.get("sandwiches") or 0),
                "victim_rate": round(victims / swaps, 5),
                "avg_trade_usd": round(float(r.get("quote_volume") or 0) / swaps * quote_usd, 2),
                "base_mint": r.get("base_mint"),
                "window_days": 7,
            },
        }


def _measured_pools() -> dict[str, dict[str, Any]]:
    """The real pools where sandwiches caught the largest share of trades this
    week, by pool id, refreshed on the same five-minute clock as the measured
    corpus. Ranked in the database: taking the busiest pools first and ranking
    those left out every pool a bot hammered for a day."""
    global _measured_cache
    now = time.monotonic()
    if _measured_cache is not None and now - _measured_cache[0] <= MEASURED_TTL_SECONDS:
        return _measured_cache[1]
    from ..db.repository import hottest_pools, latest_sol_usd

    sol_usd = latest_sol_usd() or 100.0
    pools: dict[str, dict[str, Any]] = {}
    for r in hottest_pools(LIVE_MIN_SWAPS, LIVE_MIN_VICTIMS):
        pool = _live_pool(r, sol_usd)
        if pool:
            pools[pool["pool_id"]] = pool
    _measured_cache = (now, pools)
    return pools


def _measured_pool(pool_key: str) -> dict[str, Any] | None:
    """One real pool by key, so a pool that drops off the top list still resolves."""
    from ..db.repository import latest_sol_usd, measured_pool

    row = measured_pool(pool_key)
    return _live_pool(row, latest_sol_usd() or 100.0) if row else None


def live_pools() -> list[dict[str, Any]]:
    """The real pools where sandwiches caught the largest share of trades this week."""
    ranked = sorted(_measured_pools().values(), key=lambda p: -p["measured"]["victim_rate"])
    return ranked[:LIVE_POOLS_SHOWN]


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
            "note": "No public mempool: sandwiches are built inside Jito bundles",
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
        "note": "Public mempool: pending swaps are visible before inclusion",
    }


# --------------------------------------------------------------------------
# corpus statistics
# --------------------------------------------------------------------------

# The corpus view switches from the simulator to measured chain data only once
# there is enough of it to be less noisy than what it replaces -- roughly an hour
# of the live ingester. The live dashboard shows real data from the first run.
MIN_MEASURED_SWAPS = 50_000
MIN_MEASURED_SANDWICHES = 30

# Display names for common Solana mints; anything else is shown abbreviated.
KNOWN_MINTS = {
    "So11111111111111111111111111111111111111112": "SOL",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": "JitoSOL",
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
    "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": "PYTH",
    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
    "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "POPCAT",
    "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "TRUMP",
}


def mint_label(mint: str | None) -> str:
    if not mint:
        return "?"
    return KNOWN_MINTS.get(mint, mint[:4] + "..." + mint[-4:])


def _chain_corpus_stats() -> dict[str, Any] | None:
    """Dashboard figures from the live Solana ingester, once there is enough."""
    from ..db.repository import pool_risk_stats, size_buckets

    pools = pool_risk_stats()
    total_swaps = sum(int(r.get("swaps") or 0) for r in pools)
    total_hits = sum(int(r.get("sandwiches") or 0) for r in pools)
    if total_swaps < MIN_MEASURED_SWAPS or total_hits < MIN_MEASURED_SANDWICHES:
        return None

    # Rank by attack rate, but only among pools with enough swaps for the rate to
    # mean something -- one sandwich in three swaps is noise, not a finding.
    ranked = sorted(
        (r for r in pools if int(r.get("swaps") or 0) >= 200),
        key=lambda r: -float(r.get("attack_rate") or 0),
    )[:15]
    by_pool = [
        {
            "pool_id": r["pool_key"],
            "symbol": mint_label(r.get("base_mint")) + "/" + (r.get("quote_symbol") or mint_label(r.get("quote_mint"))),
            "chain": "solana",
            "venue": "measured on mainnet",
            "tvl_usd": float(r.get("est_tvl_usd") or 0),
            "swaps": int(r.get("swaps") or 0),
            "sandwiched": int(r.get("sandwiches") or 0),
            "attack_rate": float(r.get("attack_rate") or 0),
            "median_loss_bps": float(r.get("median_loss_bps_lb") or 0),
            "total_loss_usd": float(r.get("profit_usd") or 0),
            "median_victim_size_usd": 0.0,
        }
        for r in ranked
    ]
    hit_pools = [p for p in by_pool if p["sandwiched"]]

    return {
        "available": True,
        "data_source": "chain",
        "total_swaps": total_swaps,
        "total_sandwiches": total_hits,
        "overall_attack_rate": round(total_hits / total_swaps, 5) if total_swaps else 0.0,
        # attacker profit is measured exactly; the victims lost at least that much
        "total_victim_loss_usd": round(sum(float(r.get("profit_usd") or 0) for r in pools), 2),
        "median_loss_bps": round(sum(p["median_loss_bps"] for p in hit_pools) / max(len(hit_pools), 1), 1),
        "median_loss_usd": 0.0,
        "by_pool": by_pool,
        # A victim's slippage tolerance is not visible in balance changes, so the
        # measured corpus has no tolerance cut; the UI hides that chart.
        "by_slippage": [],
        "by_size": [
            {
                "bucket": b["bucket"],
                "swaps": int(b.get("est_swaps") or 0),
                "attack_rate": float(b.get("attack_rate") or 0),
                "median_loss_usd": 0.0,
            }
            for b in size_buckets()
        ],
    }


# The measured corpus moves every minute while the simulated one never does, so
# the measured side is re-read every few minutes rather than once per process: a
# warm server would otherwise keep showing the simulator long after chain data
# had overtaken it.
MEASURED_TTL_SECONDS = 300
_measured: tuple[float, dict[str, Any] | None] | None = None


def corpus_stats() -> dict[str, Any]:
    """Attack rates and loss distributions for the dashboard.

    Measured chain data wins over the simulator as soon as there is enough of it
    to say anything: a handful of rows would produce a noisier picture than the
    corpus it replaced.
    """
    global _measured
    now = time.monotonic()
    if _measured is None or now - _measured[0] > MEASURED_TTL_SECONDS:
        _measured = (now, _chain_corpus_stats())
    return _measured[1] or _simulated_corpus_stats()


@lru_cache(maxsize=1)
def _simulated_corpus_stats() -> dict[str, Any]:
    """Aggregates over the simulated training corpus.

    Read from the persisted training frame so the dashboard shows the same data
    the model was fit on, rather than a second simulation that would quietly
    disagree with it.
    """
    from ..app.config import DATA_DIR

    # A precomputed summary is what ships to production: it is ~5KB against the
    # corpus's 13MB, and reading it needs neither pandas nor pyarrow, which
    # together are 160MB of dependencies a serverless function should not carry.
    summary_path = ARTIFACT_DIR / "corpus_summary.json"
    if summary_path.exists():
        import json

        return json.loads(summary_path.read_text(encoding="utf-8"))

    path = DATA_DIR / "training_frame.parquet"
    if not path.exists():
        return {"available": False, "reason": "run python -m backend.ml.train first"}

    import pandas as pd

    frame = pd.read_parquet(path)
    return aggregate_corpus(frame)


def aggregate_corpus(frame: Any) -> dict[str, Any]:
    """Dashboard aggregates from a training frame.

    Lives here rather than in the trainer so the shape the API serves and the
    shape the trainer precomputes cannot drift apart.
    """
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
