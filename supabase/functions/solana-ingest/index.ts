// Live Solana sandwich ingestion.
//
// Runs every minute on pg_cron. Each run:
//   1. scans the two most recent complete leader windows (8 slots) on mainnet;
//   2. reads every DEX transaction from the pools' side -- token vaults whose
//      balances moved -- which works across AMMs, routers and bot contracts;
//   3. flags a sandwich when one attacker moves a vault one way and then back
//      by the same amount (+/-3%), another trader goes the same way in between,
//      both legs land inside one validator's leader window, and the round trip
//      made money;
//   4. records the run, the detections, per-pool counts and a training sample.
//
// A full block is ~6MB and Solana produces ~2.5 a second, so no free tier can
// ingest every block. This is a rolling sample of the newest blocks, and every
// run records exactly what it covered -- including why any block was missed --
// so the dashboard can say so.
//
// Uses Helius when HELIUS_API_KEY is set as a function secret, otherwise the
// public mainnet RPC. Writes with the service role key Supabase injects, so no
// credential is ever stored in code or config.
//
// Deployed as the `solana-ingest` Supabase Edge Function; this file is its source.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const HELIUS_KEY = (Deno.env.get("HELIUS_API_KEY") ?? "").trim();
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.mainnet-beta.solana.com";
const PROVIDER = HELIUS_KEY ? "helius" : "public-rpc";

const WINDOWS_PER_RUN = 2;           // leader windows scanned per run
const SLOTS_PER_WINDOW = 4;          // a leader owns 4 consecutive slots
const STAY_BEHIND_TIP = 8;           // slots, so blocks are available at 'confirmed'
const MIN_SECONDS_BETWEEN_RUNS = 40; // bounds what anyone calling the public URL can cost
const NEGATIVE_SAMPLE_RATE = 0.02;   // share of non-victim swaps kept for training
const AMOUNT_MATCH = 0.03;           // back-run must unwind the front-run to within 3%
const MAX_LEADER_SPAN = SLOTS_PER_WINDOW - 1;
const MIN_CURVE_LAMPORTS = 10_000n;  // smallest SOL move read as a bonding-curve trade
// The public RPC rate-limits by IP over a window of several seconds, so a short
// backoff only hits the same wall again: it gets one request at a time and waits
// long enough for that window to roll over. Every wait is bounded by the run
// budget, which keeps a run well inside the scheduler's 60s timeout.
const FETCH_CONCURRENCY = HELIUS_KEY ? 4 : 1;
const BLOCK_TRIES = HELIUS_KEY ? 4 : 5;
const BACKOFF_MS = HELIUS_KEY ? 500 : 1000;
const RUN_BUDGET_MS = 40_000;

const PUMP_BONDING_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DEX_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",  // Pump.fun AMM
  PUMP_BONDING_CURVE,                               // Pump.fun bonding curve
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter aggregator
]);
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTE_SYMBOL: Record<string, string> = { [WSOL]: "SOL", [USDC]: "USDC", [USDT]: "USDT" };

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Flow = {
  slot: number; tx: number; sig: string; signer: string;
  vault: string; mint: string; dec: number; d: bigint; pre: bigint;
};
type PoolSwap = {
  slot: number; tx: number; sig: string; poolKey: string;
  base: Flow; quote: Flow | null; blockTime: number | null;
  // The trader's end of the base-token flow: the account the bought tokens
  // landed in, or the sold ones left. A bot that rotates fee payers still buys
  // into and sells out of the same token account.
  trader: string | null; traderOwner: string | null;
};
type Moved = { account: string; owner: string; mint: string; dec: number; d: bigint; pre: bigint };

const abs = (x: bigint) => (x < 0n ? -x : x);
const ui = (raw: bigint, dec: number) => Number(raw) / 10 ** dec;
const up = (f: { d: bigint }) => f.d > 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v); else m.set(k, [v]);
}

