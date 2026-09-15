"""Offline swap-and-attack simulator.

This exists so the pipeline is runnable and testable without a Helius key or a
GCP billing account. It is a *simulator*, not a dataset, and everything it
produces is labelled `simulated` end to end so no number reaches the UI dressed
up as chain data.

It is not random noise either. Blocks are built from the same constant-product
economics the rest of the system uses: a searcher attacks when the closed-form
profit clears its bundle bid and a bot is watching that pool. The latent
variables the model has to recover (searcher presence, congestion, per-pool
competition) are hidden from the feature set, which is what makes the learned
model do real work rather than invert a formula it was handed.

Distributions are anchored to published MEV research (Flashbots' MEV-Explore,
EigenPhi and Jito's public bundle statistics) for orders of magnitude: retail
trade sizes are log-normal around a few hundred dollars, wallet slippage
defaults cluster hard at 50bp/100bp/300bp, and only a minority of flow routes
through private relays.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Iterator

from ..core.amm import optimal_sandwich, reserves_from_tvl, swap_out
from ..core.features import build_features
from ..detection.sandwich import Swap


# --------------------------------------------------------------------------
# pool universe
# --------------------------------------------------------------------------

@dataclass
class PoolSpec:
    pool_id: str
    chain: str
    symbol: str
    tvl_usd: float
    fee_bps: float
    volatility_24h: float
    price_in_usd: float
    bot_presence: float          # latent: how closely searchers watch this pool
    swaps_per_block: float
    is_stable_pair: bool = False
    token_age_days: float = 365.0


def default_universe() -> list[PoolSpec]:
    """A pool set spanning the regimes that actually differ in risk."""
    return [
        # deep majors: high flow, but 30bp fee drag makes small sandwiches unprofitable
        PoolSpec("uni-v2-weth-usdc", "ethereum", "WETH/USDC", 42_000_000, 30, 0.035, 3000, 0.85, 4.2, token_age_days=2500),
        PoolSpec("uni-v3-weth-usdc-5", "ethereum", "WETH/USDC .05%", 180_000_000, 5, 0.035, 3000, 0.92, 9.5, token_age_days=1800),
        PoolSpec("uni-v3-wbtc-weth-30", "ethereum", "WBTC/WETH", 65_000_000, 30, 0.030, 3000, 0.78, 2.1, token_age_days=1800),
        PoolSpec("uni-v3-usdc-usdt-1", "ethereum", "USDC/USDT", 90_000_000, 1, 0.002, 1, 0.70, 3.4, is_stable_pair=True, token_age_days=1800),
        # mid-tier: the sweet spot for searchers
        PoolSpec("uni-v2-pepe-weth", "ethereum", "PEPE/WETH", 8_500_000, 30, 0.130, 3000, 0.88, 3.1, token_age_days=700),
        PoolSpec("uni-v3-link-weth-30", "ethereum", "LINK/WETH", 12_000_000, 30, 0.055, 3000, 0.72, 1.4, token_age_days=2000),
        PoolSpec("uni-v2-shib-weth", "ethereum", "SHIB/WETH", 3_200_000, 30, 0.110, 3000, 0.80, 1.9, token_age_days=1200),
        # thin and dangerous
        PoolSpec("uni-v2-longtail-a", "ethereum", "MICRO/WETH", 420_000, 30, 0.260, 3000, 0.65, 0.9, token_age_days=45),
        PoolSpec("uni-v2-longtail-b", "ethereum", "NEWCOIN/WETH", 150_000, 100, 0.380, 3000, 0.55, 0.7, token_age_days=8),
        # solana: sub-second blocks, near-zero fees, Jito bundle economics
        PoolSpec("ray-sol-usdc", "solana", "SOL/USDC", 28_000_000, 25, 0.050, 180, 0.90, 12.0, token_age_days=1500),
        PoolSpec("orca-sol-usdc-wp", "solana", "SOL/USDC Whirlpool", 45_000_000, 4, 0.050, 180, 0.94, 18.0, token_age_days=1200),
        PoolSpec("ray-bonk-sol", "solana", "BONK/SOL", 6_000_000, 25, 0.180, 180, 0.86, 6.5, token_age_days=600),
        PoolSpec("ray-wif-sol", "solana", "WIF/SOL", 4_100_000, 25, 0.210, 180, 0.84, 5.2, token_age_days=400),
        PoolSpec("pump-newmint-a", "solana", "PUMPCOIN/SOL", 180_000, 25, 0.450, 180, 0.72, 3.0, token_age_days=2),
        PoolSpec("pump-newmint-b", "solana", "MEMEV2/SOL", 60_000, 25, 0.520, 180, 0.60, 2.2, token_age_days=1),
    ]


# --------------------------------------------------------------------------
# behavioural draws
# --------------------------------------------------------------------------

# wallet slippage defaults cluster on preset buttons rather than spreading out
SLIPPAGE_PRESETS = [10, 30, 50, 50, 50, 100, 100, 200, 300, 300, 500, 1000]


def draw_slippage_bps(rng: random.Random, chain: str, volatility: float) -> float:
    """Retail slippage: mostly a preset, occasionally hand-typed."""
    if rng.random() < 0.78:
        base = rng.choice(SLIPPAGE_PRESETS)
    else:
        base = rng.lognormvariate(math.log(120), 0.9)
    # volatile pools push people to widen tolerance until trades stop failing
    base *= 1.0 + min(volatility * 2.5, 2.5)
    if chain == "solana":
        base *= 1.35  # Solana wallets ship wider defaults
    return float(min(max(base, 5.0), 5000.0))


def draw_notional_usd(rng: random.Random) -> float:
    """Retail flow: log-normal, median a few hundred dollars, a long whale tail."""
    value = rng.lognormvariate(math.log(400.0), 1.65)
    return float(min(max(value, 15.0), 2_000_000.0))


def congestion_multiplier(rng: random.Random, hour: int) -> float:
    """Diurnal gas cycle plus bursts. US afternoon is the expensive window."""
    diurnal = 1.0 + 0.45 * math.sin(2.0 * math.pi * ((hour - 9) % 24) / 24.0)
    burst = 2.4 if rng.random() < 0.06 else 1.0
    return diurnal * burst * rng.lognormvariate(0.0, 0.25)


# --------------------------------------------------------------------------
# block simulation
# --------------------------------------------------------------------------

@dataclass
class SimulatedTrade:
    """One victim-side swap plus the ground truth of what happened to it."""

    pool: PoolSpec
    block: int
    hour: int
    notional_usd: float
    slippage_bps: float
    attack_cost_usd: float
    private_relay: bool
    swaps_per_block: float
    sandwiched: bool
    realised_loss_bps: float
    realised_loss_usd: float
    attacker_profit_usd: float
    frontrun_usd: float = 0.0
    reverted: bool = False


def _attack_cost(pool: PoolSpec, rng: random.Random, hour: int) -> float:
    """Searcher's cost of playing: gas plus the bid they must win the slot with."""
    if pool.chain == "solana":
        base = 0.9   # Jito tip floor, dollars
    else:
        base = 14.0  # ~2 txs of gas plus a competitive builder payment
    return base * congestion_multiplier(rng, hour)


