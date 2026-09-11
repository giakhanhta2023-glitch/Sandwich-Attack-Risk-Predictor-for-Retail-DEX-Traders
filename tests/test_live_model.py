"""The model trained on real Solana mainnet flow.

Covers the serving contract (features, artifact validation, attribution), the
trainer-to-server hand-off, and how the headline is built from it: how often
bots reach trades like this (measured) times whether this one pays a bot at the
user's tolerance (AMM arithmetic), with the risk label read from expected loss.
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
        "victim_pools": 40,
        "top_pool_share": 0.12,
        "weighted_swaps": 120000,
        "base_rate": 0.002,
        "window": {"start": "2026-09-09T00:00:00+00:00", "end": "2026-09-10T00:00:00+00:00"},
        "metrics": {"roc_auc": 0.74},
    }
    model.update(overrides)
    return model


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    """No test here may write to the real database, depend on what the live
    scanner happens to have seen, or leak a cached model."""
    from backend.core import pools

    monkeypatch.setattr(repository, "log_analysis", lambda *a, **k: None)
    monkeypatch.setattr(repository, "record_model_run", lambda *a, **k: None)
    monkeypatch.setattr(repository, "hottest_pools", lambda *a, **k: [])
    monkeypatch.setattr(repository, "measured_pool", lambda key: None)
    monkeypatch.setattr(pools, "_measured_cache", None)
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
    """A reference pool from the registry; live pools depend on what the scanner saw."""
    pools = client.get("/api/pools", params={"chain": chain}).json()["pools"]
    return next(p["pool_id"] for p in pools if not p.get("live"))


def _thinnest_solana_pool(client):
    pools = [p for p in client.get("/api/pools", params={"chain": "solana"}).json()["pools"] if not p.get("live")]
    return min(pools, key=lambda p: p["tvl_usd"])["pool_id"]


def _analyze(client, pool_id, notional=25_000, slippage_bps=100):
    res = client.post(
        "/api/analyze",
        json={"pool_id": pool_id, "notional_usd": notional, "slippage_bps": slippage_bps, "hour_of_day": 14},
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


def test_time_of_day_waits_for_a_full_day_of_data(serve):
    """One evening of data must not decide what any hour looks like."""
    serve(_artifact(coef=[0.2, -0.1, 0.9, 0.1, 0.0, 0.0, 0.0], hours_seen=[21, 22, 23]))
    no_time_effect = live_model.predict(1_000, 20_000, "buy", 14, "SOL")

    serve(_artifact(coef=[0.2, -0.1, 0.9, 0.1, 3.0, -3.0, 0.0], hours_seen=[21, 22, 23]))
    for hour in (14, 22):  # neither an hour it never saw nor one it did
        assert live_model.predict(1_000, 20_000, "buy", hour, "SOL") == pytest.approx(no_time_effect)
    assert "full day" in next(f["label"] for f in live_model.card()["features"] if f["feature"] == "hour")

    # once the whole day is covered, what it learned about the hour applies
    serve(_artifact(coef=[0.2, -0.1, 0.9, 0.1, 3.0, -3.0, 0.0], hours_seen=list(range(24))))
    assert live_model.predict(1_000, 20_000, "buy", 22, "SOL") != pytest.approx(no_time_effect)


def test_inputs_far_outside_real_flow_are_clipped(serve):
    """A linear model extrapolates without limit; nothing in the sample says what happens out there."""
    serve(_artifact())
    assert live_model.predict(10**9, 1_000) == pytest.approx(live_model.predict(10**12, 1_000))


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
            "pool_key": f"pool-{rng.randrange(40)}",
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
    info = live_model.info()
    assert info["positives"] == result["positives"]
    assert info["victim_pools"] == result["victim_pools"] > 1
    assert 0 < info["top_pool_share"] <= 1
    assert live_model.predict(5_000, 20_000) > live_model.predict(20, 5_000_000)


def test_the_trainer_declines_without_enough_real_victims(tmp_path, monkeypatch):
    pytest.importorskip("sklearn")
    from backend.ml import train_live

    path = tmp_path / "live_model.json"
    monkeypatch.setattr(train_live, "fetch_samples", lambda: _synthetic_flow(n=100))
    monkeypatch.setattr(train_live, "MODEL_PATH", path)

    assert train_live.train(verbose=False)["trained"] is False
    assert not path.exists()


def test_a_retrain_that_cannot_beat_a_coin_flip_keeps_the_previous_model(tmp_path, monkeypatch):
    """The live model sets the headline unattended, so a bad retrain must not ship."""
    pytest.importorskip("sklearn")
    from backend.ml import train_live

    path = tmp_path / "live_model.json"
    path.write_text("previous model", encoding="utf-8")
    monkeypatch.setattr(train_live, "fetch_samples", _synthetic_flow)
    monkeypatch.setattr(train_live, "MODEL_PATH", path)
    monkeypatch.setattr(train_live, "roc_auc_score", lambda *a, **k: 0.41)

    result = train_live.train(verbose=False)
    assert result["trained"] is False
    assert path.read_text(encoding="utf-8") == "previous model"


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


# --- how the headline is built ---------------------------------------------


def test_an_established_live_model_sets_the_solana_headline(serve, client):
    serve(_artifact())
    body = _analyze(client, _pool_id(client, "solana"))
    risk, live = body["risk"], body["risk"]["live_market"]

    assert risk["source"] == "live-mainnet"
    # how often bots reach trades like this, times whether this one pays at the tolerance
    assert risk["searcher_presence"] == pytest.approx(live["p_attack"], abs=1e-4)
    assert risk["p_attack"] == pytest.approx(live["p_attack"] * risk["p_worth_attacking"], abs=2e-6)
    assert live["early"] is False and live["caveats"] == []
    assert "simulated_p_attack" in risk
    # the explanation describes the number shown, not the formula's
    assert {d["feature"] for d in risk["drivers"]} <= LIVE_GROUPS


@pytest.mark.parametrize(
    "overrides, shortfall",
    [
        ({"positives": 40}, "40 of 100 real victims"),
        ({"metrics": {"roc_auc": 0.52}}, "(has 0.52)"),
        ({"metrics": {}}, "not yet measurable"),
        # bots work favourite pools in bursts, so the spread is reported too
        ({"victim_pools": 8}, "20 pools (has 8)"),
        ({"top_pool_share": 0.5}, "top has 50%"),
        # an artifact from before spread was recorded counts as concentrated
        ({"victim_pools": None, "top_pool_share": None}, "20 pools (has 0)"),
    ],
)
def test_an_early_live_model_still_sets_the_headline_and_says_what_it_lacks(serve, client, overrides, shortfall):
    serve(_artifact(**overrides))
    body = _analyze(client, _pool_id(client, "solana"))
    risk, live = body["risk"], body["risk"]["live_market"]

    assert risk["source"] == "live-mainnet"
    assert risk["p_attack"] == pytest.approx(live["p_attack"] * risk["p_worth_attacking"], abs=2e-6)
    assert live["early"] is True
    assert any(shortfall in c for c in live["caveats"])


def test_your_slippage_moves_the_chance(serve, client):
    """A tolerance too tight to pay a bot takes the chance to zero; a wide one does not."""
    serve(_artifact())
    tight = _analyze(client, "ray-bonk-sol", 8_000, 5)["risk"]
    wide = _analyze(client, "ray-bonk-sol", 8_000, 300)["risk"]

    assert tight["p_worth_attacking"] == 0 and tight["p_attack"] == 0
    assert wide["p_worth_attacking"] > 0.95
    assert wide["p_attack"] == pytest.approx(wide["live_market"]["p_attack"], rel=0.05)


def test_the_label_follows_the_money_not_just_the_chance(serve, client):
    """A trade that pays a bot thousands is severe even if bots reach few such trades."""
    serve(_artifact())
    juicy = _analyze(client, _thinnest_solana_pool(client), 100_000, 500)
    assert juicy["economics"]["attack_is_profitable"]
    assert juicy["risk"]["risk_band"] in {"high", "severe"}
    assert juicy["risk"]["expected_loss_bps"] == pytest.approx(
        juicy["risk"]["p_attack"] * juicy["risk"]["expected_loss_bps_if_attacked"], rel=1e-3)

    assert _analyze(client, "ray-bonk-sol", 8_000, 5)["risk"]["risk_band"] == "minimal"


def test_loss_bands():
    from backend.app.main import loss_band

    assert [loss_band(b) for b in (0.1, 1, 5, 20, 80)] == ["minimal", "low", "elevated", "high", "severe"]


def test_the_solana_model_never_scores_ethereum(serve, client):
    serve(_artifact())
    body = _analyze(client, _pool_id(client, "ethereum"))
    assert body["risk"]["live_market"] is None
    assert body["risk"]["source"] != "live-mainnet"


def test_without_a_live_model_the_formula_is_labelled_as_such(serve, client):
    serve(None)
    body = _analyze(client, _pool_id(client, "solana"))
    assert body["risk"]["live_market"] is None
    assert body["risk"]["source"] in {"trained", "fallback"}


def test_the_model_card_describes_the_live_model(serve, client):
    serve(_artifact())
    res = client.get("/api/model")
    if res.status_code == 404:
        pytest.skip("no simulator report in this checkout")
    card = res.json()["live_model"]
    assert card["positives"] == 250 and card["victim_pools"] == 40
    # the two hour terms appear once, as time of day
    assert {f["feature"] for f in card["features"]} == LIVE_GROUPS
    weights = [abs(f["weight"]) for f in card["features"]]
    assert weights == sorted(weights, reverse=True)


# --- real pools --------------------------------------------------------------

HOT_ROW = {
    "pool_key": "VaultA:VaultB", "base_mint": "4eFdaQK59uDMqQ2mZifiRwYcYt8Yi27zKgRg7fpSpump",
    "quote_mint": "So11111111111111111111111111111111111111112", "quote_symbol": "SOL",
    "swaps": 217, "sandwiches": 22, "victims": 113, "victim_rate": 0.52074,
    "quote_volume": 217.0, "est_tvl_usd": 19800,
}


@pytest.fixture
def hot_pool(monkeypatch):
    """One real pool where half the trades this week were caught in a sandwich."""
    monkeypatch.setattr(repository, "hottest_pools", lambda *a, **k: [HOT_ROW])
    monkeypatch.setattr(repository, "measured_pool", lambda key: HOT_ROW if key == HOT_ROW["pool_key"] else None)
    monkeypatch.setattr(repository, "latest_sol_usd", lambda: 100.0)
    return "live:VaultA:VaultB"


def test_real_pools_lead_the_list_with_what_was_measured(hot_pool, client):
    first = client.get("/api/pools", params={"chain": "solana"}).json()["pools"][0]
    assert first["pool_id"] == hot_pool and first["live"] is True
    assert first["measured"]["victims"] == 113 and first["measured"]["swaps"] == 217
    assert first["measured"]["avg_trade_usd"] == pytest.approx(100.0)
    assert first["historical_attack_rate"] == pytest.approx(113 / 217, abs=1e-4)


def test_a_real_pool_sets_the_level_and_the_model_only_adjusts_for_size(serve, hot_pool, client):
    serve(_artifact())
    at_average = _analyze(client, hot_pool, 100, 300)["risk"]["live_market"]
    # at the pool's own average trade the chance is its measured rate, shrunk toward the model
    assert at_average["p_attack"] == pytest.approx(at_average["pool_rate"], rel=1e-3)
    assert 0.3 < at_average["pool_rate"] < 113 / 217
    bigger = _analyze(client, hot_pool, 2_000, 300)["risk"]["live_market"]
    smaller = _analyze(client, hot_pool, 20, 300)["risk"]["live_market"]
    assert smaller["p_attack"] < at_average["p_attack"] < bigger["p_attack"] <= 0.95


def test_a_real_pool_off_the_top_list_still_resolves(serve, hot_pool, monkeypatch, client):
    serve(_artifact())
    monkeypatch.setattr(repository, "hottest_pools", lambda *a, **k: [])
    assert _analyze(client, hot_pool, 100, 300)["risk"]["live_market"]["pool_measured"]["victims"] == 113


def test_an_unknown_real_pool_is_not_found(hot_pool, client):
    res = client.post("/api/analyze", json={"pool_id": "live:nope", "notional_usd": 100, "slippage_bps": 50})
    assert res.status_code == 404


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
