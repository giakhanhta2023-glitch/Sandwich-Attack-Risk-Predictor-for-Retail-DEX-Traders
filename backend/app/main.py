"""HTTP API.

The interesting endpoint is `/api/analyze`, which fuses the two halves of the
system. The ML model estimates the one thing arithmetic cannot know -- whether a
searcher is watching this pool right now -- and the closed-form economics supply
everything that follows deterministically from that. Concretely: the model's
probability at the user's *current* slippage is inverted through the take-rate
curve to recover the latent searcher presence, and that presence is then held
fixed while the optimiser sweeps slippage. Without that inversion the two halves
would disagree, and the recommended tolerance would not match the risk shown
next to it.
"""

from __future__ import annotations

import math
import time
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ..core.amm import (
    optimal_sandwich,
    frontrun_capacity,
    price_impact_bps,
    reserves_from_tvl,
    unconstrained_frontrun,
)
from ..core.optimizer import (
    TradeContext,
    attack_probability,
    take_rate,
    find_sweet_spot,
    optimal_split,
    evaluate_split,
    revert_probability,
    baseline_impact_usd,
)
from ..core.pools import get_pool, list_pools, market_snapshot, refresh_registry
from ..db import repository as repo
from ..db.client import DatabaseUnavailable, db_status
from ..ingestion.bigquery_eth import describe_queries
from ..ml import live_model
from ..ml.predictor import get_predictor
from .config import settings