def simulate_block(
    pool: PoolSpec,
    block: int,
    hour: int,
    rng: random.Random,
) -> list[SimulatedTrade]:
    """Simulate the retail swaps landing in one pool in one block."""
    n_swaps = max(1, int(rng.gauss(pool.swaps_per_block, pool.swaps_per_block * 0.4)))
    r_in, r_out = reserves_from_tvl(pool.tvl_usd, pool.price_in_usd, 1.0)
    gamma = 1.0 - pool.fee_bps / 10_000.0
    trades: list[SimulatedTrade] = []

    for _ in range(n_swaps):
        notional = draw_notional_usd(rng)
        slippage = draw_slippage_bps(rng, pool.chain, pool.volatility_24h)
        cost = _attack_cost(pool, rng, hour)
        # private routing: growing but still a minority of retail flow
        private = rng.random() < (0.14 if pool.chain == "ethereum" else 0.22)

        size_in = notional / pool.price_in_usd
        outcome = optimal_sandwich(
            size_in, r_in, r_out, slippage / 10_000.0, pool.price_in_usd, cost, gamma
        )

        # --- the latent decision the model has to learn to predict ---
        watching = rng.random() < pool.bot_presence
        # searchers are not perfect: latency losses, inventory limits, lost auctions
        wins_auction = rng.random() < 0.72
        profitable = outcome.attacker_profit_usd > 0
        sandwiched = bool(watching and wins_auction and profitable and not private)

        loss_bps = 0.0
        loss_usd = 0.0
        if sandwiched:
            # competition sometimes leaves part of the tolerance unused
            capture = min(1.0, max(0.55, rng.gauss(0.92, 0.12)))
            loss_bps = outcome.victim_loss_bps * capture
            loss_usd = outcome.victim_loss_usd * capture

        # tolerance too tight for the pool's volatility -> revert
        sigma = pool.volatility_24h * math.sqrt(
            (0.4 if pool.chain == "solana" else 12.0) * 2 / 86_400.0
        )
        reverted = (not sandwiched) and (rng.gauss(0.0, sigma) < -(slippage / 10_000.0))

        trades.append(
            SimulatedTrade(
                pool=pool,
                block=block,
                hour=hour,
                notional_usd=notional,
                slippage_bps=slippage,
                attack_cost_usd=cost,
                private_relay=private,
                swaps_per_block=float(n_swaps),
                sandwiched=sandwiched,
                realised_loss_bps=loss_bps,
                realised_loss_usd=loss_usd,
                attacker_profit_usd=outcome.attacker_profit_usd if sandwiched else 0.0,
                frontrun_usd=outcome.frontrun_size_usd if sandwiched else 0.0,
                reverted=reverted,
            )
        )
    return trades


