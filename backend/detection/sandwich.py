"""Sandwich detection over raw swap streams.

This is the labeller. Whatever the source (Helius for Solana, BigQuery for
Ethereum), swaps are normalised into `Swap` records and scanned for the
front-run / victim / back-run pattern. Every confirmed sandwich becomes one
training row, and the victim's counterfactual output is reconstructed so the
realised loss is a measured quantity rather than an assumption.

The pattern being matched, within a single block and a single pool:

    tx[i]  attacker buys  X   (front-run, pushes price up)
    tx[j]  victim   buys  X   (fills at the worsened price)
    tx[k]  attacker sells X   (back-run, captures the difference)

with i < j < k, attacker[i] == attacker[k], and the size the attacker unwinds
in the back-run matching what the front-run acquired.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable

from ..core.amm import swap_out


# --------------------------------------------------------------------------
# normalised input
# --------------------------------------------------------------------------

@dataclass
class Swap:
    """One DEX swap, normalised across chains."""

    chain: str                 # "ethereum" | "solana"
    block: int                 # block number / slot
    tx_index: int              # position within the block: ordering is the whole game
    tx_hash: str
    pool_id: str
    trader: str                # EOA on Ethereum, fee payer on Solana
    token_in: str
    token_out: str
    amount_in: float
    amount_out: float
    timestamp: int = 0
    # optional pool state, when the source provides it
    reserve_in: float | None = None
    reserve_out: float | None = None
    fee_bps: float = 30.0
    amount_in_usd: float = 0.0
    bundle_id: str | None = None   # Jito bundle / Flashbots bundle, when known

    @property
    def direction(self) -> tuple[str, str]:
        return (self.token_in, self.token_out)

    @property
    def price(self) -> float:
        return self.amount_out / self.amount_in if self.amount_in else 0.0


@dataclass
class SandwichEvent:
    """A confirmed sandwich, with the victim's loss reconstructed."""

    chain: str
    block: int
    pool_id: str
    attacker: str
    victim: str
    frontrun_tx: str
    victim_tx: str
    backrun_tx: str
    victim_amount_in: float
    victim_amount_in_usd: float
    victim_out_actual: float
    victim_out_counterfactual: float
    victim_loss_bps: float
    victim_loss_usd: float
    attacker_profit_native: float
    attacker_profit_usd: float
    frontrun_amount_in: float
    confidence: float
    timestamp: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------
# reserve reconstruction
# --------------------------------------------------------------------------

def _infer_reserves(sw: Swap) -> tuple[float, float] | None:
    """Pool reserves for a swap, when the indexer supplied them.

    Reserves cannot be recovered from a single swap: out = Ry*g*dx/(Rx + g*dx)
    is one equation in two unknowns, and a second observation at a different
    size would be needed to pin the depth. Rather than guess, this returns None
    and the caller falls back to the price-ratio estimate, which is honest about
    being an approximation. Helius supplies pool state directly; the BigQuery
    path can join `crypto_ethereum.token_transfers` at the same block to fill it
    in, at the cost of a much larger scan.
    """
    if sw.reserve_in is not None and sw.reserve_out is not None:
        return sw.reserve_in, sw.reserve_out
    return None


def _counterfactual_out(
    victim: Swap,
    frontrun: Swap,
    reserves: tuple[float, float] | None,
) -> float:
    """What the victim would have received with no attacker in the block.

    With pool state we replay the block minus the front-run leg. Without it we
    fall back on the price ratio between the attacker's fill and the victim's
    fill: the front-run executed against the clean pool, so its realised price
    is a good estimate of the price the victim should have got.
    """
    gamma = 1.0 - victim.fee_bps / 10_000.0

    if reserves is not None:
        r_in, r_out = reserves
        return swap_out(victim.amount_in, r_in, r_out, gamma)

    # fallback: the front-runner bought into the untouched pool, so its
    # execution price bounds what the victim should have seen
    if frontrun.amount_in > 0 and frontrun.price > 0:
        return victim.amount_in * frontrun.price
    return victim.amount_out


# --------------------------------------------------------------------------
# the scan
# --------------------------------------------------------------------------