app = FastAPI(
    title="Sandwich-Attack Risk Predictor",
    description="MEV sandwich risk scoring and slippage optimisation for retail DEX traders",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# schemas
# --------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    pool_id: str = Field(..., description="Pool from /api/pools")
    notional_usd: float = Field(..., gt=0, le=50_000_000)
    slippage_bps: float = Field(50.0, ge=1, le=5000, description="Current wallet tolerance")
    private_relay: bool = Field(False, description="Flashbots Protect / Jito bundle routing")
    hour_of_day: int = Field(-1, ge=-1, le=23, description="-1 uses current UTC hour")
    max_chunks: int = Field(8, ge=1, le=20)


class SimulateRequest(BaseModel):
    pool_id: str
    notional_usd: float = Field(..., gt=0)
    slippage_bps: float = Field(50.0, ge=1, le=5000)


# --------------------------------------------------------------------------
# the fusion step
# --------------------------------------------------------------------------

def calibrate_bot_activity(ctx: TradeContext, s: float, p_ml: float) -> float:
    """Recover latent searcher presence from the model's probability.

    `attack_probability` factorises as presence * take_rate(profit(s)). The ML
    model gives the left-hand side at the user's current tolerance and the
    economics give the take rate, so presence falls out by division. Holding it
    fixed across the sweep is what keeps the risk number and the recommended
    tolerance on the same footing.
    """
    if ctx.private_relay:
        return min(1.0, max(0.0, p_ml / 0.02)) if p_ml > 0 else 0.0

    take = take_rate(ctx, s)
    if take < 1e-6:
        # nothing to invert: the trade is unprofitable at this tolerance, so the
        # model's probability carries no information about presence
        return 0.5
    return float(min(1.0, max(0.0, p_ml / take)))


def _context_for(pool: dict[str, Any], req: AnalyzeRequest, hour: int) -> TradeContext:
    market = market_snapshot(pool["chain"], hour)
    return TradeContext(
        notional_usd=req.notional_usd,
        pool_tvl_usd=pool["tvl_usd"],
        price_in_usd=pool["price_in_usd"],
        fee_bps=pool["fee_bps"],
        gas_cost_usd=market["user_gas_usd"],
        attack_cost_usd=market["attack_cost_usd"],
        block_time_s=market["block_time_s"],
        inclusion_blocks=market["inclusion_blocks"],
        volatility_24h=pool["volatility_24h"],
        private_relay=req.private_relay,
    )


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    predictor = get_predictor()
    return {
        "status": "ok",
        "model_trained": predictor.trained or live_model.load() is not None,
        "serving": _serving_mode(predictor),
        "sources": settings.source_status(),
        "database": db_status(),
    }


def _serving_mode(predictor: Any) -> dict[str, Any]:
    """Which model is answering, in the words of whichever one it is.

    On Vercel the scientific stack is absent, so the scikit-learn predictor never
    loads -- but the mainnet-trained model does, as plain arithmetic. Reporting
    only the predictor made a live deployment call itself a fallback.
    """
    live = live_model.info()
    if live is None:
        return predictor.serving_mode()
    metrics = live.get("metrics") or {}
    auc = metrics.get("roc_auc")
    return {
        "mode": "live-mainnet",
        "detail": (
            f"weighted logistic regression fitted on {live.get('positives')} sandwiched "
            f"and {live.get('rows')} sampled mainnet swaps"
            + (f", holdout ROC-AUC {auc}" if auc else "")
        ),
        "trained_at": live.get("trained_at"),
        "affects": (
            "Real pools are answered by this model, shifted by the pool's own measured "
            "victim rate. The reference pools keep the closed-form economics."
        ),
    }


@app.get("/api/db/status")
def database_status() -> dict[str, Any]:
    """Storage-layer health: connectivity, row counts and ingestion freshness."""
    status = db_status()
    if not status["readable"]:
        return {**status, "counts": {}, "ingestion": [], "model_runs": []}
    return {
        **status,
        "counts": repo.counts(),
        "ingestion": repo.ingestion_health(),
        "model_runs": repo.model_run_history(limit=10),
        "recent_sandwiches": repo.recent_sandwiches(limit=20),
    }


@app.post("/api/db/sync-pools")
def sync_pools() -> dict[str, Any]:
    """Push the static pool registry into the database.

    Run once after adding a service key; the registry stays the source of truth
    for seeded pools, and this makes the foreign keys resolve for ingestion.
    """
    from ..ingestion.synthetic import default_universe

    try:
        written = repo.sync_pools(default_universe())
    except DatabaseUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    refresh_registry()
    return {"synced": written}


@app.get("/api/pools")
def pools(chain: Literal["all", "ethereum", "solana"] = "all") -> dict[str, Any]:
    predictor = get_predictor()
    items = list_pools(chain)
    for item in items:
        # a real pool's history is what the scanner measured in it
        measured = item.get("measured")
        prior = measured["victim_rate"] if measured else predictor.pool_prior(item["pool_id"])
        item["historical_attack_rate"] = round(prior, 4)
    return {"pools": items, "count": len(items)}


@app.get("/api/model")
def model_report() -> dict[str, Any]:
    predictor = get_predictor()
    if not predictor.report:
        raise HTTPException(404, "No trained model. Run: python -m backend.ml.train")
    report = dict(predictor.report)
    report["feature_importance"] = report.get("feature_importance", [])[:12]
    # The metrics describe the training run. Whether that model is the one
    # answering /api/analyze right now is a separate question, so say which.
    report["serving"] = predictor.serving_mode()
    # Solana pools are scored by the model trained on mainnet swaps whenever one
    # exists, so its card is served alongside the simulator's.
    report["live_model"] = live_model.card()
    report.pop("feature_medians", None)
    return report


@app.get("/api/methodology")
def methodology() -> dict[str, Any]:
    return {
        "sources": settings.source_status(),
        "bigquery_sql": describe_queries(),
        "detection": {
            "pattern": "front-run / victim / back-run in one pool, inside one validator's leader window",
            "criteria": [
                "the same wallet signs the front-run and the back-run",
                "the back-run unwinds the front-run to within 3%",
                "another wallet trades the same direction in between",
                "both legs land inside one leader window (at most 4 consecutive slots)",
                "the attacker's round trip is profitable, valued from the pool's side",
            ],
            "loss_measurement": (
                "the victim lost at least what the attacker made, measured from the pool's own "
                "token balances, so every reported loss is a floor"
            ),
        },
        "optimisation": {
            "objective": "E[C(s)] = p_atk(s)*L(s) + (1-p_atk(s))*(chase + unfilled) + gas*E[attempts] + impact",
            "frontrun_capacity": (
                "closed-form positive root of u*g*a^2 + u*(Rx*(1+g) + g^2*v)*a - s*Rx*(Rx + g*v) = 0, "
                "with u = 1 - s"
            ),
            "note": (
                "the searcher's unconstrained optimum is independent of the victim's tolerance, "
                "so tolerance only ever caps it"
            ),
        },
    }


# Whenever a model trained on live Solana flow exists, it sets the headline for
# Solana pools: a number measured on the chain beats a formula. These thresholds
# no longer gate that. They mark the model as early, and what it still lacks is
# returned with its number so a reader can judge how much data stands behind it.
LIVE_MIN_POSITIVES = 100
LIVE_MIN_AUC = 0.6
LIVE_MIN_VICTIM_POOLS = 20
LIVE_MAX_TOP_POOL_SHARE = 1 / 3

# Risk is what a trader should expect to lose to sandwiches, as a share of the
# trade: the chance a bot reaches it and finds it worth attacking, times what it
# takes when it does. Labelling by the chance alone called a 4% chance of losing
# over a tenth of a $100k trade "low".
_LOSS_BANDS = ((0.5, "minimal"), (3.0, "low"), (10.0, "elevated"), (30.0, "high"))


# How many swaps' worth of weight the model's estimate carries against a real
# pool's own measured rate. Pools differ enormously -- from a tenth of a percent
# to nearly every trade -- so the average is a weak prior and gets little say.
LIVE_PRIOR_SWAPS = 25


def _shift_log_odds(level: float, p: float, ref: float) -> float:
    """`level`, moved by however far `p` sits from `ref` in log-odds.

    Never above 95%: some leaders run no sandwiching at all, so no trade is
    certain to be reached.
    """
    def logit(x: float) -> float:
        x = min(1 - 1e-6, max(1e-6, x))
        return math.log(x / (1 - x))

    z = logit(level) + logit(p) - logit(ref)
    return min(0.95, 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, z)))))


