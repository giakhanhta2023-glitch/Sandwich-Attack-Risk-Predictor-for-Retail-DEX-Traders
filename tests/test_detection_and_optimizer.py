"""Detector accuracy, optimiser behaviour, and API consistency."""

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.core.features import FEATURE_COLUMNS, build_features, to_vector
from backend.core.optimizer import (
    TradeContext,
    attack_probability,
    cost_curve,
    evaluate_split,
    find_sweet_spot,
    optimal_split,
    revert_probability,
)
from backend.detection.sandwich import Swap, aggregate_pool_risk, detect_sandwiches
from backend.ingestion.synthetic import generate_swap_stream


# ------------------------------------------------------------------ detector

@pytest.fixture(scope="module")
def stream():
    return generate_swap_stream(n_blocks=120, seed=11)


def test_detector_recovers_known_sandwiches(stream):
    """Scored against ground truth from the simulator.

    This exercises the same code path that labels live Helius and BigQuery
    data. It proves the pattern matching and loss reconstruction are correct on
    clean input -- it does not prove robustness to real-world noise such as
    aggregator hops or multi-pool routes.
    """
    swaps, truth = stream
    events = detect_sandwiches(swaps, price_usd={"A": 1.0})
    found = {e.victim_tx for e in events}

    tp = len(found & truth)
    precision = tp / len(found) if found else 0.0
    recall = tp / len(truth) if truth else 0.0

    assert precision >= 0.99, f"precision {precision}"
    assert recall >= 0.99, f"recall {recall}"


def test_detector_ignores_ordinary_round_trips():
    """One trader buying and selling in a block is not an attack without a victim."""
    swaps = [
        Swap("ethereum", 1, 0, "0xa", "pool", "0xTRADER", "A", "B", 10, 100),
        Swap("ethereum", 1, 1, "0xb", "pool", "0xTRADER", "B", "A", 100, 10),
    ]
    assert detect_sandwiches(swaps) == []


def test_detector_requires_the_backrun_to_unwind_the_position():
    """A back-run of an unrelated size is a different trade, not the other slice."""
    swaps = [
        Swap("ethereum", 1, 0, "0xf", "pool", "0xATK", "A", "B", 10, 100),
        Swap("ethereum", 1, 1, "0xv", "pool", "0xVICTIM", "A", "B", 5, 45),
        Swap("ethereum", 1, 2, "0xb", "pool", "0xATK", "B", "A", 900, 12),
    ]
    assert detect_sandwiches(swaps) == []


def test_aggregate_pool_risk_counts_both_sides(stream):
    swaps, _ = stream
    events = detect_sandwiches(swaps, price_usd={"A": 1.0})
    stats = aggregate_pool_risk(swaps, events)
    assert stats
    for st in stats.values():
        assert st.swaps > 0
        assert 0.0 <= st.attack_rate <= 1.0


# ----------------------------------------------------------------- optimiser

@pytest.fixture
def ctx():
    return TradeContext(
        notional_usd=25_000,
        pool_tvl_usd=8_500_000,
        price_in_usd=3000.0,
        fee_bps=30,
        volatility_24h=0.13,
        bot_activity=0.7,
    )


def test_sweet_spot_is_the_curve_minimum(ctx):
    spot = find_sweet_spot(ctx)
    curve = cost_curve(ctx)
    best = min(p.expected_cost_usd for p in curve)
    assert spot.expected_cost_usd == pytest.approx(best, rel=1e-9)


def test_attack_probability_rises_with_tolerance(ctx):
    probs = [attack_probability(ctx, s) for s in (0.0005, 0.005, 0.05)]
    assert probs[0] <= probs[1] <= probs[2]


def test_revert_probability_falls_with_tolerance(ctx):
    assert revert_probability(ctx, 0.0005) > revert_probability(ctx, 0.05)


def test_private_relay_collapses_attack_risk(ctx):
    public = attack_probability(ctx, 0.03)
    private = attack_probability(
        TradeContext(**{**ctx.__dict__, "private_relay": True}), 0.03
    )
    assert private < public / 10


