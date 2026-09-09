"""Invariants of the sandwich economics.

These are the properties the rest of the system leans on. If one of them
breaks, every risk number and every recommendation downstream is wrong, so they
are asserted directly rather than inferred from an end-to-end result.
"""

import math

import pytest

from backend.core.amm import (
    critical_slippage,
    frontrun_capacity,
    optimal_sandwich,
    price_impact_bps,
    reserves_from_tvl,
    simulate_sandwich,
    swap_out,
    unconstrained_frontrun,
)

GAMMA = 0.997


@pytest.fixture
def pool():
    """A 2M TVL pool with ETH at $3,000."""
    return reserves_from_tvl(2_000_000, 3000.0, 1.0)


# ---------------------------------------------------------------- primitives

def test_swap_output_is_monotonic_and_concave(pool):
    r_in, r_out = pool
    outs = [swap_out(a, r_in, r_out, GAMMA) for a in (1, 2, 4, 8, 16)]
    assert all(b > a for a, b in zip(outs, outs[1:])), "more in must mean more out"
    # concavity: each doubling returns less than double
    assert outs[1] < 2 * outs[0]
    assert outs[2] < 2 * outs[1]


def test_swap_never_drains_the_pool(pool):
    r_in, r_out = pool
    assert swap_out(1e12, r_in, r_out, GAMMA) < r_out


def test_price_impact_rises_with_size(pool):
    r_in, r_out = pool
    assert price_impact_bps(1, *pool, GAMMA) < price_impact_bps(10, *pool, GAMMA)


# ------------------------------------------------------- front-run capacity

@pytest.mark.parametrize("s", [0.001, 0.005, 0.01, 0.03, 0.10])
def test_capacity_lands_exactly_on_the_tolerance(pool, s):
    """The capacity root must place the victim exactly at their minAmountOut.

    This is the load-bearing equation: it is what a searcher solves for, and an
    error here would silently mis-state every attacker profit figure.
    """
    r_in, r_out = pool
    v = 5.0
    a = frontrun_capacity(v, r_in, r_out, s, GAMMA)

    clean = swap_out(v, r_in, r_out, GAMMA)
    acquired = swap_out(a, r_in, r_out, GAMMA)
    attacked = swap_out(v, r_in + a, r_out - acquired, GAMMA)

    assert attacked / clean == pytest.approx(1.0 - s, rel=1e-9)


def test_capacity_grows_with_tolerance(pool):
    r_in, r_out = pool
    caps = [frontrun_capacity(5.0, r_in, r_out, s, GAMMA) for s in (0.001, 0.01, 0.05)]
    assert caps[0] < caps[1] < caps[2]


def test_zero_tolerance_leaves_no_room(pool):
    r_in, r_out = pool
    assert frontrun_capacity(5.0, r_in, r_out, 0.0, GAMMA) == 0.0


# ------------------------------------------------------------- the sandwich

@pytest.mark.parametrize("s", [0.002, 0.01, 0.05])
def test_victim_never_loses_more_than_they_allowed(pool, s):
    """The core safety property: a sandwich cannot exceed the tolerance."""
    r_in, r_out = pool
    out = optimal_sandwich(5.0, *pool, s, 3000.0, 12.0, GAMMA)
    assert out.victim_loss_bps <= s * 10_000 + 1e-6


def test_optimal_matches_exhaustive_search(pool):
    """The fast path hoists the searcher's optimum out of the slippage sweep.

    That refactor is only valid if it finds the same maximum a direct scan
    does, so this pins it against brute force.
    """
    r_in, r_out = pool
    v, s = 5.0, 0.01
    a_max = frontrun_capacity(v, r_in, r_out, s, GAMMA)

    best = max(
        (
            simulate_sandwich(v, r_in, r_out, s, 3000.0, 12.0, GAMMA, a=a_max * i / 2000)
            for i in range(2001)
        ),
        key=lambda o: o.attacker_profit_usd,
    )
    fast = optimal_sandwich(v, r_in, r_out, s, 3000.0, 12.0, GAMMA)
    assert fast.attacker_profit_usd == pytest.approx(best.attacker_profit_usd, rel=1e-3)


def test_unconstrained_optimum_ignores_tolerance(pool):
    """The hoist is only sound because this quantity is independent of `s`."""
    r_in, r_out = pool
    a = unconstrained_frontrun(5.0, r_in, r_out, GAMMA)
    assert a > 0
    # it must be reachable only at wide tolerances, and capped at tight ones
    assert frontrun_capacity(5.0, r_in, r_out, 0.0005, GAMMA) < a


def test_attacker_captures_less_than_the_victim_loses(pool):
    """Fees mean a sandwich destroys value rather than merely transferring it."""
    r_in, r_out = pool
    out = optimal_sandwich(5.0, *pool, 0.01, 3000.0, 12.0, GAMMA)
    assert 0 < out.attacker_revenue_usd < out.victim_loss_usd


def test_attacker_profit_increases_with_tolerance(pool):
    r_in, r_out = pool
    profits = [
        optimal_sandwich(5.0, r_in, r_out, s, 3000.0, 12.0, GAMMA).attacker_profit_usd
        for s in (0.001, 0.005, 0.02)
    ]
    assert profits[0] < profits[1] < profits[2]


# ------------------------------------------------------- the break-even point

def test_critical_slippage_is_the_profit_crossing(pool):
    r_in, r_out = pool
    v, cost = 5.0, 12.0
    s_crit = critical_slippage(v, r_in, r_out, 3000.0, cost, GAMMA)

    below = optimal_sandwich(v, r_in, r_out, s_crit * 0.9, 3000.0, cost, GAMMA)
    above = optimal_sandwich(v, r_in, r_out, s_crit * 1.1, 3000.0, cost, GAMMA)
    assert below.attacker_profit_usd <= 0 <= above.attacker_profit_usd


def test_deep_pool_with_high_fee_is_unattackable():
    """A trade that moves price less than the round-trip fee cannot be sandwiched.

    Break-even needs v/R > 2*fee. Here a $12k trade sits well under that bar in
    an $8.5M 30bp pool, so no front-run size is profitable at any tolerance.
    """
    r_in, r_out = reserves_from_tvl(8_500_000, 3000.0, 1.0)
    out = optimal_sandwich(4.0, r_in, r_out, 0.03, 3000.0, 20.0, GAMMA)
    assert out.attacker_profit_usd < 0
    assert out.frontrun_size == 0.0


def test_low_fee_tier_makes_the_same_trade_attackable():
    """The same trade in a 5bp pool clears the bar the 30bp pool did not."""
    r_in, r_out = reserves_from_tvl(8_500_000, 3000.0, 1.0)
    out = optimal_sandwich(4.0, r_in, r_out, 0.03, 3000.0, 20.0, gamma=0.9995)
    assert out.attacker_profit_usd > 0


def test_reserves_round_trip():
    r_in, r_out = reserves_from_tvl(1_000_000, 2000.0, 1.0)
    assert r_in * 2000.0 == pytest.approx(500_000)
    assert r_out == pytest.approx(500_000)
    assert not math.isnan(r_in)