def loss_band(expected_loss_bps: float) -> str:
    """Risk label from the expected sandwich loss, in basis points of the trade."""
    return next((band for cap, band in _LOSS_BANDS if expected_loss_bps < cap), "severe")


def _pool_quote(pool: dict[str, Any]) -> str:
    """Quote asset from a registry symbol: 'BONK/SOL' -> SOL, 'SOL/USDC Whirlpool' -> USDC."""
    return pool["symbol"].split("/")[-1].split()[0].upper()


def _live_market_estimate(pool: dict[str, Any], req: AnalyzeRequest, hour: int) -> dict[str, Any] | None:
    """How often bots reach trades like this one on Solana mainnet.

    The live model sees size, pool depth, direction, hour and quote asset -- all
    observable on-chain -- but not the trader's slippage tolerance, which never
    appears in balance changes. So it answers only how often bots reach trades
    like this; whether a given trade is worth attacking at the user's tolerance
    is left to the AMM arithmetic in `analyze`.
    """
    if pool["chain"] != "solana":
        return None
    info = live_model.info()
    if info is None:
        return None
    depth = pool["tvl_usd"] / 2.0  # quote-side depth of a balanced pool
    p = live_model.predict(
        size_usd=req.notional_usd, depth_usd=depth, side="buy", hour_utc=hour, quote_symbol=_pool_quote(pool),
    )
    if p is None:
        return None

    # A real pool's own measured rate sets the level, and the model supplies only
    # how that rate shifts with this trade's size: a shift in log-odds from the
    # pool's average trade. The measured rate is shrunk toward the model by a
    # prior worth LIVE_PRIOR_SWAPS swaps, so a thin sample cannot claim certainty.
    measured = pool.get("measured")
    pool_rate = None
    if measured:
        typical = live_model.predict(
            size_usd=measured["avg_trade_usd"] or req.notional_usd, depth_usd=depth,
            side="buy", hour_utc=hour, quote_symbol=_pool_quote(pool),
        )
        if typical:
            pool_rate = (measured["victims"] + LIVE_PRIOR_SWAPS * typical) / (measured["swaps"] + LIVE_PRIOR_SWAPS)
            p = _shift_log_odds(pool_rate, p, typical)
    auc = (info.get("metrics") or {}).get("roc_auc")
    positives = int(info.get("positives") or 0)
    # An artifact from before these were recorded counts as concentrated.
    victim_pools = int(info.get("victim_pools") or 0)
    top_share = float(info.get("top_pool_share") or 1.0)

    shortfalls = []
    if positives < LIVE_MIN_POSITIVES:
        shortfalls.append(f"{positives} of {LIVE_MIN_POSITIVES} real victims")
    if auc is None:
        shortfalls.append("a holdout AUC (not yet measurable)")
    elif auc < LIVE_MIN_AUC:
        shortfalls.append(f"a holdout AUC of {LIVE_MIN_AUC} (has {auc})")
    if victim_pools < LIVE_MIN_VICTIM_POOLS:
        shortfalls.append(f"victims in {LIVE_MIN_VICTIM_POOLS} pools (has {victim_pools})")
    if top_share > LIVE_MAX_TOP_POOL_SHARE:
        shortfalls.append(f"no pool above {LIVE_MAX_TOP_POOL_SHARE:.0%} of victims (top has {top_share:.0%})")
    return {
        "p_attack": round(p, 6),
        "pool_rate": round(pool_rate, 5) if pool_rate is not None else None,
        "pool_measured": measured,
        "rows": info.get("rows"),
        "positives": positives,
        "weighted_swaps": info.get("weighted_swaps"),
        "trained_at": info.get("trained_at"),
        "window_end": (info.get("window") or {}).get("end"),
        "roc_auc": auc,
        "victim_pools": victim_pools,
        "top_pool_share": top_share,
        "early": bool(shortfalls),
        "caveats": shortfalls,
    }


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest, background: BackgroundTasks) -> dict[str, Any]:
    pool = get_pool(req.pool_id)
    if pool is None:
        raise HTTPException(404, f"Unknown pool: {req.pool_id}")

    hour = req.hour_of_day if req.hour_of_day >= 0 else time.gmtime().tm_hour
    predictor = get_predictor()
    ctx = _context_for(pool, req, hour)
    market = market_snapshot(pool["chain"], hour)

    # --- 1. ML risk at the user's current tolerance ---------------------
    ml = predictor.predict(
        notional_usd=req.notional_usd,
        pool_tvl_usd=pool["tvl_usd"],
        slippage_bps=req.slippage_bps,
        fee_bps=pool["fee_bps"],
        volatility_24h=pool["volatility_24h"],
        attack_cost_usd=ctx.attack_cost_usd,
        price_in_usd=pool["price_in_usd"],
        swaps_per_block=pool["swaps_per_block"],
        is_private_relay=req.private_relay,
        chain=pool["chain"],
        is_stable_pair=pool["is_stable_pair"],
        token_age_days=pool["token_age_days"],
        hour_of_day=hour,
        pool_attack_rate_prior=predictor.pool_prior(req.pool_id),
    )

    # --- 1b. who reaches the trade, and whether it pays ------------------
    # Two questions decide whether a trade gets sandwiched, answered separately.
    # How often bots reach trades like this is measured on mainnet by the live
    # model. Whether this one is worth attacking at the user's tolerance is exact
    # AMM arithmetic -- the one thing chain data cannot show, because a trader's
    # tolerance never appears in balance changes. The chance shown is their
    # product: a tolerance too tight to pay takes it to zero, and a wide one on a
    # big trade keeps it at the reach rate.
    current_s = req.slippage_bps / 10_000.0
    live_market = _live_market_estimate(pool, req, hour)
    if live_market:
        ctx.bot_activity = live_market["p_attack"]
    else:
        # hold the formula's searcher presence fixed across the sweep
        ctx.bot_activity = calibrate_bot_activity(ctx, current_s, ml["p_attack"])

    # --- 2. economics at the current setting ----------------------------
    r_in, r_out = ctx.reserves
    a_unc = unconstrained_frontrun(ctx.size_in, r_in, r_out, ctx.gamma)
    current_outcome = optimal_sandwich(
        ctx.size_in, r_in, r_out, current_s, ctx.price_in_usd, ctx.attack_cost_usd,
        ctx.gamma, a_unconstrained=a_unc,
    )
    p_now = attack_probability(ctx, current_s, a_unc)
    worth = p_now / ctx.bot_activity if ctx.bot_activity > 0 else 0.0

    if live_market:
        ml = {
            **ml,
            "simulated_p_attack": ml["p_attack"],
            "p_attack": round(p_now, 6),
            "expected_loss_bps_if_attacked": round(current_outcome.victim_loss_bps, 2),
            "drivers": live_model.explain(
                req.notional_usd, pool["tvl_usd"] / 2.0, "buy", hour, _pool_quote(pool)
            ),
            "model": "mainnet reach rate x AMM profitability at your tolerance",
            "source": "live-mainnet",
        }
    expected_bps = ml["p_attack"] * ml["expected_loss_bps_if_attacked"]
    ml["expected_loss_bps"] = round(expected_bps, 3)
    ml["expected_loss_usd"] = round(expected_bps / 10_000.0 * req.notional_usd, 4)
    ml["risk_band"] = loss_band(expected_bps)

    # --- 3. sweet spot and splitting ------------------------------------
    spot = find_sweet_spot(ctx, default_slippage_bps=req.slippage_bps)
    best_split, split_plans = optimal_split(ctx, max_chunks=req.max_chunks)
    single = evaluate_split(ctx, 1)

    current_cost = next(
        (p for p in spot.curve if abs(p["slippage_bps"] - req.slippage_bps) < 1.5),
        min(spot.curve, key=lambda p: abs(p["slippage_bps"] - req.slippage_bps)),
    )

    background.add_task(
        repo.log_analysis,
        {
            "pool_id": req.pool_id,
            "chain": pool["chain"],
            "notional_usd": round(req.notional_usd, 2),
            "slippage_bps": round(req.slippage_bps, 2),
            "private_relay": req.private_relay,
            "hour_of_day": hour,
            "p_attack": round(ml["p_attack"], 6),
            "risk_band": ml["risk_band"],
            "searcher_presence": round(ctx.bot_activity, 6),
            "expected_loss_usd": round(ml["expected_loss_usd"], 2),
            "recommended_slippage_bps": spot.slippage_bps,
            "critical_slippage_bps": round(spot.critical_slippage_bps, 2),
            "at_grid_floor": spot.at_grid_floor,
            "expected_cost_usd": round(spot.expected_cost_usd, 2),
            "savings_vs_current_usd": round(
                current_cost["expected_cost_usd"] - spot.expected_cost_usd, 2
            ),
            "recommended_chunks": best_split.chunks,
            "model_source": ml["source"],
            "data_source": "chain" if ml.get("source") == "live-mainnet" else "simulated",
        },
    )

    return {
        "input": {
            "pool": pool,
            "notional_usd": req.notional_usd,
            "slippage_bps": req.slippage_bps,
            "private_relay": req.private_relay,
            "hour_of_day": hour,
        },
        "market": market,
        "risk": {
            **ml,
            "searcher_presence": round(ctx.bot_activity, 4),
            "p_worth_attacking": round(worth, 6),
            "p_revert": round(revert_probability(ctx, current_s), 4),
            "live_market": live_market,
        },
        "economics": {
            "attacker_profit_usd": round(current_outcome.attacker_profit_usd, 2),
            "attacker_revenue_usd": round(current_outcome.attacker_revenue_usd, 2),
            "attack_cost_usd": round(ctx.attack_cost_usd, 2),
            "frontrun_size_usd": round(current_outcome.frontrun_size_usd, 2),
            "frontrun_capacity_usd": round(
                frontrun_capacity(ctx.size_in, r_in, r_out, current_s, ctx.gamma) * ctx.price_in_usd, 2
            ),
            "victim_loss_usd": round(current_outcome.victim_loss_usd, 2),
            "victim_loss_bps": round(current_outcome.victim_loss_bps, 1),
            "attack_is_profitable": current_outcome.profitable,
            "price_impact_bps": round(price_impact_bps(ctx.size_in, r_in, r_out, ctx.gamma), 2),
            "baseline_impact_usd": round(baseline_impact_usd(ctx), 2),
            "critical_slippage_bps": round(spot.critical_slippage_bps, 1),
        },
        "current_setting": {
            "slippage_bps": req.slippage_bps,
            "expected_cost_usd": round(current_cost["expected_cost_usd"], 2),
            "p_attack": current_cost["p_attack"],
            "worst_case_loss_usd": round(current_outcome.victim_loss_usd, 2),
        },
        "sweet_spot": {
            "slippage_bps": spot.slippage_bps,
            "expected_cost_usd": round(spot.expected_cost_usd, 2),
            "expected_cost_bps": round(spot.expected_cost_bps, 2),
            "controllable_cost_usd": round(spot.controllable_cost_usd, 2),
            "at_grid_floor": spot.at_grid_floor,
            "baseline_impact_usd": round(spot.baseline_impact_usd, 2),
            "p_attack": round(spot.p_attack, 5),
            "p_revert": round(spot.p_revert, 5),
            "critical_slippage_bps": round(spot.critical_slippage_bps, 1),
            "attacker_profit_at_rec_usd": round(spot.attacker_profit_at_rec_usd, 2),
            "worst_case_loss_usd": round(spot.worst_case_loss_usd, 2),
            "savings_vs_current_usd": round(
                current_cost["expected_cost_usd"] - spot.expected_cost_usd, 2
            ),
            "curve": spot.curve,
        },
        "split": {
            "recommended_chunks": best_split.chunks,
            "single_cost_usd": round(single.expected_cost_usd, 2),
            "best_cost_usd": round(best_split.expected_cost_usd, 2),
            "savings_usd": round(single.expected_cost_usd - best_split.expected_cost_usd, 2),
            "plans": [
                {
                    "chunks": p.chunks,
                    "chunk_size_usd": round(p.chunk_size_usd, 2),
                    "slippage_bps": p.slippage_bps,
                    "expected_cost_usd": round(p.expected_cost_usd, 2),
                    "expected_cost_bps": round(p.expected_cost_bps, 2),
                    "gas_overhead_usd": round(p.gas_overhead_usd, 2),
                    "timing_risk_usd": round(p.timing_risk_usd, 2),
                    "attacker_profit_per_chunk_usd": round(p.attacker_profit_per_chunk_usd, 2),
                    "p_attack_per_chunk": round(p.p_attack_per_chunk, 4),
                    "total_duration_s": round(p.total_duration_s, 1),
                }
                for p in split_plans
            ],
        },
        "recommendations": _recommendations(
            req, pool, ctx, ml, spot, best_split, single, current_outcome, current_cost
        ),
        "meta": {
            "computed_at": int(time.time()),
            # what actually produced this answer, not what this server is wired to:
            # "chain" only when both the model and the pool were measured on
            # mainnet, "mixed" when a chain-trained model answers for a
            # reference pool whose depth and fee come from the registry.
            "data_source": (
                "chain" if ml.get("source") == "live-mainnet" and pool.get("live")
                else "mixed" if ml.get("source") == "live-mainnet" or pool.get("live")
                else "simulated"
            ),
            "model": ml["model"],
            "assumptions": {
                "chase_factor": ctx.chase_factor,
                "max_attempts": ctx.max_attempts,
                "risk_aversion": ctx.risk_aversion,
                "unfilled_penalty_bps": ctx.unfilled_penalty_bps,
            },
        },
    }


