"""Train a sandwich-risk model on real Solana mainnet flow.

Data comes from `public.swap_samples`, written every minute by the
`solana-ingest` edge function. Every victim swap is kept; other swaps are
sampled at 2% and carry a weight of 50, so weighted statistics estimate the real
population rather than the sample.

The model is a logistic regression on seven observable features, and that is a
deliberate choice rather than a placeholder:

  * positives arrive at a few per scan at best, and in bursts, so a flexible
    model would overfit long before there is enough data to justify it;
  * the exported JSON is served as plain arithmetic (see `live_model`), so the
    model trained on real flow runs on the serverless deployment too.

What it cannot see: a victim's slippage tolerance is not visible in balance
changes. This model therefore estimates risk averaged over the tolerances real
traders actually set; the analyser's closed-form economics supply how that risk
changes with tolerance.

    python -m backend.ml.train_live
"""

from __future__ import annotations

import json
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from ..app.config import ARTIFACT_DIR
from ..db.client import read_client
from .live_model import FEATURES, MODEL_PATH, featurize

MIN_POSITIVES = 30
MIN_ROWS = 300
HOLDOUT_FRACTION = 0.2
PAGE = 1000
# The model sets the Solana headline unattended, so a retrain must at least beat
# a coin flip on data it has not seen, or the previous model stays in place.
MIN_HOLDOUT_AUC = 0.5

COLUMNS = "quote_usd,pool_depth_usd,side,hour_utc,quote_symbol,is_victim,sample_weight,created_at,pool_key"


def fetch_samples() -> list[dict[str, Any]]:
    """Every usable sample, oldest first. Public read, so no service key needed."""
    client = read_client()
    if client is None:
        raise SystemExit("Supabase is not configured: set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.")
    rows: list[dict[str, Any]] = []
    start = 0
    while True:
        res = (
            client.table("swap_samples")
            .select(COLUMNS)
            .filter("quote_usd", "not.is", "null")
            .filter("pool_depth_usd", "not.is", "null")
            .order("created_at")
            .range(start, start + PAGE - 1)
            .execute()
        )
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE:
            return rows
        start += PAGE


