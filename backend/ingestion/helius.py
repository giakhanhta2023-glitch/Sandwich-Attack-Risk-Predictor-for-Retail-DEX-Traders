"""Solana swap ingestion via Helius.

Two paths, both normalising into `detection.sandwich.Swap`:

  * `fetch_pool_swaps` -- signatures for a pool account, then the Enhanced
    Transactions API, which returns Helius' parsed `tokenTransfers` and swap
    events so we do not have to decode Raydium/Orca instruction data ourselves.
  * `fetch_slot_swaps` -- a whole slot at a time via `getBlock`, which is what
    you want for detection, because sandwich detection needs *every* swap in a
    slot in execution order, not just the ones touching one pool.

Intra-slot ordering is the critical field. Solana has no public mempool, so
sandwiches are built inside Jito bundles; the ordering that matters is the
position in the slot's transaction list, which is what `tx_index` carries.
"""

from __future__ import annotations

import time
from typing import Any, Iterable

import httpx

from ..app.config import settings
from ..detection.sandwich import Swap

ENHANCED_TX_URL = "https://api.helius.xyz/v0/transactions"

# the AMM programs worth watching -- these route the overwhelming majority of
# retail Solana swap flow
DEX_PROGRAMS = {
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
    "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY": "Phoenix",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
}

WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


