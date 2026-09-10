import { useEffect, useState } from 'react'
import {
  Bar as RBar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, usd, compactUsd, pct, bps } from '@/api'
import type { CorpusStats, Methodology, ModelReport } from '@/api'
import { Badge, Bar, LiveDot, Panel, Section, Skeleton, Stat } from './primitives'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

/** Corpus-level view: where sandwiches actually land. */
export function CorpusDashboard() {
  const [stats, setStats] = useState<CorpusStats | null>(null)

  useEffect(() => {
    api.stats().then(setStats).catch(() => setStats({ available: false }))
  }, [])

  if (!stats)
    return (
      <Section>
        <Skeleton className="h-64 bg-line/60" />
      </Section>
    )
  if (!stats.available) {
    return (
      <Section eyebrow="Corpus" title="No corpus yet">
        <p className="text-ink-dim">{stats.reason ?? 'Train the model to populate this view.'}</p>
      </Section>
    )
  }

  const maxPoolRate = Math.max(...(stats.by_pool ?? []).map((p) => p.attack_rate), 0.01)

  return (
    <Section
      id="corpus"
      className="!py-8"
      eyebrow="Corpus"
      title="Risk is not spread evenly"
      lede="Attack rates across the labelled corpus. The pattern is consistent: sandwiches concentrate where a wide tolerance meets a thin pool, and almost vanish where the pool's own fee tier costs the searcher more than the trade is worth."
    >
      <Panel className="mb-4 grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-ground p-4">
          <Stat label="Swaps analysed" value={stats.total_swaps?.toLocaleString()} />
        </div>
        <div className="bg-ground p-4">
          <Stat label="Sandwiches detected" value={stats.total_sandwiches?.toLocaleString()} tone="hot" />
        </div>
        <div className="bg-ground p-4">
          <Stat label="Overall attack rate" value={pct(stats.overall_attack_rate ?? 0, 2)} tone="hot" />
        </div>
        <div className="bg-ground p-4">
          <Stat
            label="Median loss when hit"
            value={bps(stats.median_loss_bps ?? 0)}
            sub={`${usd(stats.median_loss_usd ?? 0)} on a median victim`}
            tone="warn"
          />
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <div className="eyebrow mb-1">By tolerance</div>
          <h3 className="mb-1 text-base font-semibold">Attack rate vs the slippage you set</h3>
          <p className="mb-4 text-xs text-ink-faint">
            The single controllable input. Every extra basis point of tolerance is budget handed to a searcher.
          </p>
          <RateChart
            data={(stats.by_slippage ?? []).map((b) => ({
              label: b.bucket,
              rate: b.attack_rate,
              detail: `${b.swaps.toLocaleString()} swaps · median loss ${bps(b.median_loss_bps)}`,
            }))}
          />
        </Panel>

        <Panel className="p-4">
          <div className="eyebrow mb-1">By trade size</div>
          <h3 className="mb-1 text-base font-semibold">Attack rate vs notional</h3>
          <p className="mb-4 text-xs text-ink-faint">
            Small trades are usually safe not because bots miss them, but because the gas and bundle bid exceed
            what can be extracted.
          </p>
          <RateChart
            data={(stats.by_size ?? []).map((b) => ({
              label: b.bucket,
              rate: b.attack_rate,
              detail:
                b.median_loss_usd > 0
                  ? `${b.swaps.toLocaleString()} swaps · median loss ${usd(b.median_loss_usd)}`
                  : `${b.swaps.toLocaleString()} swaps`,
            }))}
          />
        </Panel>
      </div>

      <Panel className="mt-4 p-4">
        <div className="eyebrow mb-1">By pool</div>
        <h3 className="mb-4 text-base font-semibold">Where the extraction happens</h3>
        <div className="-mx-5 overflow-x-auto px-5">
          <Table className="min-w-[540px]">
            <TableHeader>
              <TableRow className="border-line hover:bg-transparent">
                {['Pool', 'Chain', 'Depth', 'Median loss', 'Attack rate'].map((h, i, a) => (
                  <TableHead
                    key={h}
                    className={cn('eyebrow h-auto pb-2 font-normal', i === a.length - 1 && 'text-right')}
                  >
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.by_pool?.map((p) => (
                <TableRow key={p.pool_id} className="border-line/60 hover:bg-raised/40">
                  <TableCell>
                    <div className="font-medium text-ink">{p.symbol}</div>
                    <div className="text-[0.6875rem] text-ink-faint">{p.venue}</div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={p.chain === 'solana' ? 'info' : 'neutral'}>{p.chain}</Badge>
                  </TableCell>
                  <TableCell className="num text-ink-dim">{compactUsd(p.tvl_usd)}</TableCell>
                  <TableCell className="num text-warn">
                    {p.median_loss_bps ? bps(p.median_loss_bps) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      <div className="hidden w-24 sm:block">
                        <Bar value={p.attack_rate} max={maxPoolRate} tone="hot" />
                      </div>
                      <span className="num w-12 text-right text-hot">{pct(p.attack_rate, 1)}</span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </Section>
  )
}

type ReliabilityBin = ModelReport['metrics']['reliability'][number]
type ImportanceRow = ModelReport['feature_importance'][number]

interface RateRow {
  label: string
  rate: number
  detail: string
}

/** Horizontal bars: category labels are long, values are small percentages. */
function RateChart({ data }: { data: RateRow[] }) {
  const max = Math.max(...data.map((d) => d.rate), 0.01)
  return (
    <div style={{ height: Math.max(140, data.length * 34) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--line)" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, max * 1.12]}
            tickFormatter={(v: number) => pct(v, 0)}
            tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-faint)' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={86}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--ink-dim)' }}
          />
          <RTooltip
            cursor={{ fill: 'var(--raised)', fillOpacity: 0.5 }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as RateRow | undefined
              return active && row ? <RateTooltipView row={row} /> : null
            }}
          />
          <RBar dataKey="rate" radius={0} isAnimationActive={false}>
            {data.map((d) => (
              <Cell
                key={d.label}
                fill="var(--hot)"
                fillOpacity={0.45 + 0.55 * (d.rate / max)}
              />
            ))}
          </RBar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function RateTooltipView({ row }: { row: RateRow }) {
  return (
    <div className="rounded-sm border border-line-bright bg-void px-2.5 py-1.5">
      <div className="num text-[0.6875rem] text-ink">{row.label}</div>
      <div className="num text-[0.625rem] text-hot">{pct(row.rate, 2)} sandwiched</div>
      <div className="num text-[0.625rem] text-ink-faint">{row.detail}</div>
    </div>
  )
}

/** Model card: metrics, calibration, and what the model leans on. */
export function ModelCard() {
  const [report, setReport] = useState<ModelReport | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    api.model().then(setReport).catch(() => setError(true))
  }, [])

  if (error) {
    return (
      <Section eyebrow="Model" title="Not trained yet">
        <p className="text-ink-dim">
          Run <code className="num rounded bg-surface px-1.5 py-0.5 text-ink">python -m backend.ml.train</code>{' '}
          to build the model artifacts.
        </p>
      </Section>
    )
  }
  if (!report)
    return (
      <Section>
        <Skeleton className="h-64 bg-line/60" />
      </Section>
    )

  const m = report.metrics
  const serving = report.serving

  return (
    <Section
      id="model"
      className="!py-8"
      eyebrow="Model card"
      title="What the model is, and where it is weak"
      lede="Gradient-boosted trees with isotonic calibration, split chronologically by block so no future regime leaks backwards. Calibration matters more than ranking here: the recommendation multiplies this probability by a dollar loss, so a confidently wrong score produces a confidently wrong slippage."
    >
      {serving?.mode === 'fallback' && (
        <Panel className="mb-4 border-l-2 border-l-warn p-4">
          <div className="eyebrow mb-2 text-warn">Not the predictor running here</div>
          <p className="text-sm leading-relaxed text-ink">
            The metrics below describe the trained model. This deployment is scoring with{' '}
            <strong>{serving.detail}</strong>.
          </p>
          {serving.affects && (
            <p className="mt-2 text-xs leading-relaxed text-ink-dim">{serving.affects}</p>
          )}
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <div className="eyebrow mb-4">Held-out performance</div>
          <div className="grid grid-cols-2 gap-5">
            <Stat label="ROC AUC" value={m.roc_auc.toFixed(3)} tone="cool" />
            <Stat label="PR AUC" value={m.pr_auc.toFixed(3)} sub={`base rate ${pct(m.base_rate, 2)}`} />
            <Stat label="Brier score" value={m.brier.toFixed(4)} sub="lower is better" tone="cool" />
            <Stat label="Loss MAE" value={`${m.loss_mae_bps}bp`} sub={`median loss ${m.loss_median_bps}bp`} />
          </div>

          <Separator className="my-5 bg-line" />
          <div className="eyebrow mb-3">Calibration</div>
          <ReliabilityPlot bins={m.reliability} />
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Predicted probability against observed frequency. Points on the dashed diagonal mean a stated 20%
            risk happens about 20% of the time.
          </p>
        </Panel>

        <Panel className="p-4">
          <div className="eyebrow mb-1">Feature importance</div>
          <h3 className="mb-4 text-base font-semibold">Permutation importance on held-out data</h3>
          <ImportanceChart items={report.feature_importance.slice(0, 10)} />

          <Separator className="my-4 bg-line" />
          <div className="space-y-1.5 text-[0.6875rem] text-ink-faint">
            <div className="flex justify-between">
              <span>Rows</span>
              <span className="num">
                {report.train_rows.toLocaleString()} train / {report.test_rows.toLocaleString()} test
              </span>
            </div>
            <div className="flex justify-between">
              <span>Split</span>
              <span className="num">{report.split}</span>
            </div>
            <div className="flex justify-between">
              <span>Training data</span>
              <span className="num text-warn">{report.data_source}</span>
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="mt-4 border-warn/40 p-4">
        <div className="eyebrow mb-3 text-warn">Known limitations</div>
        <ul className="grid gap-2.5 text-xs leading-relaxed text-ink-dim md:grid-cols-2">
          <li>
            <strong className="text-ink">Training data is simulated.</strong> Without a Helius key the corpus
            comes from the built-in simulator, not the chain. Metrics describe how well the model recovers a
            known generating process — they are not out-of-sample chain performance.
          </li>
          <li>
            <strong className="text-ink">Constant-product only.</strong> The economics assume an x·y=k curve.
            Uniswap V3 concentrates liquidity, so near spot a V3 pool is deeper than its TVL implies here, and
            thinner once price leaves the active range.
          </li>
          <li>
            <strong className="text-ink">PR AUC is capped by design.</strong> The label carries irreducible
            noise — whether a searcher is watching and wins the auction is a coin flip the features cannot
            observe — so no model reaches 1.0 on it.
          </li>
          <li>
            <strong className="text-ink">Single-hop, single-pool.</strong> Multi-hop routes and aggregator
            splits are not modelled; each leg would need its own scoring.
          </li>
        </ul>
      </Panel>
    </Section>
  )
}

function ReliabilityPlot({ bins }: { bins: ModelReport['metrics']['reliability'] }) {
  const max = Math.max(...bins.flatMap((b) => [b.predicted, b.observed]), 0.1) * 1.1

  return (
    <div className="h-[190px] w-full max-w-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 0 }}>
          <CartesianGrid stroke="var(--line)" />
          <XAxis
            type="number"
            dataKey="predicted"
            domain={[0, max]}
            tickFormatter={(v: number) => pct(v, 0)}
            tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-faint)' }}
            tickLine={false}
            axisLine={false}
            label={{
              value: 'predicted',
              position: 'insideBottom',
              offset: -10,
              style: { fill: 'var(--ink-faint)', fontSize: 9, fontFamily: 'var(--font-mono)' },
            }}
          />
          <YAxis
            type="number"
            dataKey="observed"
            domain={[0, max]}
            tickFormatter={(v: number) => pct(v, 0)}
            tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-faint)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          {/* perfect calibration */}
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: max, y: max },
            ]}
            stroke="var(--line-bright)"
            strokeDasharray="3 3"
          />
          <RTooltip
            cursor={{ stroke: 'var(--line-bright)' }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as ReliabilityBin | undefined
              return active && row ? <CalibrationTooltipView row={row} /> : null
            }}
          />
          <Scatter data={bins} fill="var(--cool)" fillOpacity={0.85} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
}