/** JSON-RPC call with backoff. Gives up rather than wait past `deadline`. */
async function rpc<T>(method: string, params: unknown[], tries = 3, deadline = Infinity): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    let wait = BACKOFF_MS * 2 ** i;
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get("retry-after"));
        if (after > 0) wait = Math.min(after * 1000, 10_000);
        await res.body?.cancel();
        throw new Error(`${method}: HTTP ${res.status}`);
      }
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
      return body.result as T;
    } catch (e) {
      last = e;
      if (i === tries - 1 || Date.now() + wait > deadline) break;
      await sleep(wait);
    }
  }
  throw last;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Pull pool-side vault flows and pool swaps out of one block. */
function extract(
  slot: number,
  block: any,
  flowsByVault: Map<string, Flow[]>,
  swapsByTx: Map<string, PoolSwap[]>,
  swaps: PoolSwap[],
  stats: { txs: number; dexTxs: number },
) {
  const blockTime: number | null = block.blockTime ?? null;
  const txs: any[] = block.transactions ?? [];
  stats.txs += txs.length;

  txs.forEach((tx, idx) => {
    const meta = tx.meta;
    if (!meta || meta.err) return;
    const msg = tx.transaction.message;
    const la = meta.loadedAddresses ?? {};
    const keys: string[] = [...msg.accountKeys, ...(la.writable ?? []), ...(la.readonly ?? [])];
    if (!keys.some((k) => DEX_PROGRAMS.has(k))) return;
    stats.dexTxs++;

    const signers = new Set(keys.slice(0, msg.header.numRequiredSignatures));
    const signer = keys[0];
    const sig: string = tx.transaction.signatures[0];
    const onBondingCurve = keys.includes(PUMP_BONDING_CURVE);
    const pre = new Map<number, any>();
    for (const b of meta.preTokenBalances ?? []) pre.set(b.accountIndex, b);
    const post = new Map<number, any>();
    for (const b of meta.postTokenBalances ?? []) post.set(b.accountIndex, b);

    // Every token account whose balance moved, on both sides of the trade.
    const moved: Moved[] = [];
    for (const ai of new Set([...pre.keys(), ...post.keys()])) {
      const b = post.get(ai) ?? pre.get(ai);
      const pa = BigInt(pre.get(ai)?.uiTokenAmount?.amount ?? "0");
      const qa = BigInt(post.get(ai)?.uiTokenAmount?.amount ?? "0");
      if (pa === qa || !b.owner) continue;
      moved.push({ account: keys[ai], owner: b.owner, mint: b.mint, dec: b.uiTokenAmount?.decimals ?? 0, d: qa - pa, pre: pa });
    }

    // Token accounts not owned by any signer are the pool side of the trade.
    const byOwner = new Map<string, Flow[]>();
    for (const m of moved) {
      if (signers.has(m.owner)) continue;
      const f: Flow = { slot, tx: idx, sig, signer, vault: m.account, mint: m.mint, dec: m.dec, d: m.d, pre: m.pre };
      push(flowsByVault, f.vault, f);
      push(byOwner, m.owner, f);
    }

    // One owner whose vaults moved in exactly two mints, opposite ways, is one
    // pool swap. Fee accounts can share an owner with the vaults, so keep the
    // largest mover per mint.
    for (const [owner, group] of byOwner) {
      const perMint = new Map<string, Flow>();
      for (const f of group) {
        const cur = perMint.get(f.mint);
        if (!cur || abs(f.d) > abs(cur.d)) perMint.set(f.mint, f);
      }
      // A pump.fun bonding curve holds its SOL as the curve account's own
      // lamports rather than in a token account, so its quote side is read
      // from the curve's lamport balance. Without this every bonding-curve
      // trade -- where memecoin launches are fought over -- went unseen.
      if (perMint.size === 1 && onBondingCurve) {
        const [only] = perMint.values();
        const i = keys.indexOf(owner);
        if (i >= 0 && meta.preBalances?.[i] != null && meta.postBalances?.[i] != null) {
          const before = BigInt(meta.preBalances[i]);
          const lamports = BigInt(meta.postBalances[i]) - before;
          if (abs(lamports) >= MIN_CURVE_LAMPORTS && (lamports > 0n) !== up(only)) {
            const sol: Flow = { slot, tx: idx, sig, signer, vault: owner, mint: WSOL, dec: 9, d: lamports, pre: before };
            push(flowsByVault, sol.vault, sol);
            perMint.set(WSOL, sol);
          }
        }
      }
      if (perMint.size !== 2) continue;
      const [a, b] = [...perMint.values()];
      if (up(a) === up(b)) continue;
      const poolKey = [a.vault, b.vault].sort().join(":");
      const quote = QUOTE_SYMBOL[a.mint] ? a : QUOTE_SYMBOL[b.mint] ? b : null;
      const base = quote === a ? b : a;

      let trader: string | null = null;
      let traderOwner: string | null = null;
      let largest = 0n;
      for (const m of moved) {
        if (m.mint !== base.mint || m.account === base.vault || up(m) === up(base)) continue;
        if (abs(m.d) > largest) { largest = abs(m.d); trader = m.account; traderOwner = m.owner; }
      }

      const s: PoolSwap = { slot, tx: idx, sig, poolKey, base, quote, blockTime, trader, traderOwner };
      swaps.push(s);
      push(swapsByTx, `${slot}:${idx}`, s);
    }
  });
}

