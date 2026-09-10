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
from ..ml.predictor import get_predictor, risk_band
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

    r_in, r_out = ctx.reserves
    outcome = optimal_sandwich(
        ctx.size_in, r_in, r_out, s, ctx.price_in_usd, ctx.attack_cost_usd, ctx.gamma
    )
    scale = max(ctx.attack_cost_usd, 1.0) * 0.25
    take = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, outcome.attacker_profit_usd / scale))))
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
        "model_trained": predictor.trained,
        "serving": predictor.serving_mode(),
        "sources": settings.source_status(),
        "database": db_status(),
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
        item["historical_attack_rate"] = round(predictor.pool_prior(item["pool_id"]), 4)
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
    report.pop("feature_medians", None)
    return report


@app.get("/api/methodology")
def methodology() -> dict[str, Any]:
    return {
        "sources": settings.source_status(),
        "bigquery_sql": describe_queries(),
        "detection": {
            "pattern": "front-run / victim / back-run within one block and pool",
            "criteria": [
                "attacker address identical on the front-run and back-run legs",
                "back-run unwinds the front-run position to within 2%",
                "victim trades the same direction, between the two legs",
                "the attacker's round trip is profitable",
            ],
            "loss_measurement": (
                "the victim's output is recomputed against pre-attack reserves, so the "
                "loss is measured rather than assumed"
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


# The model trained on live Solana flow only sets the headline probability once
# it has seen enough real victims and scores well on a chronological holdout.
# Below that it is reported next to the simulator's figure as provisional.
LIVE_MIN_POSITIVES = 100
LIVE_MIN_AUC = 0.6


def _pool_quote(pool: dict[str, Any]) -> str:
    """Quote asset from a registry symbol: 'BONK/SOL' -> SOL, 'SOL/USDC Whirlpool' -> USDC."""
    return pool["symbol"].split("/")[-1].split()[0].upper()


def _live_market_estimate(pool: dict[str, Any], req: AnalyzeRequest, hour: int) -> dict[str, Any] | None:
    """What real Solana mainnet flow says about a trade like this one.

    The live model sees size, pool depth, direction, hour and quote asset -- all
    observable on-chain -- but not the victim's slippage tolerance, which never
    appears in balance changes. It estimates the risk for trades like this at the
    tolerances real traders actually use; the closed-form economics then carry
    that level across the slippage sweep.
    """
    if pool["chain"] != "solana":
        return None
    info = live_model.info()
    if info is None:
        return None
    p = live_model.predict(
        size_usd=req.notional_usd,
        depth_usd=pool["tvl_usd"] / 2.0,  # quote-side depth of a balanced pool
        side="buy",
        hour_utc=hour,
        quote_symbol=_pool_quote(pool),
    )
    if p is None:
        return None
    auc = (info.get("metrics") or {}).get("roc_auc")
    positives = int(info.get("positives") or 0)
    drives = positives >= LIVE_MIN_POSITIVES and auc is not None and auc >= LIVE_MIN_AUC
    return {
        "p_attack": round(p, 6),
        "rows": info.get("rows"),
        "positives": positives,
        "weighted_swaps": info.get("weighted_swaps"),
        "trained_at": info.get("trained_at"),
        "window_end": (info.get("window") or {}).get("end"),
        "roc_auc": auc,
        "drives_headline": drives,
        "why_provisional": None if drives else (
            f"needs {LIVE_MIN_POSITIVES} real victims and a holdout AUC of at least {LIVE_MIN_AUC} "
            f"(has {positives} victims, AUC {auc if auc is not None else 'not yet measurable'})"
        ),
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

    # --- 1b. real mainnet flow ------------------------------------------
    # Once the model trained on live Solana data has earned it, it sets the
    # probability. The simulator's figure is kept alongside for comparison, and
    # the explanation switches to the live model so it describes the number shown.
    live_market = _live_market_estimate(pool, req, hour)
    if live_market and live_market["drives_headline"]:
        p_real = live_market["p_attack"]
        ml = {
            **ml,
            "simulated_p_attack": ml["p_attack"],
            "p_attack": p_real,
            "risk_band": risk_band(p_real),
            "expected_loss_usd": round(
                p_real * (ml["expected_loss_bps_if_attacked"] / 10_000.0) * req.notional_usd, 4
            ),
            "drivers": live_model.explain(
                req.notional_usd, pool["tvl_usd"] / 2.0, "buy", hour, _pool_quote(pool)
            ),
            "model": "logistic regression on real Solana mainnet swaps",
            "source": "live-mainnet",
        }

    # --- 2. fuse: hold the model's searcher presence fixed across the sweep
    ctx.bot_activity = calibrate_bot_activity(ctx, req.slippage_bps / 10_000.0, ml["p_attack"])

    # --- 3. economics at the current setting ----------------------------
    r_in, r_out = ctx.reserves
    a_unc = unconstrained_frontrun(ctx.size_in, r_in, r_out, ctx.gamma)
    current_s = req.slippage_bps / 10_000.0
    current_outcome = optimal_sandwich(
        ctx.size_in, r_in, r_out, current_s, ctx.price_in_usd, ctx.attack_cost_usd,
        ctx.gamma, a_unconstrained=a_unc,
    )

    # --- 4. sweet spot and splitting ------------------------------------
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
            "data_source": "simulated" if not settings.helius_live and not settings.bigquery_live else "mixed",
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
                    f"-- {outcome.victim_loss_bps:.0f}bp worse"
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