function CalibrationTooltipView({ row }: { row: ReliabilityBin }) {
  return (
    <div className="num rounded-sm border border-line-bright bg-void px-2.5 py-1.5 text-[0.625rem]">
      <div className="text-ink">predicted {pct(row.predicted, 1)}</div>
      <div className="text-cool">observed {pct(row.observed, 1)}</div>
      <div className="text-ink-faint">{row.count.toLocaleString()} swaps</div>
    </div>
  )
}

function ImportanceChart({ items }: { items: ModelReport['feature_importance'] }) {
  return (
    <div style={{ height: Math.max(160, items.length * 26) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={items} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--line)" horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => v.toFixed(3)}
            tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-faint)' }}
          />
          <YAxis
            type="category"
            dataKey="feature"
            width={150}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', fill: 'var(--ink-dim)' }}
          />
          <RTooltip
            cursor={{ fill: 'var(--raised)', fillOpacity: 0.5 }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as ImportanceRow | undefined
              if (!active || !row) return null
              return (
                <div className="num rounded-sm border border-line-bright bg-void px-2.5 py-1.5 text-[0.625rem]">
                  <div className="text-ink">{row.feature}</div>
                  <div className="text-info">
                    {row.importance.toFixed(4)} ± {row.std.toFixed(4)}
                  </div>
                </div>
              )
            }}
          />
          <RBar dataKey="importance" fill="var(--info)" radius={0} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** How the data gets in and how a sandwich is confirmed. */
export function MethodologySection() {
  const [meth, setMeth] = useState<Methodology | null>(null)
  const [openSql, setOpenSql] = useState<string | null>(null)

  useEffect(() => {
    api.methodology().then(setMeth).catch(() => {})
  }, [])

  if (!meth)
    return (
      <Section>
        <Skeleton className="h-64 bg-line/60" />
      </Section>
    )

  return (
    <Section
      id="methodology"
      className="!py-8"
      eyebrow="Methodology"
      title="Where the numbers come from"
      lede="Two ingestion paths, one detector, one optimiser. Every figure on this page is either measured from a swap stream or derived in closed form from the constant-product curve — nothing is a fudge factor except the two calibration constants named below."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {Object.entries(meth.sources).map(([chain, s]) => (
          <Panel key={chain} className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="eyebrow">{chain}</div>
              <span className="flex items-center gap-2 text-[0.6875rem] text-ink-faint">
                <LiveDot live={s.live} />
                {s.live ? 'live' : 'not configured'}
              </span>
            </div>
            <h3 className="mb-1.5 text-base font-semibold">{s.provider}</h3>
            <p className="text-xs leading-relaxed text-ink-dim">{s.detail}</p>
          </Panel>
        ))}

        <Panel className="p-4">
          <div className="eyebrow mb-3">Detection</div>
          <h3 className="mb-2 text-base font-semibold">Confirming a sandwich</h3>
          <p className="mb-3 text-xs text-ink-dim">{meth.detection.pattern}</p>
          <ul className="space-y-1.5">
            {meth.detection.criteria.map((c) => (
              <li key={c} className="flex gap-2 text-xs text-ink-dim">
                <span className="mt-1.5 size-1 shrink-0 bg-hot" />
                {c}
              </li>
            ))}
          </ul>
          <Separator className="my-3 bg-line" />
          <p className="text-[0.6875rem] leading-relaxed text-ink-faint">
            {meth.detection.loss_measurement}
          </p>
        </Panel>
      </div>

      <Panel className="mt-4 p-4">
        <div className="eyebrow mb-1">The optimisation</div>
        <h3 className="mb-3 text-base font-semibold">Objective and closed forms</h3>
        <div className="space-y-3">
          <Formula label="Expected cost" body={meth.optimisation.objective} />
          <Formula label="Front-run capacity" body={meth.optimisation.frontrun_capacity} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-dim">{meth.optimisation.note}</p>
      </Panel>

      <Panel className="mt-4 p-4">
        <div className="eyebrow mb-1">Ethereum ingestion</div>
        <h3 className="mb-4 text-base font-semibold">The BigQuery that labels the corpus</h3>
        <div className="space-y-2">
          {meth.bigquery_sql.map((q) => (
            <div key={q.name} className="overflow-hidden rounded-sm border border-line">
              <Button
                variant="ghost"
                onClick={() => setOpenSql(openSql === q.name ? null : q.name)}
                className="flex h-auto w-full items-center justify-between gap-3 rounded-none px-4 py-3 text-left hover:bg-raised"
              >
                <span>
                  <span className="num block text-xs text-ink">{q.name}</span>
                  <span className="block text-[0.6875rem] font-normal text-ink-faint">{q.purpose}</span>
                </span>
                <span className="num shrink-0 text-ink-faint">{openSql === q.name ? '−' : '+'}</span>
              </Button>
              {openSql === q.name && (
                <pre className="num overflow-x-auto border-t border-line bg-void px-4 py-3 text-[0.6875rem] leading-relaxed text-ink-dim">
                  {q.sql}
                </pre>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  )
}

function Formula({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-sm border border-line bg-void px-3 py-2">
      <div className="eyebrow mb-1.5">{label}</div>
      <code className="num block overflow-x-auto whitespace-pre text-xs text-cool">{body}</code>
    </div>
  )
}
