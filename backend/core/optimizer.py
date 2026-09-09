"""The sweet-spot solver.

A slippage tolerance is a trade-off between two failure modes that pull in
opposite directions:

  * set it too high and you hand a searcher a budget -- the sandwich takes
    almost exactly the tolerance you granted;
  * set it too low and the trade reverts on ordinary volatility, costing gas
    and forcing you to re-quote into a price that has already moved away.

So the expected cost of a tolerance `s` is

    E[C(s)] = p_atk(s) * L(s)
            + (1 - p_atk(s)) * p_fail(s) * (gas + reprice(s))
            + baseline_impact

and the recommended tolerance is the argmin. Both `p_atk` and `L` come from the
closed-form AMM economics in `core.amm`, scaled by an ML-estimated probability
that a searcher is actually watching this pool under current conditions.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Any

from .amm import (
    optimal_sandwich,
    unconstrained_frontrun,
    critical_slippage,
    price_impact_bps,
    reserves_from_tvl,
)

SQRT_2PI = math.sqrt(2.0 * math.pi)


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


# --------------------------------------------------------------------------
# inputs
# --------------------------------------------------------------------------

@dataclass
class TradeContext:
    """Everything the solver needs about one intended swap."""

    notional_usd: float
    pool_tvl_usd: float
    price_in_usd: float = 1.0
    price_out_usd: float = 1.0
    fee_bps: float = 30.0
    # execution environment
    gas_cost_usd: float = 8.0            # victim's own cost of a failed tx
    attack_cost_usd: float = 15.0        # searcher's gas + tip / Jito bundle bid
    block_time_s: float = 12.0
    inclusion_blocks: float = 2.0        # how long the intent sits exposed
    volatility_24h: float = 0.04         # daily sigma of returns (0.04 == 4%/day)
    # behavioural
    bot_activity: float = 0.55           # P(a searcher is watching) -- from the ML model
    private_relay: bool = False          # Flashbots Protect / Jito bundle
    risk_aversion: float = 0.35          # penalty weight on execution variance when splitting
    chase_factor: float = 0.5            # fraction of an adverse move eaten before giving up
    max_attempts: float = 3.0            # retries before giving up
    unfilled_penalty_bps: float = 25.0   # opportunity cost of never getting filled

    @property
    def gamma(self) -> float:
        return 1.0 - self.fee_bps / 10_000.0

    @property
    def reserves(self) -> tuple[float, float]:
        return reserves_from_tvl(self.pool_tvl_usd, self.price_in_usd, self.price_out_usd)

    @property
    def size_in(self) -> float:
        return self.notional_usd / self.price_in_usd

    def sigma_over(self, seconds: float) -> float:
        """Sigma of the price over a holding window, from the daily figure."""
        return self.volatility_24h * math.sqrt(max(seconds, 1e-9) / 86_400.0)

    @property
    def exposure_seconds(self) -> float:
        return self.block_time_s * self.inclusion_blocks


# --------------------------------------------------------------------------
# the two competing risks
# --------------------------------------------------------------------------

def attack_probability(ctx: TradeContext, s: float, a_unc: float | None = None) -> float:
    """P(this swap gets sandwiched at tolerance `s`).

    Two gates in series. A searcher must (a) see the intent at all, and (b) find
    it worth more than the bundle bid. The second gate is a logistic on profit
    rather than a hard step, because competing searchers, tip auctions and
    inventory limits blur the break-even point in practice.
    """
    if ctx.private_relay:
        # private orderflow removes the public mempool observation; residual
        # risk is builder/validator-side leakage, not zero
        return 0.02 * ctx.bot_activity

    r_in, r_out = ctx.reserves
    outcome = optimal_sandwich(
        ctx.size_in, r_in, r_out, s, ctx.price_in_usd, ctx.attack_cost_usd, ctx.gamma,
        a_unconstrained=a_unc,
    )
    profit = outcome.attacker_profit_usd
    # The logistic width represents uncertainty in *our* estimate of the
    # searcher's cost, not searcher irrationality -- nobody runs a bundle they
    # expect to lose on. A narrow width therefore makes the break-even point
    # behave like the near-step function it is in reality.
    scale = max(ctx.attack_cost_usd, 1.0) * 0.25
    take_rate = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, profit / scale))))
    return max(0.0, min(1.0, ctx.bot_activity * take_rate))


def revert_probability(ctx: TradeContext, s: float) -> float:
    """P(the trade reverts because the market moved through the tolerance)."""
    sigma = ctx.sigma_over(ctx.exposure_seconds)
    if sigma <= 0:
        return 0.005
    # only adverse moves matter, hence the one-sided tail
    p = _norm_cdf(-s / sigma)
    return min(0.99, p + 0.004)  # floor: nonce races, rounding, router quirks


def expected_attempts(ctx: TradeContext, s: float) -> float:
    """Expected submissions before one lands, capped at `max_attempts`.

    A tight tolerance behaves like a limit order that cancels itself: it fails,
    you resubmit, and you pay gas every time. The geometric mean 1/(1 - p_fail)
    is the pushback that stops the optimiser from driving slippage to zero.
    """
    p_fail = revert_probability(ctx, s)
    if p_fail >= 0.999:
        return ctx.max_attempts
    return min(ctx.max_attempts, 1.0 / (1.0 - p_fail))


def reprice_cost_usd(ctx: TradeContext, s: float) -> float:
    """Cost of chasing the price after a revert.

    Conditional on an adverse move larger than `s`, its expected size is the
    truncated-normal mean sigma * phi(z) / (1 - Phi(z)). A trader does not eat
    all of that -- part of the time the price comes back before they give up and
    cross at market -- so it is scaled by `chase_factor`. That coefficient is
    the one calibrated (rather than derived) number in the revert branch, and it
    is surfaced in the API response so the assumption stays visible.
    """
    sigma = ctx.sigma_over(ctx.exposure_seconds)
    if sigma <= 0:
        return 0.0
    z = s / sigma
    tail = 1.0 - _norm_cdf(z)
    if tail < 1e-9:
        return ctx.notional_usd * s * ctx.chase_factor
    expected_move = sigma * _norm_pdf(z) / tail
    return ctx.notional_usd * expected_move * ctx.chase_factor


def baseline_impact_usd(ctx: TradeContext) -> float:
    """Unavoidable LP fee + price impact. Independent of `s`, but real money."""
    r_in, r_out = ctx.reserves
    impact = price_impact_bps(ctx.size_in, r_in, r_out, ctx.gamma) / 10_000.0
    return ctx.notional_usd * impact


# --------------------------------------------------------------------------
# the objective
# --------------------------------------------------------------------------

@dataclass
class CostPoint:
    slippage_bps: float
    p_attack: float
    p_revert: float
    attack_loss_usd: float
    revert_cost_usd: float
    expected_cost_usd: float
    attacker_profit_usd: float


def _default_grid() -> list[float]:
    """Dense where retail actually sets tolerances, sparse in the tail."""
    grid = [i / 10_000.0 for i in range(1, 100)]          # 1bp .. 99bp
    grid += [i / 10_000.0 for i in range(100, 500, 5)]    # 1% .. 5%
    grid += [i / 10_000.0 for i in range(500, 2001, 25)]  # 5% .. 20%
    return grid


def cost_curve(ctx: TradeContext, grid: list[float] | None = None) -> list[CostPoint]:
    """Expected cost across the full tolerance range -- this is the chart."""
    if grid is None:
        grid = _default_grid()

    r_in, r_out = ctx.reserves
    base = baseline_impact_usd(ctx)
    points: list[CostPoint] = []

    # the searcher's unconstrained optimum is independent of `s`, so it is
    # solved once and reused across the whole sweep
    a_unc = unconstrained_frontrun(ctx.size_in, r_in, r_out, ctx.gamma)

    for s in grid:
        outcome = optimal_sandwich(
            ctx.size_in, r_in, r_out, s, ctx.price_in_usd, ctx.attack_cost_usd, ctx.gamma,
            a_unconstrained=a_unc,
        )
        p_atk = attack_probability(ctx, s, a_unc=a_unc)
        p_rev = revert_probability(ctx, s)

        # A sandwiched trade does not revert -- the searcher is careful to leave
        # it inside tolerance -- so the two branches are treated as exclusive.
        # Gas is paid either way, but only the un-attacked branch retries.
        gas_term = p_atk * ctx.gas_cost_usd + (1.0 - p_atk) * ctx.gas_cost_usd * expected_attempts(ctx, s)
        chase = p_rev * reprice_cost_usd(ctx, s)
        never_filled = (p_rev ** ctx.max_attempts) * ctx.notional_usd * (ctx.unfilled_penalty_bps / 10_000.0)
        fail_cost = gas_term + chase + never_filled

        expected = (
            p_atk * outcome.victim_loss_usd
            + (1.0 - p_atk) * (chase + never_filled)
            + gas_term
            + base
        )
        points.append(
            CostPoint(
                slippage_bps=s * 10_000.0,
                p_attack=p_atk,
                p_revert=p_rev,
                attack_loss_usd=outcome.victim_loss_usd,
                revert_cost_usd=fail_cost,
                expected_cost_usd=expected,
                attacker_profit_usd=outcome.attacker_profit_usd,
            )
        )
    return points


@dataclass
class SweetSpot:
    slippage_bps: float
    expected_cost_usd: float
    expected_cost_bps: float
    p_attack: float
    p_revert: float
    critical_slippage_bps: float       # where sandwiching stops paying for itself
    attacker_profit_at_rec_usd: float
    worst_case_loss_usd: float         # if the sandwich lands anyway
    savings_vs_default_usd: float
    default_slippage_bps: float
    baseline_impact_usd: float         # LP fee + price impact -- unavoidable
    controllable_cost_usd: float       # the part better execution can remove
    curve: list[dict[str, float]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def find_sweet_spot(ctx: TradeContext, default_slippage_bps: float = 50.0) -> SweetSpot:
    """Minimise expected cost over the tolerance grid."""
    curve = cost_curve(ctx)
    best = min(curve, key=lambda p: p.expected_cost_usd)

    r_in, r_out = ctx.reserves
    a_unc = unconstrained_frontrun(ctx.size_in, r_in, r_out, ctx.gamma)
    s_crit = critical_slippage(
        ctx.size_in, r_in, r_out, ctx.price_in_usd, ctx.attack_cost_usd, ctx.gamma
    )

    # what the same trade costs at the wallet's out-of-the-box tolerance
    default_point = min(curve, key=lambda p: abs(p.slippage_bps - default_slippage_bps))
    worst = optimal_sandwich(
        ctx.size_in, r_in, r_out, best.slippage_bps / 10_000.0,
        ctx.price_in_usd, ctx.attack_cost_usd, ctx.gamma, a_unconstrained=a_unc,
    )

    return SweetSpot(
        slippage_bps=round(best.slippage_bps, 1),
        expected_cost_usd=best.expected_cost_usd,
        expected_cost_bps=(best.expected_cost_usd / max(ctx.notional_usd, 1e-9)) * 10_000.0,
        p_attack=best.p_attack,
        p_revert=best.p_revert,
        critical_slippage_bps=s_crit * 10_000.0,
        attacker_profit_at_rec_usd=best.attacker_profit_usd,
        worst_case_loss_usd=worst.victim_loss_usd,
        savings_vs_default_usd=default_point.expected_cost_usd - best.expected_cost_usd,
        default_slippage_bps=default_slippage_bps,
        baseline_impact_usd=baseline_impact_usd(ctx),
        controllable_cost_usd=best.expected_cost_usd - baseline_impact_usd(ctx),
        curve=[
            {
                "slippage_bps": round(p.slippage_bps, 2),
                "expected_cost_usd": round(p.expected_cost_usd, 4),
                "attack_loss_usd": round(p.attack_loss_usd, 4),
                "revert_cost_usd": round(p.revert_cost_usd, 4),
                "p_attack": round(p.p_attack, 5),
                "p_revert": round(p.p_revert, 5),
                "attacker_profit_usd": round(p.attacker_profit_usd, 4),
            }
            for p in curve
        ],
    )


# --------------------------------------------------------------------------
# order splitting
# --------------------------------------------------------------------------

@dataclass
class SplitPlan:
    chunks: int
    chunk_size_usd: float
    slippage_bps: float
    expected_cost_usd: float
    expected_cost_bps: float
    gas_overhead_usd: float
    timing_risk_usd: float
    p_attack_per_chunk: float
    attacker_profit_per_chunk_usd: float
    total_duration_s: float


def evaluate_split(ctx: TradeContext, n: int, recovery: float = 0.7) -> SplitPlan:
    """Cost of executing the notional as `n` sequential chunks.

    Splitting works because the attacker's budget is superlinear in trade size:
    a chunk a fifth the size is worth far less than a fifth of the sandwich, and
    often falls under the bundle bid entirely. It is not free -- you pay gas per
    chunk and hold market risk for the duration.

    `recovery` is how much of each chunk's price impact arbitrage restores
    before the next lands (1.0 = fully restored, 0.0 = impact accumulates).
    """
    n = max(1, int(n))
    chunk_ctx = TradeContext(**{**ctx.__dict__, "notional_usd": ctx.notional_usd / n})

    spot = find_sweet_spot(chunk_ctx)
    per_chunk = spot.expected_cost_usd

    # unrecovered impact from earlier chunks makes later ones execute worse
    residual = (1.0 - recovery) * baseline_impact_usd(chunk_ctx)
    drift_penalty = residual * (n - 1) * n / 2.0

    gas_overhead = ctx.gas_cost_usd * (n - 1)

    # holding risk: chunk i is exposed for i intervals of market volatility
    duration = ctx.exposure_seconds * n
    timing = 0.0
    for i in range(1, n + 1):
        sigma_i = ctx.sigma_over(ctx.exposure_seconds * i)
        timing += ctx.risk_aversion * sigma_i * chunk_ctx.notional_usd

    total = per_chunk * n + gas_overhead + timing + drift_penalty

    r_in, r_out = chunk_ctx.reserves
    outcome = optimal_sandwich(
        chunk_ctx.size_in, r_in, r_out, spot.slippage_bps / 10_000.0,
        chunk_ctx.price_in_usd, chunk_ctx.attack_cost_usd, chunk_ctx.gamma,
    )

    return SplitPlan(
        chunks=n,
        chunk_size_usd=chunk_ctx.notional_usd,
        slippage_bps=spot.slippage_bps,
        expected_cost_usd=total,
        expected_cost_bps=(total / max(ctx.notional_usd, 1e-9)) * 10_000.0,
        gas_overhead_usd=gas_overhead,
        timing_risk_usd=timing,
        p_attack_per_chunk=spot.p_attack,
        attacker_profit_per_chunk_usd=outcome.attacker_profit_usd,
        total_duration_s=duration,
    )


def optimal_split(ctx: TradeContext, max_chunks: int = 10) -> tuple[SplitPlan, list[SplitPlan]]:
    """Best chunk count, plus the whole ladder so the UI can show the trade-off."""
    plans = [evaluate_split(ctx, n) for n in range(1, max_chunks + 1)]
    return min(plans, key=lambda p: p.expected_cost_usd), plans
