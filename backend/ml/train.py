"""Training pipeline.

Two models, because "will I get sandwiched" and "how badly" are different
questions with different conditioning:

  * a calibrated gradient-boosted classifier for P(sandwich)
  * a gradient-boosted regressor for realised loss in bps, fit only on the
    trades that were actually sandwiched

Calibration is not optional here. The sweet-spot solver multiplies P(attack) by
a dollar loss, so a model that ranks well but is systematically overconfident
produces a confidently wrong slippage recommendation. The classifier is wrapped
in isotonic calibration and the Brier score and reliability curve are reported
alongside AUC.

The split is chronological, not random. Blocks are ordered, searcher behaviour
drifts, and a random split would leak future regimes into the training set and
flatter the metrics.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from joblib import dump
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    mean_absolute_error,
    roc_auc_score,
)

from ..app.config import ARTIFACT_DIR, DATA_DIR
from ..core.features import FEATURE_COLUMNS
from ..ingestion.synthetic import generate_trades, trades_to_rows

TRAIN_FRACTION = 0.7


def build_frame(n_blocks: int = 4000, seed: int = 7) -> pd.DataFrame:
    trades = generate_trades(n_blocks=n_blocks, seed=seed)
    return pd.DataFrame(trades_to_rows(trades))


def _add_pool_prior(train: pd.DataFrame, test: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, float]]:
    """Per-pool historical attack rate, fit on train and applied to both.

    This is the leakiest feature in the set if handled carelessly: computing it
    over the full frame would let each row see its own label. It is computed on
    the training split only, smoothed toward the global rate so thin pools do
    not get overconfident priors, and unseen pools fall back to the global mean.
    """
    global_rate = float(train["label_sandwiched"].mean())
    grouped = train.groupby("pool_id")["label_sandwiched"].agg(["sum", "count"])
    smoothing = 50.0  # pseudo-counts: a pool needs real volume to move its prior
    prior = (grouped["sum"] + smoothing * global_rate) / (grouped["count"] + smoothing)
    lookup = prior.to_dict()

    train = train.copy()
    test = test.copy()
    train["pool_attack_rate_prior"] = train["pool_id"].map(lookup).fillna(global_rate)
    test["pool_attack_rate_prior"] = test["pool_id"].map(lookup).fillna(global_rate)
    return train, test, {"global_rate": global_rate, **{k: float(v) for k, v in lookup.items()}}


def _reliability_curve(y_true: np.ndarray, y_prob: np.ndarray, bins: int = 10) -> list[dict[str, float]]:
    """Predicted vs observed frequency: the honest picture of calibration."""
    edges = np.linspace(0.0, 1.0, bins + 1)
    out: list[dict[str, float]] = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (y_prob >= lo) & (y_prob < hi if hi < 1.0 else y_prob <= hi)
        if mask.sum() < 10:
            continue
        out.append({
            "bin_lower": round(float(lo), 3),
            "bin_upper": round(float(hi), 3),
            "predicted": round(float(y_prob[mask].mean()), 4),
            "observed": round(float(y_true[mask].mean()), 4),
            "count": int(mask.sum()),
        })
    return out


def train(n_blocks: int = 4000, seed: int = 7, verbose: bool = True) -> dict[str, Any]:
    started = time.time()
    frame = build_frame(n_blocks=n_blocks, seed=seed)

    # chronological split: no future blocks in the training set
    cutoff = frame["block"].quantile(TRAIN_FRACTION)
    train_df = frame[frame["block"] <= cutoff]
    test_df = frame[frame["block"] > cutoff]
    train_df, test_df, pool_priors = _add_pool_prior(train_df, test_df)

    x_train = train_df[FEATURE_COLUMNS].to_numpy(dtype=float)
    y_train = train_df["label_sandwiched"].to_numpy(dtype=int)
    x_test = test_df[FEATURE_COLUMNS].to_numpy(dtype=float)
    y_test = test_df["label_sandwiched"].to_numpy(dtype=int)

    if verbose:
        print(f"rows: {len(frame):,}  train: {len(train_df):,}  test: {len(test_df):,}")
        print(f"attack rate: train {y_train.mean():.4f}  test {y_test.mean():.4f}")

    # --- classifier ---------------------------------------------------
    base = HistGradientBoostingClassifier(
        max_iter=400,
        learning_rate=0.06,
        max_depth=6,
        min_samples_leaf=40,
        l2_regularization=1.0,
        early_stopping=True,
        validation_fraction=0.15,
        random_state=seed,
    )
    clf = CalibratedClassifierCV(base, method="isotonic", cv=4)
    clf.fit(x_train, y_train)

    prob = clf.predict_proba(x_test)[:, 1]
    metrics = {
        "roc_auc": round(float(roc_auc_score(y_test, prob)), 4),
        "pr_auc": round(float(average_precision_score(y_test, prob)), 4),
        "brier": round(float(brier_score_loss(y_test, prob)), 5),
        "base_rate": round(float(y_test.mean()), 4),
        "reliability": _reliability_curve(y_test, prob),
    }

    # --- severity regressor, conditional on being attacked -------------
    hit_train = train_df[train_df["label_sandwiched"] == 1]
    hit_test = test_df[test_df["label_sandwiched"] == 1]
    reg = HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.06, max_depth=6,
        min_samples_leaf=20, random_state=seed,
    )
    reg.fit(hit_train[FEATURE_COLUMNS].to_numpy(dtype=float),
            hit_train["label_loss_bps"].to_numpy(dtype=float))
    loss_pred = reg.predict(hit_test[FEATURE_COLUMNS].to_numpy(dtype=float))
    metrics["loss_mae_bps"] = round(
        float(mean_absolute_error(hit_test["label_loss_bps"].to_numpy(dtype=float), loss_pred)), 2
    )
    metrics["loss_median_bps"] = round(float(hit_test["label_loss_bps"].median()), 2)

    # --- what the model is actually leaning on -------------------------
    sample = min(4000, len(x_test))
    idx = np.random.RandomState(seed).choice(len(x_test), size=sample, replace=False)
    imp = permutation_importance(
        clf, x_test[idx], y_test[idx], n_repeats=5,
        random_state=seed, scoring="average_precision",
    )
    importance = sorted(
        (
            {"feature": f, "importance": round(float(m), 5), "std": round(float(s), 5)}
            for f, m, s in zip(FEATURE_COLUMNS, imp.importances_mean, imp.importances_std)
        ),
        key=lambda d: d["importance"],
        reverse=True,
    )

    # --- persist -------------------------------------------------------
    ARTIFACT_DIR.mkdir(exist_ok=True)
    dump(clf, ARTIFACT_DIR / "sandwich_classifier.joblib")
    dump(reg, ARTIFACT_DIR / "loss_regressor.joblib")

    # Medians for the predictor's ablation attribution. Precomputed here so the
    # serving path never opens the corpus: that is what lets pandas/pyarrow
    # stay out of the deployed function.
    feature_medians = {c: float(frame[c].median()) for c in FEATURE_COLUMNS}

    report = {
        "trained_at": int(time.time()),
        "training_seconds": round(time.time() - started, 1),
        "data_source": "simulated",
        "rows": int(len(frame)),
        "train_rows": int(len(train_df)),
        "test_rows": int(len(test_df)),
        "split": "chronological by block",
        "features": FEATURE_COLUMNS,
        "metrics": metrics,
        "feature_importance": importance,
        "feature_medians": feature_medians,
        "pool_priors": pool_priors,
    }
    (ARTIFACT_DIR / "model_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    # Also record the run in the database when one is configured, so metrics are
    # a time series instead of a file that each run overwrites.
    try:
        from ..db.repository import record_model_run

        run_id = record_model_run(report)
        if run_id and verbose:
            print(f"recorded model run {run_id}")
    except Exception as exc:  # never fail a training run over telemetry
        if verbose:
            print(f"model run not recorded: {exc}")

    # Precomputed dashboard aggregates: a few KB that deploy anywhere, versus a
    # 13MB parquet that would need pyarrow at runtime to read.
    from ..core.pools import aggregate_corpus

    summary = aggregate_corpus(frame)
    (ARTIFACT_DIR / "corpus_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    # the full frame stays for local analysis, and is not deployed
    DATA_DIR.mkdir(exist_ok=True)
    frame.to_parquet(DATA_DIR / "training_frame.parquet", index=False)

    if verbose:
        print(f"ROC AUC {metrics['roc_auc']}  PR AUC {metrics['pr_auc']}  Brier {metrics['brier']}")
        print(f"loss MAE {metrics['loss_mae_bps']}bp (median loss {metrics['loss_median_bps']}bp)")
        print("top features: " + ", ".join(d["feature"] for d in importance[:6]))
    return report


if __name__ == "__main__":
    train()