def generate_trades(
    n_blocks: int = 4000,
    seed: int = 7,
    universe: list[PoolSpec] | None = None,
) -> list[SimulatedTrade]:
    """Simulate a swap corpus across the pool universe."""
    rng = random.Random(seed)
    universe = universe or default_universe()
    trades: list[SimulatedTrade] = []
    for block in range(n_blocks):
        hour = (block // 300) % 24
        for pool in universe:
            if rng.random() > 0.55:      # not every pool trades every block
                continue
            trades.extend(simulate_block(pool, block, hour, rng))
    return trades


# --------------------------------------------------------------------------
# training frame
# --------------------------------------------------------------------------

def trades_to_rows(trades: list[SimulatedTrade]) -> list[dict[str, Any]]:
    """Feature rows + labels, using the same builder the API serves with.

    `pool_attack_rate_prior` is computed from the pool's realised attack rate.
    In production this comes from a rolling historical window; here it is
    derived from the same corpus, which is why `ml.train` fits it on the
    training split only and carries it forward to test.
    """
    rows: list[dict[str, Any]] = []
    for t in trades:
        feats = build_features(
            notional_usd=t.notional_usd,
            pool_tvl_usd=t.pool.tvl_usd,
            slippage_bps=t.slippage_bps,
            fee_bps=t.pool.fee_bps,
            volatility_24h=t.pool.volatility_24h,
            attack_cost_usd=t.attack_cost_usd,
            price_in_usd=t.pool.price_in_usd,
            swaps_per_block=t.swaps_per_block,
            is_private_relay=t.private_relay,
            chain=t.pool.chain,
            is_stable_pair=t.pool.is_stable_pair,
            token_age_days=t.pool.token_age_days,
            hour_of_day=t.hour,
            pool_attack_rate_prior=0.0,  # filled in by the trainer, fold-safe
        )
        feats.update(
            {
                "pool_id": t.pool.pool_id,
                "chain": t.pool.chain,
                "block": t.block,
                "notional_usd": t.notional_usd,
                "label_sandwiched": int(t.sandwiched),
                "label_loss_bps": t.realised_loss_bps,
                "label_loss_usd": t.realised_loss_usd,
                "label_reverted": int(t.reverted),
            }
        )
        rows.append(feats)
    return rows


# --------------------------------------------------------------------------
# swap-stream simulation, for validating the detector
# --------------------------------------------------------------------------

def generate_swap_stream(
    n_blocks: int = 300, seed: int = 11, universe: list[PoolSpec] | None = None
) -> tuple[list[Swap], set[str]]:
    """Emit a raw swap stream with real attacker legs woven in.

    Returns the swaps plus the set of victim tx hashes that were genuinely
    sandwiched, so `detection.detect_sandwiches` can be scored against ground
    truth. That is the test that matters for the detector: it is the same code
    that will label live Helius and BigQuery data.
    """
    rng = random.Random(seed)
    universe = universe or default_universe()
    swaps: list[Swap] = []
    truth: set[str] = set()
    counter = 0

    for block in range(n_blocks):
        hour = (block // 60) % 24
        for pool in universe:
            if rng.random() > 0.5:
                continue
            r_in, r_out = reserves_from_tvl(pool.tvl_usd, pool.price_in_usd, 1.0)
            gamma = 1.0 - pool.fee_bps / 10_000.0
            tx_index = 0
            for trade in simulate_block(pool, block, hour, rng):
                counter += 1
                victim_hash = f"0xv{counter:08x}"
                size_in = trade.notional_usd / pool.price_in_usd

                if trade.sandwiched:
                    attacker = f"0xATTACKER{rng.randint(1, 6)}"
                    out = optimal_sandwich(
                        size_in, r_in, r_out, trade.slippage_bps / 10_000.0,
                        pool.price_in_usd, trade.attack_cost_usd, gamma,
                    )
                    a = out.frontrun_size
                    acquired = swap_out(a, r_in, r_out, gamma)
                    rx1, ry1 = r_in + a, r_out - acquired

                    swaps.append(Swap(
                        chain=pool.chain, block=block, tx_index=tx_index, tx_hash=f"0xf{counter:08x}",
                        pool_id=pool.pool_id, trader=attacker, token_in="A", token_out="B",
                        amount_in=a, amount_out=acquired, reserve_in=r_in, reserve_out=r_out,
                        fee_bps=pool.fee_bps, amount_in_usd=a * pool.price_in_usd,
                        bundle_id=f"bundle{counter}",
                    ))
                    tx_index += 1

                    victim_out = swap_out(size_in, rx1, ry1, gamma)
                    swaps.append(Swap(
                        chain=pool.chain, block=block, tx_index=tx_index, tx_hash=victim_hash,
                        pool_id=pool.pool_id, trader=f"0xUSER{counter}", token_in="A", token_out="B",
                        amount_in=size_in, amount_out=victim_out,
                        fee_bps=pool.fee_bps, amount_in_usd=trade.notional_usd,
                    ))
                    tx_index += 1
                    truth.add(victim_hash)

                    rx2, ry2 = rx1 + size_in, ry1 - victim_out
                    returned = swap_out(acquired, ry2, rx2, gamma)
                    swaps.append(Swap(
                        chain=pool.chain, block=block, tx_index=tx_index, tx_hash=f"0xb{counter:08x}",
                        pool_id=pool.pool_id, trader=attacker, token_in="B", token_out="A",
                        amount_in=acquired, amount_out=returned,
                        fee_bps=pool.fee_bps, amount_in_usd=trade.notional_usd,
                        bundle_id=f"bundle{counter}",
                    ))
                    tx_index += 1
                else:
                    swaps.append(Swap(
                        chain=pool.chain, block=block, tx_index=tx_index, tx_hash=victim_hash,
                        pool_id=pool.pool_id, trader=f"0xUSER{counter}", token_in="A", token_out="B",
                        amount_in=size_in, amount_out=swap_out(size_in, r_in, r_out, gamma),
                        reserve_in=r_in, reserve_out=r_out,
                        fee_bps=pool.fee_bps, amount_in_usd=trade.notional_usd,
                    ))
                    tx_index += 1

    return swaps, truth