def _weighted_moments(x: np.ndarray, w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Standardise with population weights, so the scaling reflects real flow.

    A feature that never varied gets a scale of 1, not a near-zero one: the first
    live sample spanned a single hour, and dividing by ~0 would let any other hour
    at serving time swing the score on a coefficient the data never informed.
    """
    mean = np.average(x, axis=0, weights=w)
    var = np.average((x - mean) ** 2, axis=0, weights=w)
    return mean, np.where(var > 1e-12, np.sqrt(var), 1.0)


def train(verbose: bool = True) -> dict[str, Any]:
    raw = fetch_samples()
    x_rows, y, w, stamps, pools = [], [], [], [], []
    for r in raw:
        f = featurize(float(r["quote_usd"]), float(r["pool_depth_usd"]), r["side"],
                      r.get("hour_utc") or 0, r["quote_symbol"])
        if f is None:
            continue
        x_rows.append(f)
        y.append(1 if r["is_victim"] else 0)
        w.append(float(r["sample_weight"]))
        stamps.append(r["created_at"])
        pools.append(r.get("pool_key"))

    positives = int(sum(y))
    status = {
        "rows": len(x_rows),
        "positives": positives,
        "needed": {"rows": MIN_ROWS, "positives": MIN_POSITIVES},
    }
    if len(x_rows) < MIN_ROWS or positives < MIN_POSITIVES:
        if verbose:
            print(f"not enough real data yet: {len(x_rows)} rows, {positives} victims "
                  f"(need {MIN_ROWS} rows and {MIN_POSITIVES} victims). Nothing was written.")
        return {"trained": False, **status}

    x = np.asarray(x_rows, dtype=float)
    y_arr = np.asarray(y, dtype=int)
    w_arr = np.asarray(w, dtype=float)

    # Chronological holdout: searchers change behaviour, and a random split would
    # let the model see the future it is scored on.
    cut = int(len(x) * (1 - HOLDOUT_FRACTION))
    metrics: dict[str, Any] = {"holdout_rows": len(x) - cut, "holdout_positives": int(y_arr[cut:].sum())}
    if 0 < y_arr[cut:].sum() < len(y_arr[cut:]) and 0 < y_arr[:cut].sum():
        mean, scale = _weighted_moments(x[:cut], w_arr[:cut])
        split_model = LogisticRegression(C=1.0, max_iter=2000)
        split_model.fit((x[:cut] - mean) / scale, y_arr[:cut], sample_weight=w_arr[:cut])
        p = split_model.predict_proba((x[cut:] - mean) / scale)[:, 1]
        metrics.update({
            "roc_auc": round(float(roc_auc_score(y_arr[cut:], p, sample_weight=w_arr[cut:])), 4),
            "pr_auc": round(float(average_precision_score(y_arr[cut:], p, sample_weight=w_arr[cut:])), 4),
            "brier": round(float(brier_score_loss(y_arr[cut:], p, sample_weight=w_arr[cut:])), 6),
        })
    else:
        metrics["note"] = "holdout lacks both classes; metrics withheld rather than reported on nothing"

    auc = metrics.get("roc_auc")
    if auc is not None and auc < MIN_HOLDOUT_AUC:
        if verbose:
            print(f"holdout ROC AUC {auc} does not beat a coin flip; the previous model stays.")
        return {"trained": False, **status, "metrics": metrics, "reason": "holdout no better than chance"}

    # The exported model uses everything; the holdout only scores the method.
    mean, scale = _weighted_moments(x, w_arr)
    model = LogisticRegression(C=1.0, max_iter=2000)
    model.fit((x - mean) / scale, y_arr, sample_weight=w_arr)

    # How widely the attacks are spread. Bots work favourite pools in bursts, and
    # a model learned mostly from one pool should not speak for every pool; the
    # server reads these before letting the model set the headline.
    per_pool = Counter(pool for pool, label in zip(pools, y) if label)
    victim_pools = len(per_pool)
    top_pool_share = round(max(per_pool.values()) / positives, 4)

    weighted_swaps = float(w_arr.sum())
    artifact = {
        "kind": "logistic",
        "features": FEATURES,
        "mean": [round(float(v), 8) for v in mean],
        "scale": [round(float(v), 8) for v in scale],
        "coef": [round(float(v), 8) for v in model.coef_[0]],
        "intercept": round(float(model.intercept_[0]), 8),
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_source": "chain",
        "rows": len(x),
        "positives": positives,
        "victim_pools": victim_pools,
        "top_pool_share": top_pool_share,
        "weighted_swaps": round(weighted_swaps),
        "base_rate": round(positives / weighted_swaps, 6) if weighted_swaps else 0.0,
        "window": {"start": stamps[0], "end": stamps[-1]},
        "metrics": metrics,
    }
    ARTIFACT_DIR.mkdir(exist_ok=True)
    MODEL_PATH.write_text(json.dumps(artifact, indent=2), encoding="utf-8")

    try:
        from ..db.repository import record_model_run

        record_model_run({
            "data_source": "chain",
            "rows": len(x),
            "train_rows": cut,
            "test_rows": len(x) - cut,
            "split": "chronological by sample time",
            "metrics": {k: v for k, v in metrics.items() if isinstance(v, (int, float))},
            "features": FEATURES,
        })
    except Exception:
        pass  # recording the run is telemetry; it must not fail training

    if verbose:
        print(f"trained on {len(x):,} real swaps ({positives} victims in {victim_pools} pools, "
              f"top pool {top_pool_share:.0%}; ~{weighted_swaps:,.0f} swaps weighted), "
              f"window {stamps[0][:16]} -> {stamps[-1][:16]}")
        print("holdout:", metrics)
        print("coefficients:", dict(zip(FEATURES, artifact["coef"])))
    return {"trained": True, **status, "victim_pools": victim_pools,
            "top_pool_share": top_pool_share, "metrics": metrics}


if __name__ == "__main__":
    t0 = time.time()
    train()
    print(f"({time.time() - t0:.1f}s)")
