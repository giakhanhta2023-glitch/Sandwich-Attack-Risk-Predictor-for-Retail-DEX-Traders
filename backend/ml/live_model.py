"""The real-data model, served as plain arithmetic.

`train_live` fits a logistic regression on swaps sampled from Solana mainnet and
exports its coefficients to JSON. Inference is then a dot product and a sigmoid,
which needs nothing beyond the standard library -- so the model trained on real
flow runs even on the serverless deployment, where scikit-learn does not fit.

`featurize` is shared with the trainer, so the features computed at training
time and at serving time cannot drift apart.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from typing import Any

from ..app.config import ARTIFACT_DIR

MODEL_PATH = ARTIFACT_DIR / "live_model.json"

FEATURES = [
    "log_size_usd",
    "log_depth_usd",
    "log_size_to_depth",
    "is_buy",
    "hour_sin",
    "hour_cos",
    "quote_is_sol",
]

# Features explained together: the two hour terms are one idea, time of day.
_GROUPS: list[tuple[str, str, tuple[str, ...]]] = [
    ("trade_size", "Trade size", ("log_size_usd",)),
    ("pool_depth", "Pool depth", ("log_depth_usd",)),
    ("size_to_depth", "Size relative to pool", ("log_size_to_depth",)),
    ("direction", "Buying rather than selling", ("is_buy",)),
    ("hour", "Time of day", ("hour_sin", "hour_cos")),
    ("quote", "Quoted in SOL", ("quote_is_sol",)),
]


def featurize(
    size_usd: float,
    depth_usd: float,
    side: str = "buy",
    hour_utc: int = 12,
    quote_symbol: str = "SOL",
) -> list[float] | None:
    """Observable, on-chain features for one swap. None if unusable.

    `depth_usd` is the quote-side vault balance, which is what the scanner
    measures directly. The ratio of size to depth is the price-impact proxy that
    decides whether a sandwich can pay for itself.
    """
    if not (size_usd and depth_usd) or size_usd <= 0 or depth_usd <= 0:
        return None
    hour = int(hour_utc) % 24
    return [
        math.log10(size_usd),
        math.log10(depth_usd),
        math.log10(size_usd / depth_usd),
        1.0 if side == "buy" else 0.0,
        math.sin(2.0 * math.pi * hour / 24.0),
        math.cos(2.0 * math.pi * hour / 24.0),
        1.0 if quote_symbol == "SOL" else 0.0,
    ]


@lru_cache(maxsize=1)
def load() -> dict[str, Any] | None:
    if not MODEL_PATH.exists():
        return None
    try:
        model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if model.get("kind") != "logistic" or model.get("features") != FEATURES:
        return None  # an artifact from a different feature set must not be used
    return model


def _logit(model: dict[str, Any], x: list[float], at_mean: frozenset[str] = frozenset()) -> float:
    """Linear score. A feature named in `at_mean` is held at the population
    mean, where a standardised feature contributes exactly zero."""
    z = model["intercept"]
    for name, c, xi, mu, sd in zip(FEATURES, model["coef"], x, model["mean"], model["scale"]):
        if name not in at_mean:
            z += c * (xi - mu) / (sd or 1.0)
    return z


def _sigmoid(z: float) -> float:
    z = max(-60.0, min(60.0, z))
    return 1.0 / (1.0 + math.exp(-z))


def predict(
    size_usd: float,
    depth_usd: float,
    side: str = "buy",
    hour_utc: int = 12,
    quote_symbol: str = "SOL",
) -> float | None:
    """P(sandwiched) for a swap like this one, learned from real mainnet flow."""
    model = load()
    x = featurize(size_usd, depth_usd, side, hour_utc, quote_symbol) if model else None
    if model is None or x is None:
        return None
    return _sigmoid(_logit(model, x))


def explain(
    size_usd: float,
    depth_usd: float,
    side: str = "buy",
    hour_utc: int = 12,
    quote_symbol: str = "SOL",
    top: int = 5,
) -> list[dict[str, Any]]:
    """Why the live model gave this trade its score.

    Same ablation idea the simulator's explanation uses: re-score with one input
    held at the average of real flow and report the change, so the two
    explanations read the same way on screen.
    """
    model = load()
    x = featurize(size_usd, depth_usd, side, hour_utc, quote_symbol) if model else None
    if model is None or x is None:
        return []
    p = _sigmoid(_logit(model, x))
    shown = {
        "trade_size": size_usd,
        "pool_depth": depth_usd,
        "size_to_depth": size_usd / depth_usd,
        "direction": 1.0 if side == "buy" else 0.0,
        "hour": float(hour_utc),
        "quote": 1.0 if quote_symbol == "SOL" else 0.0,
    }
    out = []
    for key, label, names in _GROUPS:
        delta = p - _sigmoid(_logit(model, x, frozenset(names)))
        if abs(delta) < 1e-6:
            continue
        out.append({
            "feature": key,
            "label": label,
            "delta": round(delta, 6),
            "direction": "increases" if delta > 0 else "reduces",
            "value": round(shown[key], 6),
        })
    out.sort(key=lambda d: abs(d["delta"]), reverse=True)
    return out[:top]


def card() -> dict[str, Any] | None:
    """The model card: what it learned from, and what it leans on.

    Weights are per standard deviation of real flow, so they compare directly.
    The two hour terms are one idea, time of day, reported as a single unsigned
    magnitude because its direction depends on the hour.
    """
    model = load()
    if model is None:
        return None
    coef = dict(zip(FEATURES, model["coef"]))
    weights = []
    for key, label, names in _GROUPS:
        if len(names) == 1:
            weights.append({"feature": key, "label": label, "weight": round(coef[names[0]], 4), "signed": True})
        else:
            magnitude = math.hypot(*(coef[n] for n in names))
            weights.append({"feature": key, "label": label, "weight": round(magnitude, 4), "signed": False})
    weights.sort(key=lambda d: -abs(d["weight"]))
    return {**info(), "features": weights}


def info() -> dict[str, Any] | None:
    """What the model was trained on -- shown next to anything it predicts."""
    model = load()
    if model is None:
        return None
    return {
        "trained_at": model.get("trained_at"),
        "rows": model.get("rows"),
        "positives": model.get("positives"),
        "victim_pools": model.get("victim_pools"),
        "top_pool_share": model.get("top_pool_share"),
        "weighted_swaps": model.get("weighted_swaps"),
        "base_rate": model.get("base_rate"),
        "window": model.get("window"),
        "metrics": model.get("metrics"),
    }
