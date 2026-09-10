import { useEffect, useState } from 'react'

/**
 * Read-only client for the live Solana pipeline.
 *
 * The browser reads Supabase directly with the publishable key. That key is
 * designed to ship in client code: row level security limits it to SELECT on
 * the public research tables, and nothing anywhere grants it a write. Going
 * direct means the dashboard works on any deployment without the API needing
 * database credentials, and every figure on it is the database's own.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const liveConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY)

/** Solana targets a 400ms slot. */
export const SLOT_SECONDS = 0.4

async function rest<T>(path: string): Promise<T> {
  if (!liveConfigured) throw new Error('Live data is not configured for this deployment.')
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY as string },
  })
  if (!res.ok) throw new Error(`Could not load live data (${res.status} ${res.statusText}).`)
  return res.json() as Promise<T>
}

export interface LiveSummary {
  runs_1h: number
  runs_ok_1h: number
  blocks_24h: number
  swaps_24h: number
  sandwiches_24h: number
  last_success_at: string | null
  provider: string | null
}

export interface IngestRun {
  id: number
  started_at: string
  finished_at: string | null
  status: 'running' | 'ok' | 'partial' | 'error'
  provider: string
  tip_slot: number | null
  first_slot: number | null
  last_slot: number | null
  blocks_requested: number
  blocks_ok: number
  txs: number
  dex_txs: number
  pool_swaps: number
  sandwiches: number
  samples: number
  sol_usd: number | null
  lag_slots: number | null
  duration_ms: number | null
  error: string | null
}

export interface LiveSandwich {
  id: number
  detected_at: string
  block_time: string | null
  pool_key: string
  base_mint: string
  quote_mint: string
  quote_symbol: string
  tier: 'high' | 'medium'
  slot_front: number
  slot_back: number
  slot_span: number
  attacker: string
  frontrun_tx: string
  backrun_tx: string
  victim_tx: string
  victim_count: number
  attacker_profit_quote: number
  attacker_profit_usd: number | null
  victim_quote_in: number | null
  victim_loss_bps_lb: number | null
  confidence: number
}

export interface LivePool {
  pool_key: string
  base_mint: string
  quote_mint: string | null
  quote_symbol: string | null
  swaps: number
  sandwiches: number
  attack_rate: number
  quote_volume: number
  median_loss_bps_lb: number | null
  profit_usd: number | null
  est_tvl_usd: number | null
}

export const live = {
  summary: () => rest<LiveSummary[]>('live_summary?select=*').then((rows) => rows[0] ?? null),
  runs: (limit = 40) => rest<IngestRun[]>(`ingest_runs?select=*&order=started_at.desc&limit=${limit}`),
  sandwiches: (limit = 15) =>
    rest<LiveSandwich[]>(`sandwich_events?select=*&order=detected_at.desc&limit=${limit}`),
  // a rate on a handful of swaps is noise, so require some volume and a detection
  pools: (limit = 8) =>
    rest<LivePool[]>(
      `live_pool_risk?select=*&swaps=gte.100&sandwiches=gt.0&order=attack_rate.desc&limit=${limit}`,
    ),
}

export type Health = 'live' | 'stale' | 'down' | 'none'

export const HEALTH_LABEL: Record<Health, string> = {
  live: 'Live',
  stale: 'Delayed',
  down: 'Stalled',
  none: 'No data',
}

/**
 * Scans run every minute, so "live" tolerates two missed runs before it stops
 * claiming to be live.
 */
export function healthOf(lastSuccessIso: string | null | undefined, now: number): Health {
  if (!lastSuccessIso) return 'none'
  const seconds = (now - Date.parse(lastSuccessIso)) / 1000
  if (seconds < 180) return 'live'
  if (seconds < 1800) return 'stale'
  return 'down'
}

export function ageLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** Lightweight poll for the header indicator. */
export function useLiveSummary(pollMs = 30_000): LiveSummary | null {
  const [summary, setSummary] = useState<LiveSummary | null>(null)
  useEffect(() => {
    if (!liveConfigured) return
    let alive = true
    const load = () =>
      live
        .summary()
        .then((s) => {
          if (alive) setSummary(s)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, pollMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [pollMs])
  return summary
}

// Display names for common Solana mints; anything else is shown abbreviated.
const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': 'TRUMP',
}

export function mintLabel(mint: string | null | undefined): string {
  if (!mint) return '?'
  return KNOWN_MINTS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

export const solscanTx = (signature: string) => `https://solscan.io/tx/${signature}`
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`
