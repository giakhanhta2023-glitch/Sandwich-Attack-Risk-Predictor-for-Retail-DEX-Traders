"""Constant-product AMM mechanics and closed-form sandwich-attack economics.

Everything downstream (risk scoring, the slippage sweet spot, split sizing) is
built on the equations in this module, so they are derived here explicitly
rather than approximated.

Notation
--------
    Rx, Ry : pool reserves of the input and output token
    gamma  : 1 - fee (e.g. 0.997 for a 30bp pool)
    v      : victim swap size, denominated in the input token
    a      : attacker front-run size, denominated in the input token
    s      : victim slippage tolerance, as a fraction (0.005 == 50bp)

Swap output for the constant product invariant x*y = k:

    out(dx) = Ry * gamma * dx / (Rx + gamma * dx)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Any


# --------------------------------------------------------------------------
# primitive swap math
# --------------------------------------------------------------------------

def swap_out(amount_in: float, r_in: float, r_out: float, gamma: float = 0.997) -> float:
    """Output of a constant-product swap, net of the LP fee."""
    if amount_in <= 0:
        return 0.0
    return (r_out * gamma * amount_in) / (r_in + gamma * amount_in)


def spot_price(r_in: float, r_out: float) -> float:
    """Marginal price of the input token, quoted in the output token."""
    return r_out / r_in


def price_impact_bps(amount_in: float, r_in: float, r_out: float, gamma: float = 0.997) -> float:
    """Execution price shortfall versus the pre-trade spot price, in bps."""
    if amount_in <= 0:
        return 0.0
    out = swap_out(amount_in, r_in, r_out, gamma)
    exec_price = out / amount_in
    return max(0.0, (1.0 - exec_price / spot_price(r_in, r_out)) * 10_000.0)


# --------------------------------------------------------------------------
# how much room a slippage tolerance leaves an attacker
# --------------------------------------------------------------------------

def frontrun_capacity(v: float, r_in: float, r_out: float, s: float, gamma: float = 0.997) -> float:
    """Largest front-run `a` that still lets the victim's trade land.

    The victim's transaction carries a `minAmountOut` of (1 - s) * out_0, where
    out_0 is the quote at submission time. Solving

        out_victim(a) / out_0 = 1 - s

    for `a` gives a quadratic. With u = 1 - s:

        u*gamma*a^2 + u*(Rx*(1+gamma) + gamma^2*v)*a - s*Rx*(Rx + gamma*v) = 0

    The positive root is the attacker's budget: push the price exactly to the
    victim's tolerance and not one wei further. This is the quantity a real
    searcher solves for, and it is why slippage tolerance *is* the attack
    surface: a wider tolerance hands the searcher a bigger budget.
    """
    if s <= 0 or v <= 0:
        return 0.0
    u = 1.0 - s
    if u <= 0:
        return float("inf")

    a_coef = u * gamma
    b_coef = u * (r_in * (1.0 + gamma) + gamma * gamma * v)
    c_coef = -s * r_in * (r_in + gamma * v)

    disc = b_coef * b_coef - 4.0 * a_coef * c_coef
    if disc <= 0:
        return 0.0
    return (-b_coef + math.sqrt(disc)) / (2.0 * a_coef)


# --------------------------------------------------------------------------
# full sandwich simulation
# --------------------------------------------------------------------------

@dataclass
class SandwichOutcome:
    """Result of simulating one sandwich against one victim swap."""

    frontrun_size: float          # attacker capital deployed, input token
    frontrun_size_usd: float
    attacker_revenue_usd: float   # gross, before execution costs
    attacker_cost_usd: float      # gas + priority fee / bundle tip
    attacker_profit_usd: float    # net: the searcher's decision variable
    victim_out_clean: float       # output with no attacker present
    victim_out_attacked: float
    victim_loss_usd: float
    victim_loss_bps: float
    slippage_used_bps: float      # how much of the tolerance the attack ate
    binding: bool                 # True if the attack was capped by tolerance
    profitable: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def simulate_sandwich(
    v: float,
    r_in: float,
    r_out: float,
    s: float,
    price_in_usd: float,
    attack_cost_usd: float,
    gamma: float = 0.997,
    a: float | None = None,
) -> SandwichOutcome:
    """Simulate front-run -> victim -> back-run for a given front-run size.

    The attacker buys `a` of the input token, the victim's swap executes at the
    worsened price, then the attacker dumps the exact position acquired in the
    front-run back into the pool.
    """
    a_max = frontrun_capacity(v, r_in, r_out, s, gamma)
    if a is None:
        a = a_max
    a = max(0.0, min(a, a_max))

    out_clean = swap_out(v, r_in, r_out, gamma)

    if a <= 0:
        return SandwichOutcome(
            frontrun_size=0.0,
            frontrun_size_usd=0.0,
            attacker_revenue_usd=0.0,
            attacker_cost_usd=attack_cost_usd,
            attacker_profit_usd=-attack_cost_usd,
            victim_out_clean=out_clean,
            victim_out_attacked=out_clean,
            victim_loss_usd=0.0,
            victim_loss_bps=0.0,
            slippage_used_bps=0.0,
            binding=False,
            profitable=False,
        )

    # leg 1: attacker buys, moving the price against the victim
    acquired = swap_out(a, r_in, r_out, gamma)
    rx1 = r_in + a
    ry1 = r_out - acquired

    # leg 2: victim executes into the worsened pool
    out_attacked = swap_out(v, rx1, ry1, gamma)
    rx2 = rx1 + v
    ry2 = ry1 - out_attacked

    # leg 3: attacker unwinds the exact position from leg 1
    returned = swap_out(acquired, ry2, rx2, gamma)

    revenue_usd = (returned - a) * price_in_usd
    profit_usd = revenue_usd - attack_cost_usd

    loss_native = out_clean - out_attacked
    loss_bps = (loss_native / out_clean) * 10_000.0 if out_clean > 0 else 0.0
    # victim loss valued on the input side keeps every figure in one currency
    loss_usd = (loss_native / out_clean) * (v * price_in_usd) if out_clean > 0 else 0.0

    return SandwichOutcome(
        frontrun_size=a,
        frontrun_size_usd=a * price_in_usd,
        attacker_revenue_usd=revenue_usd,
        attacker_cost_usd=attack_cost_usd,
        attacker_profit_usd=profit_usd,
        victim_out_clean=out_clean,
        victim_out_attacked=out_attacked,
        victim_loss_usd=loss_usd,
        victim_loss_bps=loss_bps,
        slippage_used_bps=loss_bps,
        binding=abs(a - a_max) / max(a_max, 1e-18) < 1e-6,
        profitable=profit_usd > 0,
    )


def unconstrained_frontrun(
    v: float,
    r_in: float,
    r_out: float,
    gamma: float = 0.997,
    iterations: int = 40,
    a_cap: float | None = None,
) -> float:
    """Front-run size a searcher would choose with no slippage cap in their way.

    Profit is unimodal in `a`: it climbs while the induced price move outruns the
    fee drag on the round trip, then falls once the attacker is trading against
    their own impact. Ternary search finds that interior peak.

    The key structural fact, and the reason this is a separate function, is
    that this optimum does not depend on the victim's slippage tolerance at all.
    Tolerance only ever *caps* it. So the expensive search runs once per pool and
    trade size, and every point on a slippage sweep is then a single closed-form
    min() plus one simulation, instead of its own search.
    """
    if v <= 0:
        return 0.0

    # The search interval matters. Profit is unimodal only over the range a
    # searcher could plausibly operate in: push `a` far enough and the attacker
    # buys out the pool and sells it back, recovering the victim's whole input,
    # so profit turns upward again at the extreme. That branch is unreachable in
    # practice (it needs a victim tolerance near 100% and pool-sized capital),
    # but a ternary search over an unbounded interval will happily walk into it.
    # Capping at the capacity implied by a 50% tolerance keeps the search inside
    # the unimodal region and still bounds every tolerance the grid sweeps.
    if a_cap is None:
        a_cap = frontrun_capacity(v, r_in, r_out, 0.5, gamma)
    if not math.isfinite(a_cap) or a_cap <= 0:
        return 0.0
    lo, hi = 0.0, a_cap

    def profit_at(a: float) -> float:
        acquired = swap_out(a, r_in, r_out, gamma)
        rx1, ry1 = r_in + a, r_out - acquired
        out_v = swap_out(v, rx1, ry1, gamma)
        rx2, ry2 = rx1 + v, ry1 - out_v
        return swap_out(acquired, ry2, rx2, gamma) - a

    for _ in range(iterations):
        m1 = lo + (hi - lo) / 3.0
        m2 = hi - (hi - lo) / 3.0
        if profit_at(m1) < profit_at(m2):
            lo = m1
        else:
            hi = m2

    best = (lo + hi) / 2.0
    # When no front-run is gross-profitable the search converges toward zero but
    # never reaches it. Snap to exactly zero so "unattackable" reports as a $0
    # front-run rather than a dust amount that reads like a real position.
    return best if profit_at(best) > 0 else 0.0


def optimal_sandwich(
    v: float,
    r_in: float,
    r_out: float,
    s: float,
    price_in_usd: float,
    attack_cost_usd: float,
    gamma: float = 0.997,
    a_unconstrained: float | None = None,
) -> SandwichOutcome:
    """The attack a rational searcher actually runs.

    The searcher takes the smaller of their unconstrained optimum and whatever
    the victim's tolerance permits. For retail-sized tolerances the cap binds,
    which is precisely why the tolerance setting is the lever that matters.

    Pass `a_unconstrained` when sweeping slippage over a fixed trade to skip the
    repeated search.
    """
    a_max = frontrun_capacity(v, r_in, r_out, s, gamma)
    if a_max <= 0:
        return simulate_sandwich(v, r_in, r_out, s, price_in_usd, attack_cost_usd, gamma, a=0.0)

    if a_unconstrained is None:
        a_unconstrained = unconstrained_frontrun(v, r_in, r_out, gamma)

    return simulate_sandwich(
        v, r_in, r_out, s, price_in_usd, attack_cost_usd, gamma,
        a=min(a_unconstrained, a_max),
    )


def critical_slippage(
    v: float,
    r_in: float,
    r_out: float,
    price_in_usd: float,
    attack_cost_usd: float,
    gamma: float = 0.997,
    lo: float = 1e-5,
    hi: float = 0.5,
    tol: float = 1e-6,
) -> float:
    """Slippage tolerance at which sandwiching this trade breaks even.

    Below this threshold the attacker's budget is too small to cover gas and the
    bundle tip, so the trade is economically un-sandwichable rather than merely
    unattractive. Attacker profit is monotone increasing in `s` (a wider
    tolerance is a strictly larger budget), so a bisection is exact.
    """
    a_unc = unconstrained_frontrun(v, r_in, r_out, gamma)

    def profit(s: float) -> float:
        return optimal_sandwich(
            v, r_in, r_out, s, price_in_usd, attack_cost_usd, gamma, a_unconstrained=a_unc
        ).attacker_profit_usd

    if profit(hi) <= 0:
        return hi  # never profitable within a sane tolerance range
    if profit(lo) > 0:
        return lo  # profitable even at a dust tolerance

    while hi - lo > tol:
        mid = (lo + hi) / 2.0
        if profit(mid) > 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


# --------------------------------------------------------------------------
# reserve helpers: the UI speaks USD, the math speaks reserves
# --------------------------------------------------------------------------

def reserves_from_tvl(tvl_usd: float, price_in_usd: float, price_out_usd: float) -> tuple[float, float]:
    """Balanced 50/50 reserves implied by a pool's TVL."""
    half = max(tvl_usd, 1.0) / 2.0
    return half / price_in_usd, half / price_out_usd
