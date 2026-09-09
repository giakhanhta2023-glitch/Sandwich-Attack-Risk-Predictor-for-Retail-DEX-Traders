import { useEffect, useMemo, useRef, useState } from 'react'
import { api, usd, compactUsd, pct, bps } from '../api'
import type { Analysis, Pool } from '../api'
import { Badge, Bar, Section, Skeleton, Stat } from './primitives'
import { CostCurve } from './CostCurve'

const SLIPPAGE_PRESETS = [10, 30, 50, 100, 300, 500]
const SIZE_PRESETS = [500, 5_000, 25_000, 100_000]

export function Analyzer({ pools }: { pools: Pool[] }) {
  const [poolId, setPoolId] = useState('')
  const [notional, setNotional] = useState(25_000)
  const [slippage, setSlippage] = useState(300)
  const [privateRelay, setPrivateRelay] = useState(false)

  const [result, setResult] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!poolId && pools.length) {
      // Open on a representative retail case rather than the safest one: a
      // mid-cap pair at the 3% tolerance wallets routinely default to.
      setPoolId(pools.find((p) => p.pool_id === 'uni-v2-pepe-weth')?.pool_id ?? pools[0].pool_id)
    }
  }, [pools, poolId])

  useEffect(() => {
    if (!poolId) return
    const id = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      api
        .analyze({ pool_id: poolId, notional_usd: notional, slippage_bps: slippage, private_relay: privateRelay })
        .then((r) => {
          if (id === seq.current) {
            setResult(r)
            setError(null)
          }
        })
        .catch((e) => id === seq.current && setError(String(e)))
        .finally(() => id === seq.current && setLoading(false))
    }, 180)
    return () => clearTimeout(t)
  }, [poolId, notional, slippage, privateRelay])

  const pool = useMemo(() => pools.find((p) => p.pool_id === poolId), [pools, poolId])
  const grouped = useMemo(() => {
    return {
      ethereum: pools.filter((p) => p.chain === 'ethereum'),
      solana: pools.filter((p) => p.chain === 'solana'),
    }
  }, [pools])

  return (
    <Section
      id="analyzer"
      eyebrow="Risk engine"
      title="Price your next swap before you sign it"
      lede="Pick a pool and a size. The model scores sandwich probability from live execution conditions, then solves for the slippage tolerance that minimises what the trade is expected to cost you."
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(300px,340px)_1fr]">
        {/* ---------------- controls ---------------- */}
        <div className="panel h-fit p-5 lg:sticky lg:top-20">
          <div className="eyebrow mb-4">Trade</div>

          <label className="mb-1.5 block text-xs text-ink-dim" htmlFor="pool">
            Pool
          </label>
          <select id="pool" value={poolId} onChange={(e) => setPoolId(e.target.value)} className="mb-1">
            <optgroup label="Ethereum">
              {grouped.ethereum.map((p) => (
                <option key={p.pool_id} value={p.pool_id}>
                  {p.symbol} · {compactUsd(p.tvl_usd)} · {p.fee_bps}bp
                </option>
              ))}
            </optgroup>
            <optgroup label="Solana">
              {grouped.solana.map((p) => (
                <option key={p.pool_id} value={p.pool_id}>
                  {p.symbol} · {compactUsd(p.tvl_usd)} · {p.fee_bps}bp
                </option>
              ))}
            </optgroup>
          </select>
          {pool && (
            <div className="mb-5 flex flex-wrap gap-1.5 pt-2">
              <Badge>{pool.venue}</Badge>
              <Badge tone={pool.volatility_24h > 0.15 ? 'warn' : 'neutral'}>
                σ {pct(pool.volatility_24h, 1)}/day
              </Badge>
              {pool.token_age_days < 30 && <Badge tone="hot">{pool.token_age_days}d old</Badge>}
            </div>
          )}

          <label className="mb-1.5 flex items-baseline justify-between text-xs text-ink-dim" htmlFor="size">
            <span>Trade size</span>
            <span className="num text-ink">{usd(notional, 0)}</span>
          </label>
          <input
            id="size"
            type="range"
            min={Math.log(100)}
            max={Math.log(2_000_000)}
            step={0.01}
            value={Math.log(notional)}
            onChange={(e) => setNotional(Math.round(Math.exp(Number(e.target.value))))}
            className="mb-2"
          />
          <div className="mb-5 flex gap-1.5">
            {SIZE_PRESETS.map((s) => (
              <button
                key={s}
                onClick={() => setNotional(s)}
                className={`num flex-1 rounded-md border px-1.5 py-1 text-[0.6875rem] transition-colors ${
                  notional === s
                    ? 'border-ink-faint bg-raised text-ink'
                    : 'border-line text-ink-faint hover:border-line-bright hover:text-ink-dim'
                }`}
              >
                {compactUsd(s)}
              </button>
            ))}
          </div>

          <label className="mb-1.5 flex items-baseline justify-between text-xs text-ink-dim" htmlFor="slip">
            <span>Your slippage tolerance</span>
            <span className="num text-ink">{bps(slippage)}</span>
          </label>
          <input
            id="slip"
            type="range"
            min={Math.log(5)}
            max={Math.log(2000)}
            step={0.01}
            value={Math.log(slippage)}
            onChange={(e) => setSlippage(Math.round(Math.exp(Number(e.target.value))))}
            className="mb-2"
          />
          <div className="mb-5 flex gap-1.5">
            {SLIPPAGE_PRESETS.map((s) => (
              <button
                key={s}
                onClick={() => setSlippage(s)}
                className={`num flex-1 rounded-md border px-1 py-1 text-[0.6875rem] transition-colors ${
                  slippage === s
                    ? 'border-ink-faint bg-raised text-ink'
                    : 'border-line text-ink-faint hover:border-line-bright hover:text-ink-dim'
                }`}
              >
                {s < 100 ? `${s}bp` : `${s / 100}%`}
              </button>
            ))}
          </div>

          <button
            onClick={() => setPrivateRelay((v) => !v)}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors ${
              privateRelay ? 'border-cool/40 bg-cool/8' : 'border-line hover:border-line-bright'
            }`}
          >
            <span>
              <span className={`block text-xs font-medium ${privateRelay ? 'text-cool' : 'text-ink'}`}>
                Private orderflow
              </span>
              <span className="block text-[0.6875rem] text-ink-faint">
                {pool?.chain === 'solana' ? 'Jito bundle / private RPC' : 'Flashbots Protect'}
              </span>
            </span>
            <span
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                privateRelay ? 'bg-cool' : 'bg-line-bright'
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-void transition-transform ${
                  privateRelay ? 'translate-x-4.5' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>

          {result && (
            <div className="mt-5 space-y-2 border-t border-line pt-4 text-[0.6875rem] text-ink-faint">
              <Row label={result.market.cost_label} value={usd(result.market.attack_cost_usd)} />
              <Row label="Your gas per attempt" value={usd(result.market.user_gas_usd)} />
              <Row
                label="Exposure window"
                value={`${(result.market.block_time_s * result.market.inclusion_blocks).toFixed(1)}s`}
              />
              {result.market.gas_gwei && <Row label="Base fee" value={`${result.market.gas_gwei} gwei`} />}
            </div>
          )}
        </div>

        {/* ---------------- results ---------------- */}
        <div className="min-w-0 space-y-5">
          {error && (
            <div className="panel border-hot/40 p-5 text-sm text-hot">
              Could not reach the risk API. Is the backend running on port 8000?
              <div className="mt-2 font-mono text-xs text-ink-faint">{error}</div>
            </div>
          )}

          {!result && !error && (
            <>
              <Skeleton className="h-40" />
              <Skeleton className="h-80" />
            </>
          )}

          {result && (
            <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
              <Verdict result={result} onApply={(b) => setSlippage(Math.round(b))} />

              <div className="panel mt-5 p-5">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="eyebrow mb-1">The sweet spot</div>
                    <h3 className="text-lg font-semibold">Where expected cost bottoms out</h3>
                  </div>
                  <div className="text-right">
                    <div className="num text-3xl font-semibold text-cool">
                      {bps(result.sweet_spot.slippage_bps)}
                    </div>
                    <div className="text-[0.6875rem] text-ink-faint">recommended tolerance</div>
                  </div>
                </div>
                <CostCurve
                  curve={result.sweet_spot.curve}
                  baselineUsd={result.sweet_spot.baseline_impact_usd}
                  currentBps={result.input.slippage_bps}
                  recommendedBps={result.sweet_spot.slippage_bps}
                  criticalBps={result.economics.critical_slippage_bps}
                />
              </div>

              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <AttackerLedger result={result} />
                <Drivers result={result} />
              </div>

              <SplitLadder result={result} />
              <Recommendations result={result} />
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className="num text-ink-dim">{value}</span>
    </div>
  )
}

/** Headline verdict: risk band, what it costs now, what it could cost. */
function Verdict({ result, onApply }: { result: Analysis; onApply: (bps: number) => void }) {
  const { risk, current_setting, sweet_spot, economics } = result
  const band = risk.risk_band
  const saving = sweet_spot.savings_vs_current_usd

  return (
    <div className="panel overflow-hidden">
      <div className="grid gap-px bg-line sm:grid-cols-[1.15fr_1fr_1fr]">
        <div className={`bg-ground p-5 bg-risk-${band}`}>
          <div className="eyebrow mb-2">Sandwich probability</div>
          <div className="flex items-baseline gap-2.5">
            <span className={`num text-[2.75rem] leading-none font-semibold risk-${band}`}>
              {(risk.p_attack * 100).toFixed(1)}
              <span className="text-xl">%</span>
            </span>
          </div>
          <div className={`mt-2 text-xs font-medium uppercase tracking-wider risk-${band}`}>{band} risk</div>
          <p className="mt-3 text-xs leading-relaxed text-ink-dim">
            {economics.attack_is_profitable
              ? `A searcher nets ${usd(economics.attacker_profit_usd)} from this trade at your current tolerance.`
              : `A sandwich on this trade loses a searcher money, so the attack is not worth running.`}
          </p>
        </div>

        <div className="bg-ground p-5">
          <Stat
            label="Expected cost now"
            value={usd(current_setting.expected_cost_usd)}
            sub={`at ${bps(current_setting.slippage_bps)} · worst case ${usd(current_setting.worst_case_loss_usd)}`}
            tone={saving > 0.5 ? 'hot' : 'neutral'}
          />
          <div className="mt-4">
            <Stat
              label="Expected cost optimised"
              value={usd(sweet_spot.expected_cost_usd)}
              sub={`at ${bps(sweet_spot.slippage_bps)} · ${sweet_spot.expected_cost_bps.toFixed(1)}bp of notional`}
              tone="cool"
            />
          </div>
        </div>

        <div className="flex flex-col justify-between bg-ground p-5">
          <Stat
            label="You would save"
            value={saving > 0 ? usd(saving) : usd(0)}
            tone={saving > 0.5 ? 'cool' : 'neutral'}
            size="lg"
            sub="per trade, expected"
          />
          <button
            onClick={() => onApply(sweet_spot.slippage_bps)}
            className="mt-4 w-full rounded-lg border border-cool/40 bg-cool/10 px-3 py-2 text-xs font-medium text-cool transition-colors hover:bg-cool/20"
          >
            Apply {bps(sweet_spot.slippage_bps)} →
          </button>
        </div>
      </div>
    </div>
  )
}

/** The searcher's P&L on your trade -- the number that decides whether they act. */
function AttackerLedger({ result }: { result: Analysis }) {
  const e = result.economics
  const rows = [
    { label: 'Front-run size', value: usd(e.frontrun_size_usd), tone: 'text-ink-dim' },
    { label: 'Gross extraction', value: usd(e.attacker_revenue_usd), tone: 'text-ink-dim' },
    { label: `Less ${result.market.cost_label}`, value: `-${usd(e.attack_cost_usd)}`, tone: 'text-ink-faint' },
  ]

  return (
    <div className="panel p-5">
      <div className="eyebrow mb-1">Searcher's ledger</div>
      <h3 className="mb-4 text-base font-semibold">What the bot makes on you</h3>

      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink-dim">{r.label}</span>
            <span className={`num ${r.tone}`}>{r.value}</span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2.5 text-sm">
          <span className="font-medium">Net profit</span>
          <span className={`num font-semibold ${e.attacker_profit_usd > 0 ? 'text-hot' : 'text-cool'}`}>
            {usd(e.attacker_profit_usd)}
          </span>
        </div>
      </div>

      <div className="mt-5 space-y-3 border-t border-line pt-4">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="text-ink-dim">Your loss if sandwiched</span>
            <span className="num text-hot">
              {usd(e.victim_loss_usd)} · {bps(e.victim_loss_bps)}
            </span>
          </div>
          <Bar value={e.victim_loss_usd} max={Math.max(e.victim_loss_usd, result.input.notional_usd * 0.05)} tone="hot" />
        </div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-ink-dim">Front-run budget your tolerance allows</span>
          <span className="num text-ink-dim">{usd(e.frontrun_capacity_usd)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-ink-dim">Attack breaks even at</span>
          <span className="num text-warn">
            {e.critical_slippage_bps >= 4999 ? 'never' : bps(e.critical_slippage_bps)}
          </span>
        </div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-ink-dim">Unavoidable fee &amp; price impact</span>
          <span className="num text-ink-dim">
            {usd(e.baseline_impact_usd)} · {bps(e.price_impact_bps)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Per-prediction attribution from the model. */
function Drivers({ result }: { result: Analysis }) {
  const drivers = result.risk.drivers
  const max = Math.max(...drivers.map((d) => Math.abs(d.delta)), 0.01)

  return (
    <div className="panel p-5">
      <div className="eyebrow mb-1">Model attribution</div>
      <h3 className="mb-1 text-base font-semibold">Why this score</h3>
      <p className="mb-4 text-xs text-ink-faint">
        Each bar is the change in predicted probability when that input is reset to its corpus median.
      </p>

      {drivers.length === 0 ? (
        <p className="text-sm text-ink-faint">
          No single input moves this prediction much — the score is close to the pool's base rate.
        </p>
      ) : (
        <div className="space-y-3">
          {drivers.map((d) => (
            <div key={d.feature}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                <span className="text-ink-dim">{d.label}</span>
                <span className={`num ${d.delta > 0 ? 'text-hot' : 'text-cool'}`}>
                  {d.delta > 0 ? '+' : ''}
                  {(d.delta * 100).toFixed(1)}pp
                </span>
              </div>
              <div className="flex h-1.5 overflow-hidden rounded-full bg-line">
                <div className="flex w-1/2 justify-end">
                  {d.delta < 0 && (
                    <div
                      className="h-full rounded-l-full bg-cool"
                      style={{ width: `${(Math.abs(d.delta) / max) * 100}%` }}
                    />
                  )}
                </div>
                <div className="flex w-1/2">
                  {d.delta > 0 && (
                    <div className="h-full rounded-r-full bg-hot" style={{ width: `${(d.delta / max) * 100}%` }} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4 text-[0.6875rem] text-ink-faint">
        <div className="flex justify-between">
          <span>Searcher presence (latent)</span>
          <span className="num">{pct(result.risk.searcher_presence)}</span>
        </div>
        <div className="mt-1.5 flex justify-between">
          <span>Revert probability at your tolerance</span>
          <span className="num">{pct(result.risk.p_revert)}</span>
        </div>
        <div className="mt-1.5 flex justify-between">
          <span>Loss if attacked</span>
          <span className="num">{bps(result.risk.expected_loss_bps_if_attacked)}</span>
        </div>
      </div>
    </div>
  )
}

/** Splitting turns one attractive victim into several unprofitable ones. */
function SplitLadder({ result }: { result: Analysis }) {
  const plans = result.split.plans
  const best = result.split.recommended_chunks
  const maxCost = Math.max(...plans.map((p) => p.expected_cost_usd))

  return (
    <div className="panel mt-5 p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="eyebrow mb-1">Order splitting</div>
          <h3 className="text-base font-semibold">Break the trade into smaller pieces</h3>
          <p className="mt-1 max-w-2xl text-xs text-ink-faint">
            A searcher's profit falls faster than trade size, so several small victims can each be worth less than
            the bundle costs to run. You pay for it in gas and time exposure.
          </p>
        </div>
        {result.split.savings_usd > 0.5 && (
          <Badge tone="cool">saves {usd(result.split.savings_usd)}</Badge>
        )}
      </div>

      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              {['Chunks', 'Each', 'Slippage', 'Attacker profit', 'Extra gas', 'Timing risk', 'Expected cost'].map(
                (h) => (
                  <th key={h} className="eyebrow pb-2 font-normal last:text-right">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const isBest = p.chunks === best
              return (
                <tr
                  key={p.chunks}
                  className={`border-b border-line/60 last:border-0 ${isBest ? 'bg-cool/6' : ''}`}
                >
                  <td className="py-2.5">
                    <span className={`num ${isBest ? 'font-semibold text-cool' : 'text-ink'}`}>
                      {p.chunks}
                      {isBest && <span className="ml-2 text-[0.625rem] uppercase tracking-wider">best</span>}
                    </span>
                  </td>
                  <td className="num py-2.5 text-ink-dim">{usd(p.chunk_size_usd, 0)}</td>
                  <td className="num py-2.5 text-ink-dim">{bps(p.slippage_bps)}</td>
                  <td
                    className={`num py-2.5 ${p.attacker_profit_per_chunk_usd > 0 ? 'text-hot' : 'text-cool'}`}
                  >
                    {usd(p.attacker_profit_per_chunk_usd)}
                  </td>
                  <td className="num py-2.5 text-ink-faint">{usd(p.gas_overhead_usd)}</td>
                  <td className="num py-2.5 text-ink-faint">{usd(p.timing_risk_usd)}</td>
                  <td className="py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      <div className="hidden w-20 sm:block">
                        <Bar value={p.expected_cost_usd} max={maxCost} tone={isBest ? 'cool' : 'hot'} />
                      </div>
                      <span className={`num ${isBest ? 'font-semibold text-cool' : 'text-ink-dim'}`}>
                        {usd(p.expected_cost_usd)}
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Recommendations({ result }: { result: Analysis }) {
  const tones = {
    action: { badge: 'cool' as const, label: 'Do this' },
    warning: { badge: 'warn' as const, label: 'Watch out' },
    good: { badge: 'info' as const, label: 'All clear' },
  }

  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      {result.recommendations.map((r, i) => (
        <div key={i} className="panel p-5">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <Badge tone={tones[r.severity].badge}>{tones[r.severity].label}</Badge>
            {r.impact_usd > 0.01 && (
              <span className="num text-sm font-semibold text-cool">{usd(r.impact_usd)}</span>
            )}
          </div>
          <h4 className="mb-1.5 text-sm font-semibold">{r.title}</h4>
          <p className="text-xs leading-relaxed text-ink-dim">{r.detail}</p>
        </div>
      ))}
    </div>
  )
}