def detect_sandwiches(
    swaps: Iterable[Swap],
    size_match_tolerance: float = 0.02,
    min_victim_usd: float = 10.0,
    price_usd: dict[str, float] | None = None,
) -> list[SandwichEvent]:
    """Scan a swap stream for sandwiches.

    `size_match_tolerance` is how closely the back-run must unwind the front-run
    position. Searchers unwind exactly; a loose match invites false positives
    from unrelated round-trip traders, and 2% is the band that separates them in
    practice while tolerating fee and rounding drift.
    """
    price_usd = price_usd or {}
    groups: dict[tuple[int, str], list[Swap]] = defaultdict(list)
    for sw in swaps:
        groups[(sw.block, sw.pool_id)].append(sw)

    events: list[SandwichEvent] = []

    for (block, pool_id), block_swaps in groups.items():
        if len(block_swaps) < 3:
            continue
        block_swaps.sort(key=lambda s: s.tx_index)

        # index candidate back-runs by trader so the inner scan stays linear-ish
        by_trader: dict[str, list[int]] = defaultdict(list)
        for idx, sw in enumerate(block_swaps):
            by_trader[sw.trader].append(idx)

        for i, front in enumerate(block_swaps):
            back_candidates = [k for k in by_trader[front.trader] if k > i + 1]
            if not back_candidates:
                continue

            for k in back_candidates:
                back = block_swaps[k]
                # the back-run must be the reverse leg of the front-run
                if (back.token_in, back.token_out) != (front.token_out, front.token_in):
                    continue
                # and it must unwind roughly the position the front-run opened
                if front.amount_out <= 0:
                    continue
                size_drift = abs(back.amount_in - front.amount_out) / front.amount_out
                if size_drift > size_match_tolerance:
                    continue

                # every non-attacker swap in the same direction between the legs
                # is a victim of this sandwich
                victims = [
                    block_swaps[j]
                    for j in range(i + 1, k)
                    if block_swaps[j].trader != front.trader
                    and (block_swaps[j].token_in, block_swaps[j].token_out) == front.direction
                ]
                if not victims:
                    continue

                profit_native = back.amount_out - front.amount_in
                if profit_native <= 0:
                    continue  # a losing round trip is not an attack, it is a mistake

                unit_usd = price_usd.get(front.token_in, 0.0)

                for victim in victims:
                    if victim.amount_in_usd and victim.amount_in_usd < min_victim_usd:
                        continue

                    reserves = _infer_reserves(front)
                    cf_out = _counterfactual_out(victim, front, reserves)
                    if cf_out <= 0:
                        continue

                    loss_frac = max(0.0, (cf_out - victim.amount_out) / cf_out)
                    victim_usd = victim.amount_in_usd or (victim.amount_in * unit_usd)

                    events.append(
                        SandwichEvent(
                            chain=victim.chain,
                            block=block,
                            pool_id=pool_id,
                            attacker=front.trader,
                            victim=victim.trader,
                            frontrun_tx=front.tx_hash,
                            victim_tx=victim.tx_hash,
                            backrun_tx=back.tx_hash,
                            victim_amount_in=victim.amount_in,
                            victim_amount_in_usd=victim_usd,
                            victim_out_actual=victim.amount_out,
                            victim_out_counterfactual=cf_out,
                            victim_loss_bps=loss_frac * 10_000.0,
                            victim_loss_usd=loss_frac * victim_usd,
                            attacker_profit_native=profit_native,
                            attacker_profit_usd=profit_native * unit_usd,
                            frontrun_amount_in=front.amount_in,
                            confidence=_confidence(front, back, size_drift, len(victims)),
                            timestamp=victim.timestamp,
                        )
                    )
                break  # one back-run per front-run leg

    return events


def _confidence(front: Swap, back: Swap, size_drift: float, n_victims: int) -> float:
    """How sure we are this is a searcher and not a coincidence.

    Same-block round trips by one address are already rare; an exact unwind and
    a shared bundle id make it near-certain.
    """
    score = 0.55
    score += 0.25 * (1.0 - min(size_drift / 0.02, 1.0))   # tighter unwind, higher score
    if front.bundle_id and front.bundle_id == back.bundle_id:
        score += 0.15
    if n_victims == 1:
        score += 0.05                                      # clean two-leg wrap
    if back.tx_index == front.tx_index + 2:
        score += 0.05                                      # perfectly adjacent
    return round(min(score, 0.99), 3)


# --------------------------------------------------------------------------
# aggregate statistics for the dashboard
# --------------------------------------------------------------------------

@dataclass
class PoolRisk:
    pool_id: str
    chain: str
    swaps: int = 0
    sandwiched: int = 0
    total_victim_loss_usd: float = 0.0
    total_attacker_profit_usd: float = 0.0
    loss_bps_samples: list[float] = field(default_factory=list)

    @property
    def attack_rate(self) -> float:
        return self.sandwiched / self.swaps if self.swaps else 0.0

    @property
    def median_loss_bps(self) -> float:
        if not self.loss_bps_samples:
            return 0.0
        s = sorted(self.loss_bps_samples)
        return s[len(s) // 2]


def aggregate_pool_risk(swaps: Iterable[Swap], events: Iterable[SandwichEvent]) -> dict[str, PoolRisk]:
    """Per-pool attack rates: the empirical prior the ML model starts from."""
    stats: dict[str, PoolRisk] = {}
    for sw in swaps:
        st = stats.setdefault(sw.pool_id, PoolRisk(pool_id=sw.pool_id, chain=sw.chain))
        st.swaps += 1
    for ev in events:
        st = stats.setdefault(ev.pool_id, PoolRisk(pool_id=ev.pool_id, chain=ev.chain))
        st.sandwiched += 1
        st.total_victim_loss_usd += ev.victim_loss_usd
        st.total_attacker_profit_usd += ev.attacker_profit_usd
        st.loss_bps_samples.append(ev.victim_loss_bps)
    return stats
