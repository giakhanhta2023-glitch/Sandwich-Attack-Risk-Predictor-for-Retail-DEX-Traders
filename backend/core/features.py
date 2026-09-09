"""Feature construction, shared by training and serving.

One function builds the feature vector for both paths. That is deliberate: the
most common way an MEV model quietly degrades is train/serve skew, where the
training pipeline computes a feature slightly differently from the API.

The physics-derived features (`attacker_profit_usd`, `frontrun_capacity_usd`,
`profit_over_cost`) matter most. They fold the closed-form AMM economics into
the model, so the learner spends its capacity on the part it cannot derive --
whether a searcher is actually present and willing -- rather than rediscovering
the constant-product curve from data.
"""

from __future__ import annotations

import math
from typing import Any

from .amm import optimal_sandwich, frontrun_capacity, price_impact_bps, reserves_from_tvl

FEATURE_COLUMNS: list[str] = [
    "log_notional_usd",
    "log_tvl_usd",
    "size_over_tvl",
    "slippage_bps",
    "fee_bps",
    "volatility_24h",
    "attack_cost_usd",
    "price_impact_bps",
    "attacker_profit_usd",
    "profit_over_cost",
    "frontrun_capacity_usd",
    "capacity_over_notional",
    "swaps_per_block",
    "is_private_relay",
    "is_solana",
    "is_stable_pair",
    "token_age_days",
    "hour_sin",
    "hour_cos",
    "pool_attack_rate_prior",
]


def build_features(
    *,
    notional_usd: float,
    pool_tvl_usd: float,
    slippage_bps: float,
    fee_bps: float = 30.0,
    volatility_24h: float = 0.04,
    attack_cost_usd: float = 15.0,
    price_in_usd: float = 1.0,
    price_out_usd: float = 1.0,
    swaps_per_block: float = 2.0,
    is_private_relay: bool = False,
    chain: str = "ethereum",
    is_stable_pair: bool = False,
    token_age_days: float = 365.0,
    hour_of_day: int = 12,
    pool_attack_rate_prior: float = 0.05,
    **_ignored: Any,
) -> dict[str, float]:
    """Build one feature row. Keyword-only so callers cannot transpose arguments."""
    r_in, r_out = reserves_from_tvl(pool_tvl_usd, price_in_usd, price_out_usd)
    gamma = 1.0 - fee_bps / 10_000.0
    size_in = notional_usd / max(price_in_usd, 1e-12)
    s = slippage_bps / 10_000.0

    outcome = optimal_sandwich(size_in, r_in, r_out, s, price_in_usd, attack_cost_usd, gamma)
    capacity = frontrun_capacity(size_in, r_in, r_out, s, gamma) * price_in_usd

    return {
        "log_notional_usd": math.log1p(max(notional_usd, 0.0)),
        "log_tvl_usd": math.log1p(max(pool_tvl_usd, 0.0)),
        "size_over_tvl": notional_usd / max(pool_tvl_usd, 1.0),
        "slippage_bps": slippage_bps,
        "fee_bps": fee_bps,
        "volatility_24h": volatility_24h,
        "attack_cost_usd": attack_cost_usd,
        "price_impact_bps": price_impact_bps(size_in, r_in, r_out, gamma),
        "attacker_profit_usd": outcome.attacker_profit_usd,
        "profit_over_cost": outcome.attacker_profit_usd / max(attack_cost_usd, 1e-6),
        "frontrun_capacity_usd": capacity,
        "capacity_over_notional": capacity / max(notional_usd, 1e-6),
        "swaps_per_block": swaps_per_block,
        "is_private_relay": 1.0 if is_private_relay else 0.0,
        "is_solana": 1.0 if chain == "solana" else 0.0,
        "is_stable_pair": 1.0 if is_stable_pair else 0.0,
        "token_age_days": token_age_days,
        "hour_sin": math.sin(2.0 * math.pi * hour_of_day / 24.0),
        "hour_cos": math.cos(2.0 * math.pi * hour_of_day / 24.0),
        "pool_attack_rate_prior": pool_attack_rate_prior,
    }


def to_vector(features: dict[str, float]) -> list[float]:
    """Dict -> ordered vector. The column order is the contract with the model."""
    return [float(features[c]) for c in FEATURE_COLUMNS]
