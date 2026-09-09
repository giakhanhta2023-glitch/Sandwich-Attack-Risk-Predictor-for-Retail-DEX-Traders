/** Typed client for the risk API. Shapes mirror the FastAPI responses. */

export interface Pool {
  pool_id: string
  chain: 'ethereum' | 'solana'
  symbol: string
  tvl_usd: number
  fee_bps: number
  volatility_24h: number
  price_in_usd: number
  swaps_per_block: number
  is_stable_pair: boolean
  token_age_days: number
  venue: string
  historical_attack_rate?: number
}

export interface CurvePoint {
  slippage_bps: number
  expected_cost_usd: number
  attack_loss_usd: number
  revert_cost_usd: number
  p_attack: number
  p_revert: number
  attacker_profit_usd: number
}

export interface Driver {
  feature: string
  label: string
  delta: number
  direction: 'increases' | 'reduces'
  value: number
}

export interface Recommendation {
  severity: 'action' | 'warning' | 'good'
  title: string
  detail: string
  impact_usd: number
}

export interface SplitPlan {
  chunks: number
  chunk_size_usd: number
  slippage_bps: number
  expected_cost_usd: number
  expected_cost_bps: number
  gas_overhead_usd: number
  timing_risk_usd: number
  attacker_profit_per_chunk_usd: number
  p_attack_per_chunk: number
  total_duration_s: number
}

export interface Analysis {
  input: {
    pool: Pool
    notional_usd: number
    slippage_bps: number
    private_relay: boolean
    hour_of_day: number
  }
  market: {
    chain: string
    block_time_s: number
    inclusion_blocks: number
    user_gas_usd: number
    attack_cost_usd: number
    cost_label: string
    gas_index: number
    gas_gwei?: number
    note: string
  }
  risk: {
    p_attack: number
    expected_loss_bps_if_attacked: number
    expected_loss_usd: number
    risk_band: 'minimal' | 'low' | 'elevated' | 'high' | 'severe'
    drivers: Driver[]
    model: string
    source: string
    searcher_presence: number
    p_revert: number
  }
  economics: {
    attacker_profit_usd: number
    attacker_revenue_usd: number
    attack_cost_usd: number
    frontrun_size_usd: number
    frontrun_capacity_usd: number
    victim_loss_usd: number
    victim_loss_bps: number
    attack_is_profitable: boolean
    price_impact_bps: number
    baseline_impact_usd: number
    critical_slippage_bps: number
  }
  current_setting: {
    slippage_bps: number
    expected_cost_usd: number
    p_attack: number
    worst_case_loss_usd: number
  }
  sweet_spot: {
    slippage_bps: number
    expected_cost_usd: number
    expected_cost_bps: number
    controllable_cost_usd: number
    baseline_impact_usd: number
    p_attack: number
    p_revert: number
    critical_slippage_bps: number
    attacker_profit_at_rec_usd: number
    worst_case_loss_usd: number
    savings_vs_current_usd: number
    curve: CurvePoint[]
  }
  split: {
    recommended_chunks: number
    single_cost_usd: number
    best_cost_usd: number
    savings_usd: number
    plans: SplitPlan[]
  }
  recommendations: Recommendation[]
  meta: {
    computed_at: number
    data_source: string
    model: string
    assumptions: Record<string, number>
  }
}

export interface CorpusStats {
  available: boolean
  reason?: string
  data_source?: string
  total_swaps?: number
  total_sandwiches?: number
  overall_attack_rate?: number
  total_victim_loss_usd?: number
  median_loss_bps?: number
  median_loss_usd?: number
  by_pool?: Array<{
    pool_id: string
    symbol: string
    chain: string
    venue: string
    tvl_usd: number
    swaps: number
    sandwiched: number
    attack_rate: number
    median_loss_bps: number
    total_loss_usd: number
    median_victim_size_usd: number
  }>
  by_slippage?: Array<{
    bucket: string
    lower_bps: number
    upper_bps: number
    swaps: number
    attack_rate: number
    median_loss_bps: number
  }>
  by_size?: Array<{
    bucket: string
    swaps: number
    attack_rate: number
    median_loss_usd: number
  }>
}

export interface ModelReport {
  trained_at: number
  training_seconds: number
  data_source: string
  rows: number
  train_rows: number
  test_rows: number
  split: string
  features: string[]
  metrics: {
    roc_auc: number
    pr_auc: number
    brier: number
    base_rate: number
    loss_mae_bps: number
    loss_median_bps: number
    reliability: Array<{
      bin_lower: number
      bin_upper: number
      predicted: number
      observed: number
      count: number
    }>
  }
  feature_importance: Array<{ feature: string; importance: number; std: number }>
}

export interface Methodology {
  sources: Record<string, { provider: string; live: boolean; detail: string }>
  bigquery_sql: Array<{ name: string; purpose: string; sql: string }>
  detection: { pattern: string; criteria: string[]; loss_measurement: string }
  optimisation: { objective: string; frontrun_capacity: string; note: string }
}

export interface SimulationStep {
  step: number
  actor: 'market' | 'attacker' | 'victim'
  label: string
  price: number
  detail: string
  amount_usd?: number
  loss_usd?: number
  profit_usd?: number
}

export interface Simulation {
  pool: Pool
  steps: SimulationStep[]
  summary: Record<string, number | boolean>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () =>
    request<{ status: string; model_trained: boolean; sources: Methodology['sources'] }>(
      '/api/health',
    ),
  pools: () => request<{ pools: Pool[]; count: number }>('/api/pools'),
  analyze: (body: {
    pool_id: string
    notional_usd: number
    slippage_bps: number
    private_relay: boolean
    max_chunks?: number
  }) => request<Analysis>('/api/analyze', { method: 'POST', body: JSON.stringify(body) }),
  simulate: (body: { pool_id: string; notional_usd: number; slippage_bps: number }) =>
    request<Simulation>('/api/simulate', { method: 'POST', body: JSON.stringify(body) }),
  stats: () => request<CorpusStats>('/api/stats'),
  model: () => request<ModelReport>('/api/model'),
  methodology: () => request<Methodology>('/api/methodology'),
}

// ---------------------------------------------------------------- formatting

export const usd = (v: number, digits?: number) => {
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2)
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}

export const compactUsd = (v: number) => {
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`

export const bps = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}bp`
