"""Serving-side model wrapper.

Loads the trained artifacts once and answers three questions per request:

  * how likely is a sandwich on this trade
  * conditional on one landing, how bad is it
  * which inputs drove that number

Attribution is done by ablation: re-score the row with one feature reset to its
training median and report the change. It is more expensive than reading feature
importances off the model, but importances are global and a user asking "why is
my trade risky" needs the answer for *their* trade.

If no artifacts exist the wrapper degrades to the closed-form economics rather
than failing. A physics-only prior is a weaker answer, but it is a defensible
one, and it keeps a fresh checkout usable before anything is trained.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from joblib import load

from ..app.config import ARTIFACT_DIR
from ..core.features import FEATURE_COLUMNS, build_features, to_vector

# features worth explaining to a user -- the rest are context, not levers
EXPLAINABLE = [
    "slippage_bps",
    "log_notional_usd",
    "log_tvl_usd",
    "attacker_profit_usd",
    "is_private_relay",
    "volatility_24h",
    "fee_bps",
    "pool_attack_rate_prior",
    "size_over_tvl",
]

HUMAN_NAMES = {
    "slippage_bps": "Slippage tolerance",
    "log_notional_usd": "Trade size",
    "log_tvl_usd": "Pool depth",
    "attacker_profit_usd": "Attacker profit at stake",
    "is_private_relay": "Private relay routing",
    "volatility_24h": "Pair volatility",
    "fee_bps": "Pool fee tier",
    "pool_attack_rate_prior": "Pool's historical attack rate",
    "size_over_tvl": "Size relative to pool",
    "capacity_over_notional": "Front-run budget vs trade size",
    "profit_over_cost": "Attacker profit vs gas cost",
}


class RiskPredictor:
    def __init__(self, artifact_dir: Path | None = None):
        self.dir = artifact_dir or ARTIFACT_DIR
        self.classifier = None
        self.regressor = None
        self.report: dict[str, Any] = {}
        self.medians: dict[str, float] = {}
        self._load()

    # ---------------- lifecycle ----------------

    def _load(self) -> None:
        clf_path = self.dir / "sandwich_classifier.joblib"
        reg_path = self.dir / "loss_regressor.joblib"
        rep_path = self.dir / "model_report.json"

        if clf_path.exists():
            self.classifier = load(clf_path)
        if reg_path.exists():
            self.regressor = load(reg_path)
        if rep_path.exists():
            self.report = json.loads(rep_path.read_text(encoding="utf-8"))

        # medians for ablation, from the training frame when it is around
        frame_path = self.dir.parent / "data" / "training_frame.parquet"
        if frame_path.exists():
            try:
                import pandas as pd

                frame = pd.read_parquet(frame_path, columns=FEATURE_COLUMNS)
                self.medians = {c: float(frame[c].median()) for c in FEATURE_COLUMNS}
            except Exception:
                self.medians = {}

    @property
    def trained(self) -> bool:
        return self.classifier is not None

    def pool_prior(self, pool_id: str) -> float:
        priors = self.report.get("pool_priors", {})
        return float(priors.get(pool_id, priors.get("global_rate", 0.03)))

    # ---------------- inference ----------------

    def _raw_probability(self, vector: list[float]) -> float:
        arr = np.asarray([vector], dtype=float)
        return float(self.classifier.predict_proba(arr)[0, 1])

    def predict(self, **kwargs: Any) -> dict[str, Any]:
        """Score one intended trade."""
        features = build_features(**kwargs)
        vector = to_vector(features)

        if not self.trained:
            return self._fallback(features, kwargs)

        p_attack = self._raw_probability(vector)

        if self.regressor is not None:
            loss_bps = float(self.regressor.predict(np.asarray([vector], dtype=float))[0])
        else:
            loss_bps = features["slippage_bps"] * 0.9
        # a sandwich cannot cost more than the tolerance that permitted it
        loss_bps = max(0.0, min(loss_bps, features["slippage_bps"]))

        return {
            "p_attack": round(p_attack, 5),
            "expected_loss_bps_if_attacked": round(loss_bps, 2),
            "expected_loss_usd": round(
                p_attack * (loss_bps / 10_000.0) * kwargs.get("notional_usd", 0.0), 4
            ),
            "risk_band": risk_band(p_attack),
            "drivers": self._attribute(vector, p_attack, features),
            "model": "gradient-boosted trees, isotonic-calibrated",
            "source": "trained",
        }

    def _attribute(
        self, vector: list[float], p_attack: float, features: dict[str, float]
    ) -> list[dict[str, Any]]:
        """Ablation attribution: what does this feature contribute for this row?"""
        if not self.medians:
            return []

        contributions: list[dict[str, Any]] = []
        for name in EXPLAINABLE:
            if name not in FEATURE_COLUMNS:
                continue
            idx = FEATURE_COLUMNS.index(name)
            probe = list(vector)
            probe[idx] = self.medians.get(name, probe[idx])
            baseline = self._raw_probability(probe)
            delta = p_attack - baseline
            if abs(delta) < 0.0015:
                continue
            contributions.append(
                {
                    "feature": name,
                    "label": HUMAN_NAMES.get(name, name),
                    "delta": round(delta, 5),
                    "direction": "increases" if delta > 0 else "reduces",
                    "value": round(features[name], 4),
                }
            )
        contributions.sort(key=lambda d: abs(d["delta"]), reverse=True)
        return contributions[:5]

    def _fallback(self, features: dict[str, float], kwargs: dict[str, Any]) -> dict[str, Any]:
        """Physics-only prior, used before the models are trained."""
        profit = features["attacker_profit_usd"]
        cost = max(features["attack_cost_usd"], 1.0)
        take = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, profit / (cost * 0.6)))))
        prior = features["pool_attack_rate_prior"] or 0.05
        p = min(0.95, take * (0.35 + 4.0 * prior)) * (0.05 if features["is_private_relay"] else 1.0)
        return {
            "p_attack": round(p, 5),
            "expected_loss_bps_if_attacked": round(features["slippage_bps"] * 0.9, 2),
            "expected_loss_usd": round(
                p * (features["slippage_bps"] * 0.9 / 10_000.0) * kwargs.get("notional_usd", 0.0), 4
            ),
            "risk_band": risk_band(p),
            "drivers": [],
            "model": "closed-form economics (no trained artifacts found)",
            "source": "fallback",
        }


def risk_band(p: float) -> str:
    if p < 0.02:
        return "minimal"
    if p < 0.08:
        return "low"
    if p < 0.25:
        return "elevated"
    if p < 0.5:
        return "high"
    return "severe"


_predictor: RiskPredictor | None = None


def get_predictor() -> RiskPredictor:
    """Process-wide singleton -- loading joblib artifacts per request is wasteful."""
    global _predictor
    if _predictor is None:
        _predictor = RiskPredictor()
    return _predictor