function swapFor(f: Flow, swapsByTx: Map<string, PoolSwap[]>): PoolSwap | undefined {
  return swapsByTx.get(`${f.slot}:${f.tx}`)?.find((s) => s.base.vault === f.vault || s.quote?.vault === f.vault);
}

type Detection = {
  swap: PoolSwap; back: PoolSwap; front: Flow; backFlow: Flow; victims: Flow[];
  tier: "high" | "medium"; span: number; leader: string | null;
  profitQuote: number; victimQuoteIn: number; ratio: number;
  link: "signer" | "account";
};

function detect(
  flowsByVault: Map<string, Flow[]>,
  swapsByTx: Map<string, PoolSwap[]>,
  leaderOf: (slot: number) => string | undefined,
): Detection[] {
  const out: Detection[] = [];
  for (const [, fl] of flowsByVault) {
    if (fl.length < 3) continue;
    fl.sort((x, y) => x.slot - y.slot || x.tx - y.tx);
    for (let a = 0; a < fl.length; a++) {
      const fi = fl[a];
      const frontSwap = swapFor(fi, swapsByTx);
      for (let k = a + 1; k < Math.min(fl.length, a + 60); k++) {
        const fk = fl[k];
        if (up(fk) === up(fi)) continue;

        // The two legs belong to one attacker when they share a fee payer, or
        // -- for bots that rotate fee payers between legs -- when the position
        // was bought into and sold out of the same token account.
        const backSwap = swapFor(fk, swapsByTx);
        const bySigner = fk.signer === fi.signer;
        const byAccount = !bySigner && !!frontSwap?.trader && frontSwap.trader === backSwap?.trader;
        if (!bySigner && !byAccount) continue;

        const ratio = Number(abs(fk.d)) / Number(abs(fi.d));
        if (ratio < 1 - AMOUNT_MATCH || ratio > 1 + AMOUNT_MATCH) break;

        // A victim is another trader going the same way in between: neither of
        // the attacker's fee payers, and not the attacker's own token account.
        const victims = fl.slice(a + 1, k).filter((m) => {
          if (m.signer === fi.signer || m.signer === fk.signer || up(m) !== up(fi)) return false;
          const ms = swapFor(m, swapsByTx);
          return !(frontSwap?.trader && ms?.trader === frontSwap.trader);
        });
        if (!victims.length) break;

        // Only a leader can order transactions across its own slots, so a
        // round trip spanning two validators is a fast trade, not an attack.
        const span = fk.slot - fi.slot;
        const leader = leaderOf(fi.slot) ?? null;
        if (span > MAX_LEADER_SPAN) break;
        if (span > 0 && (!leader || leader !== leaderOf(fk.slot))) break;

        const front = frontSwap;
        const back = backSwap;
        if (!front || !back || front.poolKey !== back.poolKey || !front.quote || !back.quote) break;

        // Value the round trip from the pool's side: the attacker's net is the
        // negative of the pool's net, with any leftover base valued at the
        // back-run's own execution price. Works whether profit is taken in
        // the quote token or in the base token.
        const netBase = -(front.base.d + back.base.d);
        const netQuote = -(front.quote.d + back.quote.d);
        const backBase = ui(abs(back.base.d), back.base.dec);
        const px = backBase > 0 ? ui(abs(back.quote.d), back.quote.dec) / backBase : 0;
        const profitQuote = ui(netQuote, front.quote.dec) + ui(netBase, front.base.dec) * px;
        if (!(profitQuote > 0)) break; // a losing round trip is a flip, not an attack

        let victimQuoteIn = 0;
        for (const m of victims) {
          const vs = swapFor(m, swapsByTx);
          if (vs && vs.poolKey === front.poolKey && vs.quote) victimQuoteIn += ui(abs(vs.quote.d), vs.quote.dec);
        }

        out.push({
          swap: front, back, front: fi, backFlow: fk, victims,
          tier: span === 0 ? "high" : "medium", span, leader,
          profitQuote, victimQuoteIn, ratio, link: bySigner ? "signer" : "account",
        });
        break;
      }
    }
  }
  return out;
}

