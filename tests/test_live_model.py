"""The model trained on real Solana mainnet flow.

Covers the serving contract (features, artifact validation, attribution), the
trainer-to-server hand-off, and the rule for when the live model takes the
headline probability over from the simulator.
"""

import json
import math
import random

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.db import repository
from backend.ml import live_model

LIVE_GROUPS = {"trade_size", "pool_depth", "size_to_depth", "direction", "hour", "quote"}


def _artifact(**overrides):
    model = {
        "kind": "logistic",
        "features": list(live_model.FEATURES),
        "mean": [3.0, 5.5, -2.5, 0.5, 0.0, 0.0, 0.8],
        "scale": [1.0, 1.0, 1.0, 0.5, 0.7, 0.7, 0.4],
        # risk rises with the trade's share of the pool, as the economics say it should
        "coef": [0.2, -0.1, 0.9, 0.1, 0.05, -0.05, 0.0],
        "intercept": -4.0,
        "trained_at": "2026-09-10T00:00:00+00:00",
        "rows": 5000,
        "positives": 250,
        "weighted_swaps": 120000,
        "base_rate": 0.002,
        "window": {"start": "2026-09-09T00:00:00+00:00", "end": "2026-09-10T00:00:00+00:00"},
        "metrics": {"roc_auc": 0.74},
    }
    model.update(overrides)
    return model


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    """No test here may write to the real database or leak a cached model."""
    monkeypatch.setattr(repository, "log_analysis", lambda *a, **k: None)
    monkeypatch.setattr(repository, "record_model_run", lambda *a, **k: None)
    live_model.load.cache_clear()
    yield
    live_model.load.cache_clear()


@pytest.fixture
def serve(tmp_path, monkeypatch):
    """Serve a given artifact -- or none at all -- for one test."""

    def _serve(model):
        path = tmp_path / "live_model.json"
        if model is not None:
            path.write_text(json.dumps(model), encoding="utf-8")
        monkeypatch.setattr(live_model, "MODEL_PATH", path)
        live_model.load.cache_clear()

    return _serve


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _pool_id(client, chain):
    return client.get("/api/pools", params={"chain": chain}).json()["pools"][0]["pool_id"]


def _analyze(client, pool_id):
    res = client.post(
        "/api/analyze",
        json={"pool_id": pool_id, "notional_usd": 25_000, "slippage_bps": 100, "hour_of_day": 14},
    )
    assert res.status_code == 200, res.text
    return res.json()


# --- serving contract ------------------------------------------------------


def test_features_reject_unusable_swaps():
    assert live_model.featurize(0, 1_000) is None
    assert live_model.featurize(100, 0) is None
    assert len(live_model.featurize(100, 1_000)) == len(live_model.FEATURES)


def test_score_at_the_population_mean_is_the_intercept(serve):
    x = live_model.featurize(2_000, 80_000, "buy", 6, "SOL")
    serve(_artifact(mean=x))
    assert live_model.predict(2_000, 80_000, "buy", 6, "SOL") == pytest.approx(1 / (1 + math.exp(4.0)))


def test_a_bigger_share_of_the_pool_scores_higher(serve):
    serve(_artifact())
    assert live_model.predict(20_000, 50_000) > live_model.predict(200, 50_000)


def test_an_artifact_from_another_feature_set_is_ignored(serve):
    serve(_artifact(features=list(reversed(live_model.FEATURES))))
    assert live_model.load() is None
    assert live_model.predict(1_000, 50_000) is None
    assert live_model.info() is None


def test_no_artifact_means_no_live_model(serve):
    serve(None)
    assert live_model.predict(1_000, 50_000) is None
    assert live_model.explain(1_000, 50_000) == []


def test_attribution_reports_time_of_day_once_and_ranks_by_effect(serve):
    serve(_artifact())
    drivers = live_model.explain(20_000, 50_000, "buy", 3, "SOL")
    keys = [d["feature"] for d in drivers]
    assert len(keys) == len(set(keys)) and set(keys) <= LIVE_GROUPS
    effects = [abs(d["delta"]) for d in drivers]
    assert effects == sorted(effects, reverse=True)
    assert keys[0] == "size_to_depth"


# --- trainer to server -----------------------------------------------------


def _synthetic_flow(n=600, seed=7):
    """Swaps whose chance of being sandwiched rises with their share of the pool."""
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        size, depth = 10 ** rng.uniform(1, 5), 10 ** rng.uniform(4, 7)
        victim = rng.random() < min(0.9, 20 * size / depth)
        rows.append({
            "quote_usd": size, "pool_depth_usd": depth, "side": rng.choice(["buy", "sell"]),
            "hour_utc": rng.randrange(24), "quote_symbol": rng.choice(["SOL", "USDC"]),
            "is_victim": victim, "sample_weight": 1 if victim else 50,
            "created_at": f"2026-09-10T{i // 60:02d}:{i % 60:02d}:00+00:00",
        })
    return rows