def _recommendations(
    req: AnalyzeRequest,
    pool: dict[str, Any],
    ctx: TradeContext,
    ml: dict[str, Any],
    spot: Any,
    best_split: Any,
    single: Any,
    outcome: Any,
    current_cost: dict[str, float],
) -> list[dict[str, Any]]:
    """Ranked, concrete actions. Each one carries the dollar figure behind it."""
    recs: list[dict[str, Any]] = []

    if not outcome.profitable:
        recs.append({
            "severity": "good",
            "title": "This trade is not economically sandwichable",
            "detail": (
                f"At {req.slippage_bps:.0f}bp the largest front-run your tolerance permits "
                f"nets a searcher ${outcome.attacker_profit_usd:,.2f} after "
                f"${ctx.attack_cost_usd:,.2f} of gas and bundle costs. Pool depth and the "
                f"{pool['fee_bps']:.0f}bp fee tier make the round trip a loss."
            ),
            "impact_usd": 0.0,
        })

    delta = current_cost["expected_cost_usd"] - spot.expected_cost_usd
    if abs(spot.slippage_bps - req.slippage_bps) >= 2 and delta > 0.01:
        direction = "Tighten" if spot.slippage_bps < req.slippage_bps else "Widen"
        recs.append({
            "severity": "action",
            "title": f"{direction} slippage to {spot.slippage_bps:.0f}bp",
            "detail": (
                f"Expected cost falls from ${current_cost['expected_cost_usd']:,.2f} to "
                f"${spot.expected_cost_usd:,.2f}. Below {spot.critical_slippage_bps:.0f}bp the "
                f"sandwich stops covering its own gas."
                if spot.slippage_bps < req.slippage_bps else
                f"Your tolerance is tight enough that reverts and retries cost more than the "
                f"sandwich risk they avoid. Expected cost falls to ${spot.expected_cost_usd:,.2f}."
            ),
            "impact_usd": round(delta, 2),
        })

    if best_split.chunks > 1:
        saving = single.expected_cost_usd - best_split.expected_cost_usd
        if saving > 0.01:
            recs.append({
                "severity": "action",
                "title": f"Split into {best_split.chunks} chunks of ${best_split.chunk_size_usd:,.0f}",
                "detail": (
                    f"Attacker profit per chunk drops to "
                    f"${best_split.attacker_profit_per_chunk_usd:,.2f}, below the cost of running "
                    f"the bundle. Costs ${best_split.gas_overhead_usd:,.2f} in extra gas and "
                    f"{best_split.total_duration_s:,.0f}s of market exposure."
                ),
                "impact_usd": round(saving, 2),
            })

    if ml["p_attack"] > 0.12 and not req.private_relay:
        route = "a Jito bundle or a private RPC" if pool["chain"] == "solana" else "Flashbots Protect or MEV Blocker"
        recs.append({
            "severity": "action",
            "title": f"Route through {route}",
            "detail": (
                f"Private orderflow removes the public-mempool observation this attack depends on. "
                f"At current settings the model puts sandwich probability at "
                f"{ml['p_attack'] * 100:.1f}%; private routing takes it near zero, leaving only "
                f"builder-side leakage."
            ),
            "impact_usd": round(ml["expected_loss_usd"] * 0.95, 2),
        })

    if ctx.notional_usd / pool["tvl_usd"] > 0.01:
        recs.append({
            "severity": "warning",
            "title": "Trade is large relative to pool depth",
            "detail": (
                f"You are moving {ctx.notional_usd / pool['tvl_usd'] * 100:.2f}% of pool TVL. "
                f"Price impact alone costs ${baseline_impact_usd(ctx):,.2f} before any MEV. "
                f"A deeper pool or a different fee tier is worth checking."
            ),
            "impact_usd": round(baseline_impact_usd(ctx), 2),
        })

    recs.sort(key=lambda r: (-r["impact_usd"], r["severity"] != "action"))
    return recs