function solPrice(swaps: PoolSwap[]): number | null {
  const px: number[] = [];
  for (const s of swaps) {
    if (!s.quote || s.quote.mint !== USDC || s.base.mint !== WSOL) continue;
    const sol = ui(abs(s.base.d), 9);
    if (sol > 0.05) px.push(ui(abs(s.quote.d), 6) / sol);
  }
  if (!px.length) return null;
  px.sort((x, y) => x - y);
  return px[Math.floor(px.length / 2)];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  const { data: last } = await db.from("ingest_runs").select("started_at").order("started_at", { ascending: false }).limit(1);
  if (last?.[0] && (Date.now() - Date.parse(last[0].started_at)) / 1000 < MIN_SECONDS_BETWEEN_RUNS) {
    return json({ skipped: true, reason: `a run started less than ${MIN_SECONDS_BETWEEN_RUNS}s ago` });
  }

  const t0 = performance.now();
  const deadline = Date.now() + RUN_BUDGET_MS;
  const { data: runRow, error: runErr } = await db.from("ingest_runs").insert({ provider: PROVIDER }).select("id").single();
  if (runErr || !runRow) return json({ error: `could not open run: ${runErr?.message}` }, 500);
  const runId: number = runRow.id;

  const stats = { txs: 0, dexTxs: 0 };
  try {
    const tip = await rpc<number>("getSlot", [{ commitment: "confirmed" }]);
    const end = tip - STAY_BEHIND_TIP;
    // newest leader window that has fully closed
    const lastWindowStart = end - (end % SLOTS_PER_WINDOW) - SLOTS_PER_WINDOW;
    const first = lastWindowStart - SLOTS_PER_WINDOW * (WINDOWS_PER_RUN - 1);
    const lastSlot = lastWindowStart + SLOTS_PER_WINDOW - 1;

    const [slots, leaders] = await Promise.all([
      rpc<number[]>("getBlocks", [first, lastSlot, { commitment: "confirmed" }]),
      rpc<string[]>("getSlotLeaders", [first, lastSlot - first + 1]).catch(() => [] as string[]),
    ]);
    const leaderOf = (slot: number) => leaders[slot - first];
    const windowOf = (slot: number) => slot - (slot % SLOTS_PER_WINDOW);

    const flowsByVault = new Map<string, Flow[]>();
    const swapsByTx = new Map<string, PoolSwap[]>();
    const swaps: PoolSwap[] = [];
    let blocksOk = 0;
    const blockTimes = new Map<number, number | null>();
    const blockErrors = new Map<string, number>();
    const brokenWindows = new Set<number>();
    const miss = (slot: number, reason: string) => {
      brokenWindows.add(windowOf(slot));
      blockErrors.set(reason, (blockErrors.get(reason) ?? 0) + 1);
    };

    await mapLimit(slots, FETCH_CONCURRENCY, async (slot) => {
      try {
        const block = await rpc<any>("getBlock", [slot, {
          encoding: "json", maxSupportedTransactionVersion: 0,
          transactionDetails: "full", rewards: false, commitment: "confirmed",
        }], BLOCK_TRIES, deadline);
        if (!block) return miss(slot, "empty block response");
        extract(slot, block, flowsByVault, swapsByTx, swaps, stats);
        blockTimes.set(slot, block.blockTime ?? null);
        blocksOk++;
      } catch (e) {
        miss(slot, String(e instanceof Error ? e.message : e).replace(/^getBlock:\s*/, "").slice(0, 70));
      }
    });

    // A window with a missing block can hide one leg of a sandwich, which would
    // label its victims as clean swaps. Detections are real either way, but the
    // training sample and the per-pool rates only use windows read in full.
    const complete = (slot: number) => !brokenWindows.has(windowOf(slot));

    const sol = solPrice(swaps);
    const found = detect(flowsByVault, swapsByTx, leaderOf);

    const toUsd = (symbol: string, amount: number) =>
      symbol === "SOL" ? (sol ? amount * sol : null) : amount;

    const events = found.map((f) => {
      const symbol = QUOTE_SYMBOL[f.swap.quote!.mint];
      const bt = blockTimes.get(f.front.slot);
      return {
        run_id: runId,
        pool_key: f.swap.poolKey,
        base_mint: f.swap.base.mint,
        quote_mint: f.swap.quote!.mint,
        quote_symbol: symbol,
        tier: f.tier,
        slot_front: f.front.slot,
        slot_back: f.backFlow.slot,
        slot_span: f.span,
        leader: f.leader,
        // for a bot rotating fee payers, its identity is the shared position account's owner
        attacker: f.link === "signer" ? f.front.signer : (f.swap.traderOwner ?? f.swap.trader ?? f.front.signer),
        link: f.link,
        frontrun_tx: f.front.sig,
        backrun_tx: f.backFlow.sig,
        victim_tx: f.victims[0].sig,
        victim_txs: f.victims.map((v) => v.sig),
        victim_count: f.victims.length,
        base_amount: ui(abs(f.swap.base.d), f.swap.base.dec),
        attacker_profit_quote: f.profitQuote,
        attacker_profit_usd: toUsd(symbol, f.profitQuote),
        victim_quote_in: f.victimQuoteIn || null,
        victim_loss_bps_lb: f.victimQuoteIn > 0 ? (f.profitQuote / f.victimQuoteIn) * 10_000 : null,
        confidence: Math.min(0.95,
          (f.tier === "high" ? 0.9 : 0.7) + (Math.abs(1 - f.ratio) < 0.005 ? 0.05 : 0) - (f.link === "account" ? 0.05 : 0)),
        block_time: bt ? new Date(bt * 1000).toISOString() : null,
      };
    });

    // victims, keyed the way samples are keyed
    const victimKeys = new Set<string>();
    for (const f of found) for (const v of f.victims) victimKeys.add(`${v.sig}|${f.swap.poolKey}`);
    // The attacker's own legs are not trades that could have been sandwiched,
    // so they stay out of the per-pool counts and the training sample. Counted
    // as clean swaps, every attack also diluted the rate it was part of.
    const legKeys = new Set<string>();
    for (const f of found) {
      legKeys.add(`${f.front.sig}|${f.swap.poolKey}`);
      legKeys.add(`${f.backFlow.sig}|${f.swap.poolKey}`);
    }
    const counted = (s: PoolSwap) => complete(s.slot) && !legKeys.has(`${s.sig}|${s.poolKey}`);

    // per-pool daily counts, from complete windows only
    const day = new Date().toISOString().slice(0, 10);
    const perPool = new Map<string, any>();
    for (const s of swaps) {
      if (!counted(s)) continue;
      let row = perPool.get(s.poolKey);
      if (!row) {
        row = {
          pool_key: s.poolKey, day, base_mint: s.base.mint, quote_mint: s.quote?.mint ?? null,
          quote_symbol: s.quote ? QUOTE_SYMBOL[s.quote.mint] : null, swaps: 0, sandwiches: 0, quote_volume: 0,
        };
        perPool.set(s.poolKey, row);
      }
      row.swaps += 1;
      if (s.quote) row.quote_volume += ui(abs(s.quote.d), s.quote.dec);
    }
    for (const e of events) {
      if (!complete(e.slot_front)) continue;
      const row = perPool.get(e.pool_key);
      if (row) row.sandwiches += 1;
    }

    // training sample: every victim, plus a weighted share of everyone else
    const samples = [];
    for (const s of swaps) {
      if (!s.quote || !counted(s)) continue;
      const isVictim = victimKeys.has(`${s.sig}|${s.poolKey}`);
      if (!isVictim && Math.random() >= NEGATIVE_SAMPLE_RATE) continue;
      const symbol = QUOTE_SYMBOL[s.quote.mint];
      const amount = ui(abs(s.quote.d), s.quote.dec);
      const depth = ui(s.quote.pre, s.quote.dec);
      samples.push({
        run_id: runId, slot: s.slot, tx_index: s.tx, tx: s.sig, pool_key: s.poolKey,
        base_mint: s.base.mint, quote_mint: s.quote.mint, quote_symbol: symbol,
        side: s.base.d < 0n ? "buy" : "sell",
        quote_amount: amount, quote_usd: toUsd(symbol, amount),
        pool_quote_depth: depth, pool_depth_usd: toUsd(symbol, depth),
        hour_utc: s.blockTime ? new Date(s.blockTime * 1000).getUTCHours() : null,
        is_victim: isVictim, sample_weight: isVictim ? 1 : 1 / NEGATIVE_SAMPLE_RATE,
        block_time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
      });
    }

    const writes = [];
    if (events.length) {
      writes.push(db.from("sandwich_events").upsert(events, { onConflict: "frontrun_tx,backrun_tx", ignoreDuplicates: true }));
    }
    if (perPool.size) writes.push(db.rpc("record_pool_activity", { p_rows: [...perPool.values()] }));
    if (samples.length) {
      writes.push(db.from("swap_samples").upsert(samples, { onConflict: "tx,pool_key", ignoreDuplicates: true }));
    }
    const results = await Promise.all(writes);
    const writeErrors = results.map((r: any) => r.error?.message).filter(Boolean);

    // A partial run says why: which blocks were missed, what the RPC said, and
    // how much of the scan was kept out of training because of it.
    const missed = slots.length - blocksOk;
    const windows = new Set(slots.map(windowOf)).size;
    const missNote = missed
      ? `missed ${missed} of ${slots.length} blocks: ` +
        [...blockErrors].map(([r, n]) => `${r} (x${n})`).join("; ") +
        `; ${brokenWindows.size} of ${windows} leader windows kept out of training`
      : null;

    const summary = {
      status: writeErrors.length ? "error" : missed ? "partial" : "ok",
      finished_at: new Date().toISOString(),
      tip_slot: tip,
      first_slot: first,
      last_slot: lastSlot,
      blocks_requested: slots.length,
      blocks_ok: blocksOk,
      txs: stats.txs,
      dex_txs: stats.dexTxs,
      pool_swaps: swaps.length,
      sandwiches: events.length,
      samples: samples.length,
      sol_usd: sol,
      lag_slots: tip - lastSlot,
      duration_ms: Math.round(performance.now() - t0),
      error: (writeErrors.length ? writeErrors.join("; ") : missNote)?.slice(0, 500) ?? null,
    };
    await db.from("ingest_runs").update(summary).eq("id", runId);

    const { data: cur } = await db.from("ingestion_cursors").select("swaps_ingested,events_detected").eq("source", "solana-live").maybeSingle();
    await db.from("ingestion_cursors").upsert({
      source: "solana-live",
      last_block: lastSlot,
      last_run_at: summary.finished_at,
      swaps_ingested: (cur?.swaps_ingested ?? 0) + swaps.length,
      events_detected: (cur?.events_detected ?? 0) + events.length,
      status: summary.status === "error" ? "error" : "idle",
      last_error: summary.error,
    }, { onConflict: "source" });

    return json({ run_id: runId, provider: PROVIDER, ...summary });
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e).slice(0, 500);
    await db.from("ingest_runs").update({
      status: "error", finished_at: new Date().toISOString(), error: message,
      txs: stats.txs, dex_txs: stats.dexTxs, duration_ms: Math.round(performance.now() - t0),
    }).eq("id", runId);
    return json({ run_id: runId, provider: PROVIDER, status: "error", error: message }, 500);
  }
});