def test_what_the_trainer_writes_is_what_the_server_reads(tmp_path, monkeypatch):
    pytest.importorskip("sklearn")
    from backend.ml import train_live

    path = tmp_path / "live_model.json"
    monkeypatch.setattr(train_live, "fetch_samples", _synthetic_flow)
    monkeypatch.setattr(train_live, "ARTIFACT_DIR", tmp_path)
    monkeypatch.setattr(train_live, "MODEL_PATH", path)
    monkeypatch.setattr(live_model, "MODEL_PATH", path)

    result = train_live.train(verbose=False)
    assert result["trained"]
    assert "roc_auc" in result["metrics"]

    live_model.load.cache_clear()
    assert live_model.info()["positives"] == result["positives"]
    assert live_model.predict(5_000, 20_000) > live_model.predict(20, 5_000_000)


def test_the_trainer_declines_without_enough_real_victims(tmp_path, monkeypatch):
    pytest.importorskip("sklearn")
    from backend.ml import train_live

    path = tmp_path / "live_model.json"
    monkeypatch.setattr(train_live, "fetch_samples", lambda: _synthetic_flow(n=100))
    monkeypatch.setattr(train_live, "MODEL_PATH", path)

    assert train_live.train(verbose=False)["trained"] is False
    assert not path.exists()


def test_a_feature_that_never_varied_cannot_swing_a_prediction(tmp_path, monkeypatch):
    """The first real sample spanned one hour, so time of day must carry no weight."""
    pytest.importorskip("sklearn")
    from backend.ml import train_live

    rows = [dict(r, hour_utc=21) for r in _synthetic_flow()]
    path = tmp_path / "live_model.json"
    monkeypatch.setattr(train_live, "fetch_samples", lambda: rows)
    monkeypatch.setattr(train_live, "ARTIFACT_DIR", tmp_path)
    monkeypatch.setattr(train_live, "MODEL_PATH", path)
    monkeypatch.setattr(live_model, "MODEL_PATH", path)

    assert train_live.train(verbose=False)["trained"]
    live_model.load.cache_clear()
    at_training_hour = live_model.predict(5_000, 50_000, "buy", 21, "SOL")
    assert live_model.predict(5_000, 50_000, "buy", 9, "SOL") == pytest.approx(at_training_hour, rel=1e-6)


# --- who sets the headline -------------------------------------------------


def test_an_established_live_model_sets_the_solana_headline(serve, client):
    serve(_artifact())
    body = _analyze(client, _pool_id(client, "solana"))
    risk, live = body["risk"], body["risk"]["live_market"]

    assert live["drives_headline"] is True and live["why_provisional"] is None
    assert risk["source"] == "live-mainnet"
    assert risk["p_attack"] == pytest.approx(live["p_attack"])
    assert "simulated_p_attack" in risk
    # the explanation describes the number shown, not the simulator's
    assert {d["feature"] for d in risk["drivers"]} <= LIVE_GROUPS


@pytest.mark.parametrize(
    "overrides, shortfall",
    [({"positives": 40}, "40 victims"), ({"metrics": {"roc_auc": 0.52}}, "AUC 0.52"), ({"metrics": {}}, "not yet")],
)
def test_an_unproven_live_model_is_shown_but_does_not_decide(serve, client, overrides, shortfall):
    serve(_artifact(**overrides))
    body = _analyze(client, _pool_id(client, "solana"))
    live = body["risk"]["live_market"]

    assert live["drives_headline"] is False
    assert shortfall in live["why_provisional"]
    assert body["risk"]["source"] != "live-mainnet"
    assert "simulated_p_attack" not in body["risk"]


def test_the_solana_model_never_scores_ethereum(serve, client):
    serve(_artifact())
    body = _analyze(client, _pool_id(client, "ethereum"))
    assert body["risk"]["live_market"] is None
    assert body["risk"]["source"] != "live-mainnet"


def test_without_a_live_model_the_simulator_stays_in_charge(serve, client):
    serve(None)
    body = _analyze(client, _pool_id(client, "solana"))
    assert body["risk"]["live_market"] is None
    assert body["risk"]["source"] in {"trained", "fallback"}


# --- measured corpus -------------------------------------------------------


def test_the_corpus_switches_to_chain_data_without_a_restart(monkeypatch):
    from types import SimpleNamespace

    from backend.core import pools

    clock = SimpleNamespace(now=1_000.0)
    answers = [None, {"available": True, "data_source": "chain"}]
    monkeypatch.setattr(pools, "time", SimpleNamespace(monotonic=lambda: clock.now))
    monkeypatch.setattr(pools, "_chain_corpus_stats", lambda: answers.pop(0))
    monkeypatch.setattr(pools, "_measured", None)

    assert pools.corpus_stats()["data_source"] != "chain"  # too little live data yet
    clock.now += 60
    assert pools.corpus_stats()["data_source"] != "chain"  # cached: no query per request
    clock.now += pools.MEASURED_TTL_SECONDS
    assert pools.corpus_stats()["data_source"] == "chain"  # re-read, no restart needed
    assert answers == []