@app.post("/api/simulate")
def simulate(req: SimulateRequest) -> dict[str, Any]:
    """Step-by-step replay of one sandwich, for the attack visualisation."""
    pool = get_pool(req.pool_id)
    if pool is None:
        raise HTTPException(404, f"Unknown pool: {req.pool_id}")

    market = market_snapshot(pool["chain"], time.gmtime().tm_hour)
    r_in, r_out = reserves_from_tvl(pool["tvl_usd"], pool["price_in_usd"], 1.0)
    gamma = 1.0 - pool["fee_bps"] / 10_000.0
    size_in = req.notional_usd / pool["price_in_usd"]
    s = req.slippage_bps / 10_000.0

    outcome = optimal_sandwich(
        size_in, r_in, r_out, s, pool["price_in_usd"], market["attack_cost_usd"], gamma
    )
    from ..core.amm import swap_out

    a = outcome.frontrun_size
    acquired = swap_out(a, r_in, r_out, gamma)
    rx1, ry1 = r_in + a, r_out - acquired
    victim_out = swap_out(size_in, rx1, ry1, gamma)
    rx2, ry2 = rx1 + size_in, ry1 - victim_out
    returned = swap_out(acquired, ry2, rx2, gamma)
    # after the unwind the pool settles back near, but not at, the start price:
    # the fees the searcher paid on both legs stay with the LPs
    rx3, ry3 = rx2 - returned, ry2 + acquired

    return {
        "pool": pool,
        "steps": [
            {
                "step": 0,
                "actor": "market",
                "label": "Pool before the block",
                "price": round(r_out / r_in, 6),
                "detail": f"Reserves {r_in:,.2f} / {r_out:,.2f}",
            },
            {
                "step": 1,
                "actor": "attacker",
                "label": "Front-run buy",
                "price": round(ry1 / rx1, 6),
                "detail": f"Searcher buys ${a * pool['price_in_usd']:,.0f} and pushes the price up",
                "amount_usd": round(a * pool["price_in_usd"], 2),
            },
            {
                "step": 2,
                "actor": "victim",
                "label": "Your swap executes",
                "price": round(ry2 / rx2, 6),
                "detail": (
                    f"You receive {victim_out:,.4f} instead of {outcome.victim_out_clean:,.4f} "
                    f"({outcome.victim_loss_bps:.0f}bp worse)"
                ),
                "amount_usd": round(req.notional_usd, 2),
                "loss_usd": round(outcome.victim_loss_usd, 2),
            },
            {
                "step": 3,
                "actor": "attacker",
                "label": "Back-run sell",
                "price": round(ry3 / rx3, 6),
                "detail": (
                    f"Searcher unwinds for ${returned * pool['price_in_usd']:,.0f}, "
                    f"netting ${outcome.attacker_profit_usd:,.2f} after costs"
                ),
                "amount_usd": round(returned * pool["price_in_usd"], 2),
                "profit_usd": round(outcome.attacker_profit_usd, 2),
            },
        ],
        "summary": outcome.to_dict(),
    }


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    """Corpus-level statistics for the dashboard."""
    from ..core.pools import corpus_stats

    return corpus_stats()


@app.get("/api/live/solana")
def live_solana(
    pool_address: str = Query(..., description="Solana pool account"),
    limit: int = Query(100, ge=10, le=500),
) -> dict[str, Any]:
    """Pull recent swaps for a Solana pool and run detection over them live."""
    if not settings.helius_live:
        raise HTTPException(
            503,
            "Helius is not configured. Set HELIUS_API_KEY to enable live Solana ingestion.",
        )
    from ..detection.sandwich import detect_sandwiches
    from ..ingestion.helius import fetch_pool_swaps

    swaps = fetch_pool_swaps(pool_address, limit=limit)
    events = detect_sandwiches(swaps)

    return {
        "pool_address": pool_address,
        "swaps_scanned": len(swaps),
        "sandwiches_found": len(events),
        "events": [e.to_dict() for e in events[:50]],
        "source": "helius-live",
        # Persistence moved to the solana-ingest edge function, which runs every
        # minute and is the single writer of detections. This endpoint inspects
        # one pool on demand and stores nothing.
        "persisted": False,
    }