def test_splitting_reduces_per_chunk_attacker_profit(ctx):
    one = evaluate_split(ctx, 1)
    five = evaluate_split(ctx, 5)
    assert five.attacker_profit_per_chunk_usd < one.attacker_profit_per_chunk_usd


def test_splitting_charges_for_gas_and_time(ctx):
    """Splitting must not look free, or the optimiser would always shard."""
    plan = evaluate_split(ctx, 6)
    assert plan.gas_overhead_usd > 0
    assert plan.timing_risk_usd > 0
    assert plan.total_duration_s > ctx.exposure_seconds


def test_optimal_split_is_the_cheapest_plan(ctx):
    best, plans = optimal_split(ctx, max_chunks=6)
    assert best.expected_cost_usd == pytest.approx(min(p.expected_cost_usd for p in plans))


def test_tiny_trade_in_a_deep_pool_is_not_flagged():
    safe = TradeContext(
        notional_usd=250, pool_tvl_usd=180_000_000, price_in_usd=3000.0,
        fee_bps=30, volatility_24h=0.035, bot_activity=0.9,
    )
    assert attack_probability(safe, 0.005) < 0.05


# ------------------------------------------------------------------ features

def test_feature_vector_is_complete_and_ordered():
    feats = build_features(notional_usd=10_000, pool_tvl_usd=5_000_000, slippage_bps=100)
    assert set(feats) == set(FEATURE_COLUMNS)
    assert len(to_vector(feats)) == len(FEATURE_COLUMNS)
    assert all(isinstance(v, float) for v in to_vector(feats))


def test_features_encode_the_economics():
    """Wider tolerance must show up as a larger front-run budget."""
    tight = build_features(notional_usd=50_000, pool_tvl_usd=5_000_000, slippage_bps=10)
    wide = build_features(notional_usd=50_000, pool_tvl_usd=5_000_000, slippage_bps=500)
    assert wide["frontrun_capacity_usd"] > tight["frontrun_capacity_usd"]
    assert wide["attacker_profit_usd"] > tight["attacker_profit_usd"]


# ----------------------------------------------------------------------- API

@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert "solana" in body["sources"] and "ethereum" in body["sources"]


def test_pools_are_listed(client):
    body = client.get("/api/pools").json()
    assert body["count"] > 0
    assert {"pool_id", "chain", "tvl_usd", "fee_bps"} <= set(body["pools"][0])


def test_analyze_is_internally_consistent(client):
    body = client.post(
        "/api/analyze",
        json={"pool_id": "uni-v2-pepe-weth", "notional_usd": 25_000, "slippage_bps": 300},
    ).json()

    # the recommendation must actually be the cheapest point offered
    curve = body["sweet_spot"]["curve"]
    cheapest = min(p["expected_cost_usd"] for p in curve)
    # the API rounds money to cents, so compare at that resolution
    assert body["sweet_spot"]["expected_cost_usd"] == pytest.approx(cheapest, abs=0.01)

    # and the quoted saving must equal the difference it claims
    delta = body["current_setting"]["expected_cost_usd"] - body["sweet_spot"]["expected_cost_usd"]
    assert body["sweet_spot"]["savings_vs_current_usd"] == pytest.approx(delta, abs=0.02)

    assert 0.0 <= body["risk"]["p_attack"] <= 1.0
    assert body["recommendations"]


def test_analyze_rejects_unknown_pool(client):
    res = client.post(
        "/api/analyze", json={"pool_id": "nope", "notional_usd": 100, "slippage_bps": 50}
    )
    assert res.status_code == 404


def test_simulate_walks_the_three_legs(client):
    body = client.post(
        "/api/simulate",
        json={"pool_id": "uni-v2-pepe-weth", "notional_usd": 25_000, "slippage_bps": 300},
    ).json()
    actors = [s["actor"] for s in body["steps"]]
    assert actors == ["market", "attacker", "victim", "attacker"]


def test_live_solana_reports_missing_credentials(client):
    """Without a key the endpoint must say so, not fall back to simulated data."""
    res = client.get("/api/live/solana", params={"pool_address": "abc"})
    assert res.status_code == 503
    assert "HELIUS_API_KEY" in res.json()["detail"]