class HeliusClient:
    """Thin Helius client. Only the calls this project actually needs."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self.api_key = api_key or settings.helius_api_key
        self.rpc_url = settings.solana_rpc()
        self._client = httpx.Client(timeout=timeout)

    @property
    def live(self) -> bool:
        return bool(self.api_key or settings.helius_rpc_url)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HeliusClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---------------- raw RPC ----------------

    def _rpc(self, method: str, params: list[Any]) -> Any:
        payload = {"jsonrpc": "2.0", "id": "sarp", "method": method, "params": params}
        resp = self._client.post(self.rpc_url, json=payload)
        resp.raise_for_status()
        body = resp.json()
        if "error" in body:
            raise RuntimeError(f"Helius RPC error on {method}: {body['error']}")
        return body.get("result")

    def latest_slot(self) -> int:
        return int(self._rpc("getSlot", [{"commitment": "confirmed"}]))

    def get_block(self, slot: int) -> dict[str, Any] | None:
        try:
            return self._rpc(
                "getBlock",
                [
                    slot,
                    {
                        "encoding": "jsonParsed",
                        "maxSupportedTransactionVersion": 0,
                        "transactionDetails": "full",
                        "rewards": False,
                    },
                ],
            )
        except RuntimeError:
            return None  # skipped slots are normal on Solana

    def signatures_for_address(self, address: str, limit: int = 100) -> list[dict[str, Any]]:
        return self._rpc("getSignaturesForAddress", [address, {"limit": limit}]) or []

    # ---------------- enhanced (parsed) transactions ----------------

    def parsed_transactions(self, signatures: list[str]) -> list[dict[str, Any]]:
        """Helius Enhanced Transactions -- decoded swaps, 100 signatures a call."""
        if not self.api_key:
            raise RuntimeError("Enhanced Transactions API requires HELIUS_API_KEY")
        out: list[dict[str, Any]] = []
        for i in range(0, len(signatures), 100):
            batch = signatures[i : i + 100]
            resp = self._client.post(
                ENHANCED_TX_URL,
                params={"api-key": self.api_key},
                json={"transactions": batch},
            )
            resp.raise_for_status()
            out.extend(resp.json())
            time.sleep(0.12)  # stay inside the free-tier rate limit
        return out


# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------

def _swap_from_enhanced(tx: dict[str, Any], tx_index: int, prices: dict[str, float]) -> Swap | None:
    """Turn one Helius enhanced transaction into a normalised Swap.

    Helius exposes swaps under `events.swap` with token inputs and outputs
    already netted; when that is missing we fall back to the raw token transfer
    list and net the fee payer's position ourselves.
    """
    signature = tx.get("signature", "")
    slot = int(tx.get("slot", 0))
    ts = int(tx.get("timestamp", 0))
    fee_payer = tx.get("feePayer", "")

    swap_event = (tx.get("events") or {}).get("swap")
    token_in = token_out = None
    amount_in = amount_out = 0.0

    if swap_event:
        inputs = swap_event.get("tokenInputs") or []
        outputs = swap_event.get("tokenOutputs") or []
        native_in = swap_event.get("nativeInput") or {}
        native_out = swap_event.get("nativeOutput") or {}

        if inputs:
            token_in = inputs[0].get("mint")
            raw = inputs[0].get("rawTokenAmount", {})
            amount_in = _scaled(raw)
        elif native_in:
            token_in, amount_in = WSOL, float(native_in.get("amount", 0)) / 1e9

        if outputs:
            token_out = outputs[0].get("mint")
            raw = outputs[0].get("rawTokenAmount", {})
            amount_out = _scaled(raw)
        elif native_out:
            token_out, amount_out = WSOL, float(native_out.get("amount", 0)) / 1e9

    if not token_in or not token_out or amount_in <= 0 or amount_out <= 0:
        return None

    pool_id = ""
    for instr in tx.get("instructions", []) or []:
        if instr.get("programId") in DEX_PROGRAMS:
            accounts = instr.get("accounts") or []
            pool_id = accounts[1] if len(accounts) > 1 else instr.get("programId", "")
            break
    if not pool_id:
        pool_id = f"{token_in[:6]}-{token_out[:6]}"

    return Swap(
        chain="solana",
        block=slot,
        tx_index=tx_index,
        tx_hash=signature,
        pool_id=pool_id,
        trader=fee_payer,
        token_in=token_in,
        token_out=token_out,
        amount_in=amount_in,
        amount_out=amount_out,
        timestamp=ts,
        fee_bps=25.0,  # Raydium AMM v4 standard tier
        amount_in_usd=amount_in * prices.get(token_in, 0.0),
    )


def _scaled(raw: dict[str, Any]) -> float:
    try:
        return float(raw.get("tokenAmount", 0))
    except (TypeError, ValueError):
        decimals = int(raw.get("decimals", 0) or 0)
        return float(raw.get("rawTokenAmount", 0) or 0) / (10**decimals)


def fetch_pool_swaps(
    pool_address: str,
    limit: int = 200,
    prices: dict[str, float] | None = None,
    client: HeliusClient | None = None,
) -> list[Swap]:
    """Recent swaps touching one pool account, newest first."""
    owns_client = client is None
    client = client or HeliusClient()
    try:
        sigs = [s["signature"] for s in client.signatures_for_address(pool_address, limit=limit)]
        if not sigs:
            return []
        txs = client.parsed_transactions(sigs)
        prices = prices or {}
        swaps: list[Swap] = []
        # order within a slot is what detection keys on, so index per slot
        txs.sort(key=lambda t: (t.get("slot", 0), t.get("signature", "")))
        per_slot: dict[int, int] = {}
        for tx in txs:
            slot = int(tx.get("slot", 0))
            idx = per_slot.get(slot, 0)
            per_slot[slot] = idx + 1
            sw = _swap_from_enhanced(tx, idx, prices)
            if sw:
                swaps.append(sw)
        return swaps
    finally:
        if owns_client:
            client.close()


def fetch_slot_swaps(
    slots: Iterable[int],
    prices: dict[str, float] | None = None,
    client: HeliusClient | None = None,
) -> list[Swap]:
    """Every DEX swap in the given slots, in execution order.

    This is the ingestion path for building a training set: detection needs the
    complete slot, because a sandwich is defined by the transactions *around*
    the victim.
    """
    owns_client = client is None
    client = client or HeliusClient()
    prices = prices or {}
    swaps: list[Swap] = []
    try:
        for slot in slots:
            block = client.get_block(slot)
            if not block:
                continue
            ts = int(block.get("blockTime") or 0)
            for idx, tx in enumerate(block.get("transactions", [])):
                if (tx.get("meta") or {}).get("err"):
                    continue
                sw = _swap_from_block_tx(tx, slot, idx, ts, prices)
                if sw:
                    swaps.append(sw)
        return swaps
    finally:
        if owns_client:
            client.close()


def _swap_from_block_tx(
    tx: dict[str, Any], slot: int, tx_index: int, ts: int, prices: dict[str, float]
) -> Swap | None:
    """Net a swap out of raw pre/post token balances.

    Balance deltas are the robust way to read a swap: they are program-agnostic,
    so a new router or an aggregator hop does not silently drop rows.
    """
    meta = tx.get("meta") or {}
    message = (tx.get("transaction") or {}).get("message") or {}
    account_keys = [
        k.get("pubkey") if isinstance(k, dict) else k for k in message.get("accountKeys", [])
    ]
    if not account_keys:
        return None
    fee_payer = account_keys[0]

    program_ids = {
        instr.get("programId")
        for instr in message.get("instructions", [])
        if isinstance(instr, dict)
    }
    if not (program_ids & set(DEX_PROGRAMS)):
        return None

    pre = {(b["accountIndex"], b["mint"]): float(b["uiTokenAmount"]["uiAmount"] or 0)
           for b in meta.get("preTokenBalances", []) if b.get("owner") == fee_payer}
    post = {(b["accountIndex"], b["mint"]): float(b["uiTokenAmount"]["uiAmount"] or 0)
            for b in meta.get("postTokenBalances", []) if b.get("owner") == fee_payer}

    deltas: dict[str, float] = {}
    for key in set(pre) | set(post):
        mint = key[1]
        deltas[mint] = deltas.get(mint, 0.0) + post.get(key, 0.0) - pre.get(key, 0.0)

    # native SOL moves show up in lamport balances, not token balances
    if meta.get("preBalances") and meta.get("postBalances"):
        lamport_delta = (meta["postBalances"][0] - meta["preBalances"][0] + meta.get("fee", 0)) / 1e9
        if abs(lamport_delta) > 1e-6:
            deltas[WSOL] = deltas.get(WSOL, 0.0) + lamport_delta

    spent = [(m, -d) for m, d in deltas.items() if d < -1e-9]
    received = [(m, d) for m, d in deltas.items() if d > 1e-9]
    if not spent or not received:
        return None

    token_in, amount_in = max(spent, key=lambda x: x[1])
    token_out, amount_out = max(received, key=lambda x: x[1])

    pool_id = f"{token_in[:8]}/{token_out[:8]}"
    return Swap(
        chain="solana",
        block=slot,
        tx_index=tx_index,
        tx_hash=(tx.get("transaction") or {}).get("signatures", [""])[0],
        pool_id=pool_id,
        trader=fee_payer,
        token_in=token_in,
        token_out=token_out,
        amount_in=amount_in,
        amount_out=amount_out,
        timestamp=ts,
        fee_bps=25.0,
        amount_in_usd=amount_in * prices.get(token_in, 0.0),
    )
