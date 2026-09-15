import { useEffect, useMemo, useRef, useState } from 'react'
import { api, usd, compactUsd, pct, bps } from '@/api'
import type { Analysis, Pool } from '@/api'
import { Badge, Bar, Disclosure, Panel, Section, Skeleton, Stat } from './primitives'
import { CostCurve } from './CostCurve'
import { LivePulse } from './LivePulse'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Link } from '@/lib/router'
import { AuthDialog } from './Auth'
import { Rabbit } from './Rabbit'
import { saveTrade, useAccount } from '@/lib/auth'

const SLIPPAGE_PRESETS = [10, 30, 50, 100, 300, 500]
const SIZE_PRESETS = [500, 5_000, 25_000, 100_000]

export function Analyzer({ pools }: { pools: Pool[] }) {
  const [poolId, setPoolId] = useState('')
  const [notional, setNotional] = useState(8_000)
  const [slippage, setSlippage] = useState(300)
  const [privateRelay, setPrivateRelay] = useState(false)

  const [result, setResult] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!poolId && pools.length) {
      // Reopened from a saved trade: the link carries what was analysed.
      const wanted = new URLSearchParams(window.location.search)
      const savedPool = wanted.get('pool')
      const savedSize = Number(wanted.get('size'))
      const savedSlippage = Number(wanted.get('slippage'))
      if (savedPool) {
        if (savedSize > 0) setNotional(savedSize)
        if (savedSlippage > 0) setSlippage(savedSlippage)
        if (wanted.has('relay')) setPrivateRelay(wanted.get('relay') === '1')
        setPoolId(savedPool)
        return
      }
      // Open on the real pool where sandwiches caught the most trades this week,
      // at a size typical for it, so the first number anyone sees is measured.
      // Without live data, fall back to a memecoin pair at the 3% tolerance
      // wallets routinely default to.
      const hottest = pools.find((p) => p.live)
      if (hottest) setNotional(500)
      setPoolId(
        hottest?.pool_id ??
          pools.find((p) => p.pool_id === 'ray-bonk-sol')?.pool_id ??
          pools.find((p) => p.chain === 'solana')?.pool_id ??
          pools[0].pool_id,
      )
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
  // Only Solana has a live feed and a model trained on real swaps. Ethereum pools
  // return when real Ethereum data does; until then they could only show a
  // formula estimate.
  const solanaPools = useMemo(() => pools.filter((p) => p.chain === 'solana'), [pools])
  const livePools = solanaPools.filter((p) => p.live && p.measured)
  const referencePools = solanaPools.filter((p) => !p.live)

  return (
    <Section
      id="analyzer"
      eyebrow="Risk engine"
      title="Price your next swap before you sign it"
      lede="Pick a pool and a size. The model scores sandwich probability from live execution conditions, then solves for the slippage tolerance that minimises what the trade is expected to cost you."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(270px,300px)_1fr]">
        {/* ---------------- controls ---------------- */}
        <Panel className="h-fit p-3 lg:sticky lg:top-14">
          <div className="eyebrow mb-3">Trade</div>

          <Label htmlFor="pool" className="eyebrow mb-1">
            Pool
          </Label>
          <Select value={poolId} onValueChange={setPoolId}>
            <SelectTrigger id="pool" className="num w-full border-line bg-void text-sm">
              <SelectValue placeholder="Select a pool" />
            </SelectTrigger>
            <SelectContent className="border-line bg-ground">
              {livePools.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="eyebrow">Real pools · most attacked this week</SelectLabel>
                  {livePools.map((p) => (
                    <SelectItem key={p.pool_id} value={p.pool_id} className="num text-xs">
                      {p.symbol} · {pct(p.measured!.victim_rate, 0)} hit · {compactUsd(p.tvl_usd)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel className="eyebrow">Reference pools</SelectLabel>
                {referencePools.map((p) => (
                  <SelectItem key={p.pool_id} value={p.pool_id} className="num text-xs">
                    {p.symbol} · {compactUsd(p.tvl_usd)} · {p.fee_bps}bp
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {pool && (
            <div className="mt-2 mb-5 flex flex-wrap gap-1.5">
              <Badge>{pool.venue}</Badge>
              {pool.measured ? (
                <Badge tone="hot">
                  {pool.measured.victims} of {pool.measured.swaps.toLocaleString()} trades sandwiched · 7d
                </Badge>
              ) : (
                <>
                  <Badge tone={pool.volatility_24h > 0.15 ? 'warn' : 'neutral'}>
                    σ {pct(pool.volatility_24h, 1)}/day
                  </Badge>
                  {pool.token_age_days < 30 && <Badge tone="hot">{pool.token_age_days}d old</Badge>}
                </>
              )}
            </div>
          )}

          <div className="mb-1.5 flex items-baseline justify-between">
            <Label htmlFor="size" className="eyebrow">
              Trade size
            </Label>
            <NumericEntry
              ariaLabel="Trade size in US dollars"
              value={notional}
              format={(v) => usd(v, 0)}
              parse={parseUsd}
              min={100}
              max={2_000_000}
              onCommit={setNotional}
            />
          </div>
          <Slider
            id="size"
            min={Math.log(100)}
            max={Math.log(2_000_000)}
            step={0.01}
            value={[Math.log(notional)]}
            onValueChange={([v]) => setNotional(Math.round(Math.exp(v)))}
            className="mb-3"
          />
          <PresetRow
            options={SIZE_PRESETS}
            current={notional}
            onSelect={setNotional}
            format={compactUsd}
          />

          <div className="mt-5 mb-1.5 flex items-baseline justify-between">
            <Label htmlFor="slip" className="eyebrow">
              Your slippage tolerance
            </Label>
            <NumericEntry
              ariaLabel="Slippage tolerance in basis points"
              value={slippage}
              format={bps}
              parse={parseBps}
              min={5}
              max={2000}
              onCommit={setSlippage}
            />
          </div>
          <Slider
            id="slip"
            min={Math.log(5)}
            max={Math.log(2000)}
            step={0.01}
            value={[Math.log(slippage)]}
            onValueChange={([v]) => setSlippage(Math.round(Math.exp(v)))}
            className="mb-3"
          />
          <PresetRow
            options={SLIPPAGE_PRESETS}
            current={slippage}
            onSelect={setSlippage}
            format={(s) => (s < 100 ? `${s}bp` : `${s / 100}%`)}
          />

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="eyebrow">Routing</span>
              <span className="text-[0.625rem] text-ink-faint">
                {pool?.chain === 'solana' ? 'Jito bundle' : 'Flashbots Protect'}
              </span>
            </div>
            {/* Two mutually exclusive states read faster as a segmented control
                than as a switch, and the labels name what each one does. */}
            <div className="grid grid-cols-2 border border-line">
              {[
                { on: false, label: 'Public mempool' },
                { on: true, label: 'Private' },
              ].map((opt, i) => (
                <button
                  key={opt.label}
                  onClick={() => setPrivateRelay(opt.on)}
                  aria-pressed={privateRelay === opt.on}
                  className={cn(
                    'px-2 py-1.5 text-[0.6875rem] transition-colors',
                    i === 1 && 'border-l border-line',
                    privateRelay === opt.on
                      ? opt.on
                        ? 'bg-cool/15 text-cool'
                        : 'bg-raised text-ink'
                      : 'text-ink-faint hover:bg-raised hover:text-ink-dim',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {result && (
            <>
              <Separator className="my-3 bg-line" />
              <Disclosure label="Execution conditions" hint="Gas, tips and how long you are exposed">
                <div className="space-y-2 text-[0.6875rem] text-ink-faint">
                  <Row label={result.market.cost_label} value={usd(result.market.attack_cost_usd)} />
                  <Row label="Your gas per attempt" value={usd(result.market.user_gas_usd)} />
                  <Row
                    label="Exposure window"
                    value={`${(result.market.block_time_s * result.market.inclusion_blocks).toFixed(1)}s`}
                  />
                  {result.market.gas_gwei && <Row label="Base fee" value={`${result.market.gas_gwei} gwei`} />}
                </div>
              </Disclosure>
            </>
          )}
        </Panel>

        {/* ---------------- results ---------------- */}
        <div className="min-w-0 space-y-4">
          {error && (
            <Panel className="border-hot/50 p-4 text-sm text-hot">
              Could not reach the risk API. Is the backend running on port 8000?
              <div className="mt-2 font-mono text-xs text-ink-faint">{error}</div>
            </Panel>
          )}

          {!result && !error && (
            <>
              <Skeleton className="h-40 bg-line/60" />
              <Skeleton className="h-80 bg-line/60" />
            </>
          )}

          {result && (
            <div className={cn('transition-opacity', loading && 'opacity-60')}>
              <Verdict result={result} onApply={(b) => setSlippage(Math.round(b))} />

              <Panel className="mt-4 p-4">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="eyebrow mb-1">The sweet spot</div>
                    <h3 className="text-lg font-semibold">Where expected cost bottoms out</h3>
                  </div>
                  <div className="text-right">
                    <div className="num text-2xl font-semibold tracking-[-0.02em] text-cool">
                      {bps(result.sweet_spot.slippage_bps)}
                    </div>
                    <div className="text-[0.6875rem] text-ink-faint">
                      {result.sweet_spot.at_grid_floor
                        ? 'as tight as your wallet allows'
                        : 'recommended tolerance'}
                    </div>
                  </div>
                </div>
                {result.sweet_spot.at_grid_floor && (
                  <p className="mb-3 border-l-2 border-l-warn bg-transparent px-3 py-1.5 text-[0.6875rem] leading-relaxed text-warn">
                    Every tolerance in range is worth attacking here, so the objective just wants the smallest
                    one. This is a floor, not a fine-tuned number. The real levers are private routing and
                    splitting the order.
                  </p>
                )}
                <CostCurve
                  curve={result.sweet_spot.curve}
                  savingUsd={result.sweet_spot.savings_vs_current_usd}
                  baselineUsd={result.sweet_spot.baseline_impact_usd}
                  currentBps={result.input.slippage_bps}
                  recommendedBps={result.sweet_spot.slippage_bps}
                  criticalBps={result.economics.critical_slippage_bps}
                />
                <LivePulse />
              </Panel>

              <Recommendations result={result} />

              <Link
                to={`/research?pool=${encodeURIComponent(poolId)}&size=${notional}&slippage=${slippage}&relay=${privateRelay ? 1 : 0}#working`}
                className="mt-5 flex items-center justify-between gap-4 rounded-sm border border-line px-4 py-3 transition-colors hover:border-cool/50 hover:bg-raised"
              >
                <span>
                  <span className="text-[0.8125rem] font-medium text-ink">Show the working</span>
                  <span className="mt-0.5 block text-[0.6875rem] text-ink-faint">
                    What the bot earns, why the model scored it this way, and the full split ladder
                  </span>
                </span>
                <span className="text-cool">&rarr;</span>
              </Link>
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

/**
 * Typed entry for an exact figure, sitting where the read-out used to be.
 *
 * Sliders are fine for exploring and poor for "I am trading exactly $37,500",
 * so the value itself is editable. Accepts what people actually type
 * ("25k", "$1.2m", "0.5%", "50bp") and clamps to the slider's range so the
 * two controls can never disagree.
 */
function NumericEntry({
  value,
  format,
  parse,
  min,
  max,
  onCommit,
  ariaLabel,
}: {
  value: number
  format: (v: number) => string
  parse: (raw: string) => number
  min: number
  max: number
  onCommit: (v: number) => void
  ariaLabel: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  const commit = () => {
    if (!cancelled.current && draft !== null) {
      const n = parse(draft)
      if (Number.isFinite(n) && n > 0) onCommit(Math.round(Math.min(max, Math.max(min, n))))
    }
    cancelled.current = false
    setDraft(null)
  }

  return (
    <input
      aria-label={ariaLabel}
      inputMode="decimal"
      spellCheck={false}
      value={draft ?? format(value)}
      onFocus={(e) => {
        setDraft(String(value))
        const el = e.currentTarget
        requestAnimationFrame(() => el.select())
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
      className="num w-24 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-right text-[0.6875rem] text-ink outline-none transition-colors hover:border-line focus:border-line-bright focus:bg-void"
    />
  )
}

/** "$25,000" / "25k" / "1.2m" -> dollars. */
function parseUsd(raw: string): number {
  const t = raw.trim().toLowerCase().replace(/[$,\s]/g, '')
  const m = /^([0-9]*\.?[0-9]+)([km]?)$/.exec(t)
  if (!m) return NaN
  return parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
}

/** "50" / "50bp" / "0.5%" -> basis points. A bare number is read as bp. */
function parseBps(raw: string): number {
  const t = raw.trim().toLowerCase().replace(/[,\s]/g, '')
  const m = /^([0-9]*\.?[0-9]+)(bps?|%)?$/.exec(t)
  if (!m) return NaN
  return parseFloat(m[1]) * (m[2] === '%' ? 100 : 1)
}

function PresetRow<T extends number>({
  options,
  current,
  onSelect,
  format,
}: {
  options: T[]
  current: number
  onSelect: (v: T) => void
  format: (v: T) => string
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <Button
          key={o}
          variant="outline"
          size="sm"
          onClick={() => onSelect(o)}
          className={cn(
            'num h-6 flex-1 rounded-none px-1 text-[0.625rem] font-normal',
            current === o
              ? 'border-line-bright bg-raised text-ink'
              : 'border-line bg-transparent text-ink-faint hover:bg-raised hover:text-ink-dim',
          )}
        >
          {format(o)}
        </Button>
      ))}
    </div>
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

/**
 * What an expected cost is made of. The pool fee and price impact are what the
 * trade costs with no bot in the picture and no tolerance can remove them, so
 * separating them is the difference between a number that looks arbitrary and
 * one you can act on: only the second line moves when you change the slider.
 */
function CostSplit({ slippageBps, total, impact }: { slippageBps: number; total: number; impact: number }) {
  return (
    <>
      at {bps(slippageBps)}
      <div className="mt-0.5">{usd(impact)} pool fee + price impact</div>
      <div>{usd(Math.max(0, total - impact))} to bots and retries</div>
    </>
  )
}

/** Headline verdict: risk band, what it costs now, what it could cost. */
function Verdict({ result, onApply }: { result: Analysis; onApply: (bps: number) => void }) {
  const { risk, current_setting, sweet_spot, economics } = result
  const band = risk.risk_band
  const saving = sweet_spot.savings_vs_current_usd
  const impact = economics.baseline_impact_usd

  return (
    <Panel className="overflow-hidden">
      <div className="grid gap-px bg-line sm:grid-cols-[1.15fr_1fr_1fr]">
        <div className={`bg-ground p-4 accent-${band}`}>
          <div className="eyebrow mb-2">Sandwich probability</div>
          <div className={`num text-[2.25rem] leading-none font-semibold tracking-[-0.03em] risk-${band}`}>
            {(risk.p_attack * 100).toFixed(1)}
            <span className="text-lg text-ink-faint">%</span>
          </div>
          <div className={`eyebrow mt-1.5 flex items-center gap-1.5 risk-${band}`}>
            {band} expected loss
            <Rabbit
              pose={economics.attack_is_profitable ? 'alert' : 'sleep'}
              size={30}
              title={economics.attack_is_profitable ? 'Bots want this trade' : 'Nothing worth a bot\u2019s time'}
            />
          </div>
          <div className="num mt-1 text-[0.6875rem] text-ink-dim">
            {usd(risk.expected_loss_usd)} expected
            {risk.expected_loss_bps != null && ` \u00b7 ${risk.expected_loss_bps.toFixed(1)}bp of your trade`}
          </div>
          <p className="mt-2.5 text-[0.6875rem] leading-relaxed text-ink-dim">
            {economics.attack_is_profitable
              ? `If a bot reaches this trade it attacks: it nets ${usd(economics.attacker_profit_usd)} at your tolerance, and you lose ${usd(economics.victim_loss_usd)}.`
              : 'At this tolerance a sandwich would lose the bot money, so bots skip it.'}
            {economics.attack_is_profitable
              && economics.attacker_profit_usd > economics.victim_loss_usd * 2
              && ' It keeps more than it takes off you by riding the price your own trade moves.'}
          </p>
          <ModelSource risk={risk} chain={result.input.pool.chain} />
        </div>

        <div className="bg-ground p-4">
          <Stat
            label="Expected cost now"
            value={usd(current_setting.expected_cost_usd)}
            sub={<CostSplit slippageBps={current_setting.slippage_bps} total={current_setting.expected_cost_usd} impact={impact} />}
            tone={saving > 0.5 ? 'hot' : 'neutral'}
          />
          <div className="mt-4">
            <Stat
              label="Expected cost optimised"
              value={usd(sweet_spot.expected_cost_usd)}
              sub={<CostSplit slippageBps={sweet_spot.slippage_bps} total={sweet_spot.expected_cost_usd} impact={impact} />}
              tone="cool"
            />
          </div>
        </div>

        <div className="flex flex-col justify-between bg-ground p-4">
          <Stat
            label="You would save"
            value={saving > 0 ? usd(saving) : usd(0)}
            tone={saving > 0.5 ? 'cool' : 'neutral'}
            size="lg"
            sub="per trade, expected"
          />
          {saving > 0.5 && <Rabbit pose="sparkle" size={40} className="mt-2 self-start" />}
          <Button
            onClick={() => onApply(sweet_spot.slippage_bps)}
            variant="outline"
            className="num mt-3 h-8 w-full rounded-sm border-cool/50 bg-transparent text-[0.6875rem] font-medium text-cool hover:bg-cool/10 hover:text-cool"
          >
            Apply {bps(sweet_spot.slippage_bps)} →
          </Button>
          <SaveTrade result={result} />
        </div>
      </div>
    </Panel>
  )
}

/** Keep this trade against your account, so you can come back to the decision. */
function SaveTrade({ result }: { result: Analysis }) {
  const { account } = useAccount()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [signIn, setSignIn] = useState(false)

  // A different trade is a different decision, so it can be saved again.
  useEffect(() => setState('idle'), [result.input.pool.pool_id, result.input.notional_usd, result.input.slippage_bps])

  const save = async () => {
    if (!account) {
      setSignIn(true)
      return
    }
    setState('saving')
    try {
      await saveTrade({
        pool_id: result.input.pool.pool_id,
        pool_symbol: result.input.pool.symbol,
        notional_usd: result.input.notional_usd,
        slippage_bps: result.input.slippage_bps,
        p_attack: result.risk.p_attack,
        risk_band: result.risk.risk_band,
        recommended_slippage_bps: result.sweet_spot.slippage_bps,
        expected_saving_usd: result.sweet_spot.savings_vs_current_usd,
        note: null,
      })
      setState('saved')
    } catch {
      setState('error')
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={save}
        disabled={state === 'saving' || state === 'saved'}
        className="mt-1.5 w-full rounded-sm border border-line px-2 py-1 text-[0.625rem] text-ink-faint transition-colors hover:border-line-bright hover:text-ink disabled:hover:border-line"
      >
        {state === 'saved' ? (
          <>
            Saved ·{' '}
            <Link to="/saved" className="underline decoration-line-bright underline-offset-2">
              your trades
            </Link>
          </>
        ) : state === 'saving' ? (
          'Saving\u2026'
        ) : state === 'error' ? (
          'Could not save. Try again'
        ) : account ? (
          'Save trade'
        ) : (
          'Sign in to save'
        )}
      </button>
      <AuthDialog open={signIn} onOpenChange={setSignIn} initialMode="signin" />
    </>
  )
}

/** Which model set the probability above, and how much real data stands behind it. */
function ModelSource({ risk, chain }: { risk: Analysis['risk']; chain: string }) {
  const live = risk.live_market
  const liveLink = (
    <Link to="/live" className="text-ink-dim underline decoration-line-bright underline-offset-2 hover:text-ink">
      Live data
    </Link>
  )

  if (risk.source === 'live-mainnet' && live) {
    const m = live.pool_measured
    return (
      <p className="mt-2 text-[0.625rem] leading-relaxed text-ink-faint">
        {m ? (
          <>
            <span className="text-cool">Measured in this pool this week:</span>{' '}
            <span className="num">{m.victims}</span> of <span className="num">{m.swaps.toLocaleString()}</span> trades
            were caught in a sandwich. Adjusted for your trade size, bots reach{' '}
            <span className="num">{pct(live.p_attack, 1)}</span> of trades like yours here.
          </>
        ) : (
          <>
            <span className="text-cool">Measured on Solana mainnet:</span> bots reached{' '}
            <span className="num">{pct(live.p_attack, 2)}</span> of trades like this, a minimum from{' '}
            <span className="num">{live.positives.toLocaleString()}</span> real victims across{' '}
            <span className="num">{live.victim_pools}</span> pools.
          </>
        )}{' '}
        The chance above also checks your slippage: bots only attack when it pays. {liveLink}
      </p>
    )
  }

  const kind = risk.source === 'trained' ? 'Simulator-trained model' : 'Formula estimate from AMM economics'
  return (
    <p className="mt-2 text-[0.625rem] leading-relaxed text-ink-faint">
      {chain === 'solana' ? (
        <>
          {kind}: the mainnet-trained model is not available right now. {liveLink}
        </>
      ) : (
        `${kind}: there is no live Ethereum data yet.`
      )}
    </p>
  )
}

/** The searcher's P&L on your trade: the number that decides whether they act. */
export function AttackerLedger({ result }: { result: Analysis }) {
  const e = result.economics

  return (
    <Panel className="p-4">
      <div className="eyebrow mb-1">Searcher's ledger</div>
      <h3 className="mb-4 text-base font-semibold">What the bot makes on you</h3>

      <div className="space-y-2.5">
        {[
          { label: 'Front-run size', value: usd(e.frontrun_size_usd) },
          { label: 'Gross extraction', value: usd(e.attacker_revenue_usd) },
          { label: `Less ${result.market.cost_label}`, value: `-${usd(e.attack_cost_usd)}` },
        ].map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink-dim">{r.label}</span>
            <span className="num text-ink-dim">{r.value}</span>
          </div>
        ))}
        <Separator className="bg-line" />
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">Net profit</span>
          <span className={cn('num font-semibold', e.attacker_profit_usd > 0 ? 'text-hot' : 'text-cool')}>
            {usd(e.attacker_profit_usd)}
          </span>
        </div>
      </div>

      <Separator className="my-3 bg-line" />

      <div className="space-y-3">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="text-ink-dim">Your loss if sandwiched</span>
            <span className="num text-hot">
              {usd(e.victim_loss_usd)} · {bps(e.victim_loss_bps)}
            </span>
          </div>
          <Bar
            value={e.victim_loss_usd}
            max={Math.max(e.victim_loss_usd, result.input.notional_usd * 0.05)}
            tone="hot"
          />
        </div>
        <Metric
          label="Front-run budget your tolerance allows"
          value={usd(e.frontrun_capacity_usd)}
          hint="The largest front-run that still leaves your trade inside its minAmountOut. Closed-form root of the constant-product curve."
        />
        <Metric
          label="Attack breaks even at"
          value={e.critical_slippage_bps >= 4999 ? 'never' : bps(e.critical_slippage_bps)}
          tone="text-warn"
          hint="Below this tolerance the sandwich cannot cover the searcher's own gas and fees, so it stops being worth running."
        />
        <Metric
          label="Unavoidable fee & price impact"
          value={`${usd(e.baseline_impact_usd)} · ${bps(e.price_impact_bps)}`}
          hint="What the swap costs with no MEV at all. Independent of your slippage setting."
        />
      </div>
    </Panel>
  )
}

function Metric({
  label,
  value,
  hint,
  tone = 'text-ink-dim',
}: {
  label: string
  value: string
  hint?: string
  tone?: string
}) {
  const row = (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className={cn('text-ink-dim', hint && 'decoration-line-bright underline-offset-4 hover:underline')}>
        {label}
      </span>
      <span className={cn('num', tone)}>{value}</span>
    </div>
  )
  if (!hint) return row
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help">{row}</div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] border border-line-bright bg-void text-ink">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

/** Per-prediction attribution from the model. */
export function Drivers({ result }: { result: Analysis }) {
  const drivers = result.risk.drivers
  const max = Math.max(...drivers.map((d) => Math.abs(d.delta)), 0.01)

  return (
    <Panel className="p-4">
      <div className="eyebrow mb-1">Model attribution</div>
      <h3 className="mb-1 text-base font-semibold">Why this score</h3>
      <p className="mb-4 text-xs text-ink-faint">
        {result.risk.source === 'live-mainnet'
          ? 'Each bar shows how that input moves the share of trades like this that bots reach, against the average of real mainnet swaps.'
          : 'Each bar is the change in predicted probability when that input is reset to its corpus median.'}
      </p>

      {drivers.length === 0 ? (
        <p className="text-sm text-ink-faint">
          No single input moves this prediction much: the score is close to the pool's base rate.
        </p>
      ) : (
        <div className="space-y-3">
          {drivers.map((d) => (
            <div key={d.feature}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                <span className="text-ink-dim">{d.label}</span>
                <span className={cn('num', d.delta > 0 ? 'text-hot' : 'text-cool')}>
                  {d.delta > 0 ? '+' : ''}
                  {(d.delta * 100).toFixed(1)}pp
                </span>
              </div>
              {/* diverging bar: reduces risk to the left, increases to the right */}
              <div className="flex h-1 overflow-hidden bg-line">
                <div className="flex w-1/2 justify-end">
                  {d.delta < 0 && (
                    <div
                      className="h-full bg-cool"
                      style={{ width: `${(Math.abs(d.delta) / max) * 100}%` }}
                    />
                  )}
                </div>
                <div className="flex w-1/2">
                  {d.delta > 0 && (
                    <div
                      className="h-full bg-hot"
                      style={{ width: `${(d.delta / max) * 100}%` }}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Separator className="my-3 bg-line" />
      <div className="space-y-1.5 text-[0.6875rem] text-ink-faint">
        <Row label="How closely bots watch this pool" value={pct(result.risk.searcher_presence)} />
        <Row label="Chance your trade fails and retries" value={pct(result.risk.p_revert)} />
        <Row label="Loss if attacked" value={bps(result.risk.expected_loss_bps_if_attacked)} />
      </div>
    </Panel>
  )
}

/** Splitting turns one attractive victim into several unprofitable ones. */
export function SplitLadder({ result }: { result: Analysis }) {
  const plans = result.split.plans
  const best = result.split.recommended_chunks
  const maxCost = Math.max(...plans.map((p) => p.expected_cost_usd))

  return (
    <Panel className="mt-4 p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="eyebrow mb-1">Order splitting</div>
          <h3 className="text-base font-semibold">Break the trade into smaller pieces</h3>
          <p className="mt-1 max-w-2xl text-xs text-ink-faint">
            A searcher's profit falls faster than trade size, so several small victims can each be worth less
            than the bundle costs to run. You pay for it in gas and time exposure.
          </p>
        </div>
        {result.split.savings_usd > 0.5 && <Badge tone="cool">saves {usd(result.split.savings_usd)}</Badge>}
      </div>

      <div className="-mx-5 overflow-x-auto px-5">
        <Table className="min-w-[480px]">
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              {['Chunks', 'Each', 'Slippage', 'Attacker profit', 'Expected cost'].map(
                (h, i, arr) => (
                  <TableHead
                    key={h}
                    className={cn('eyebrow h-auto pb-2 font-normal', i === arr.length - 1 && 'text-right')}
                  >
                    {h}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((p) => {
              const isBest = p.chunks === best
              return (
                <TableRow
                  key={p.chunks}
                  className={cn('border-line/60 hover:bg-raised/40', isBest && 'bg-cool/6')}
                >
                  <TableCell className={cn('num', isBest ? 'font-semibold text-cool' : 'text-ink')}>
                    {p.chunks}
                    {isBest && <span className="ml-2 text-[0.625rem] uppercase tracking-wider">best</span>}
                  </TableCell>
                  <TableCell className="num text-ink-dim">{usd(p.chunk_size_usd, 0)}</TableCell>
                  <TableCell className="num text-ink-dim">{bps(p.slippage_bps)}</TableCell>
                  <TableCell
                    className={cn('num', p.attacker_profit_per_chunk_usd > 0 ? 'text-hot' : 'text-cool')}
                  >
                    {usd(p.attacker_profit_per_chunk_usd)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      <div className="hidden w-20 sm:block">
                        <Bar value={p.expected_cost_usd} max={maxCost} tone={isBest ? 'cool' : 'hot'} />
                      </div>
                      <span className={cn('num', isBest ? 'font-semibold text-cool' : 'text-ink-dim')}>
                        {usd(p.expected_cost_usd)}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </Panel>
  )
}

const REC_TONES = {
  action: { badge: 'cool' as const, label: 'Do this' },
  warning: { badge: 'warn' as const, label: 'Watch out' },
  good: { badge: 'info' as const, label: 'All clear' },
}

function Recommendations({ result }: { result: Analysis }) {
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      {result.recommendations.map((r, i) => (
        <Panel key={i} className="p-4">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <Badge tone={REC_TONES[r.severity].badge}>{REC_TONES[r.severity].label}</Badge>
            {r.impact_usd > 0.01 && (
              <span className="num text-sm font-semibold text-cool">{usd(r.impact_usd)}</span>
            )}
          </div>
          <h4 className="mb-1.5 text-sm font-semibold">{r.title}</h4>
          <p className="text-xs leading-relaxed text-ink-dim">{r.detail}</p>
        </Panel>
      ))}
    </div>
  )
}
