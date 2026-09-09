import { useEffect, useState } from 'react'
import { api, usd, compactUsd, pct, bps } from '../api'
import type { CorpusStats, Methodology, ModelReport } from '../api'
import { Badge, Bar, LiveDot, Section, Skeleton, Stat } from './primitives'

/** Corpus-level view: where sandwiches actually land. */
export function CorpusDashboard() {
  const [stats, setStats] = useState<CorpusStats | null>(null)

  useEffect(() => {
    api.stats().then(setStats).catch(() => setStats({ available: false }))
  }, [])

  if (!stats) return <Section><Skeleton className="h-64" /></Section>
  if (!stats.available) {
    return (
      <Section eyebrow="Corpus" title="No corpus yet">
        <p className="text-ink-dim">{stats.reason ?? 'Train the model to populate this view.'}</p>
      </Section>
    )
  }

  const maxPoolRate = Math.max(...(stats.by_pool ?? []).map((p) => p.attack_rate), 0.01)
  const maxSlipRate = Math.max(...(stats.by_slippage ?? []).map((p) => p.attack_rate), 0.01)
  const maxSizeRate = Math.max(...(stats.by_size ?? []).map((p) => p.attack_rate), 0.01)

  return (
    <Section
      id="corpus"
      eyebrow="Corpus"
      title="Risk is not spread evenly"
      lede="Attack rates across the labelled corpus. The pattern is consistent: sandwiches concentrate where a wide tolerance meets a thin pool, and almost vanish where the pool's own fee tier costs the searcher more than the trade is worth."
    >
      <div className="panel mb-5 grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-ground p-5">
          <Stat label="Swaps analysed" value={stats.total_swaps?.toLocaleString()} />
        </div>
        <div className="bg-ground p-5">
          <Stat label="Sandwiches detected" value={stats.total_sandwiches?.toLocaleString()} tone="hot" />
        </div>
        <div className="bg-ground p-5">
          <Stat label="Overall attack rate" value={pct(stats.overall_attack_rate ?? 0, 2)} tone="hot" />
        </div>
        <div className="bg-ground p-5">
          <Stat
            label="Median loss when hit"
            value={bps(stats.median_loss_bps ?? 0)}
            sub={`${usd(stats.median_loss_usd ?? 0)} on a median victim`}
            tone="warn"
          />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="panel p-5">
          <div className="eyebrow mb-1">By tolerance</div>
          <h3 className="mb-1 text-base font-semibold">Attack rate vs the slippage you set</h3>
          <p className="mb-4 text-xs text-ink-faint">
            The single controllable input. Every extra basis point of tolerance is budget handed to a searcher.
          </p>
          <div className="space-y-3">
            {stats.by_slippage?.map((b) => (
              <div key={b.bucket}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                  <span className="num text-ink-dim">{b.bucket}</span>
                  <span className="flex items-baseline gap-3">
                    <span className="num text-ink-faint">{b.swaps.toLocaleString()} swaps</span>
                    <span className="num w-12 text-right text-hot">{pct(b.attack_rate, 1)}</span>
                  </span>
                </div>
                <Bar value={b.attack_rate} max={maxSlipRate} tone="hot" />
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-5">
          <div className="eyebrow mb-1">By trade size</div>
          <h3 className="mb-1 text-base font-semibold">Attack rate vs notional</h3>
          <p className="mb-4 text-xs text-ink-faint">
            Small trades are usually safe not because bots miss them, but because the gas and bundle bid exceed
            what can be extracted.
          </p>
          <div className="space-y-3">
            {stats.by_size?.map((b) => (
              <div key={b.bucket}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                  <span className="num text-ink-dim">{b.bucket}</span>
                  <span className="flex items-baseline gap-3">
                    <span className="num text-ink-faint">
                      {b.median_loss_usd > 0 ? `${usd(b.median_loss_usd)} median loss` : '—'}
                    </span>
                    <span className="num w-12 text-right text-hot">{pct(b.attack_rate, 1)}</span>
                  </span>
                </div>
                <Bar value={b.attack_rate} max={maxSizeRate} tone="hot" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel mt-5 p-5">
        <div className="eyebrow mb-1">By pool</div>
        <h3 className="mb-4 text-base font-semibold">Where the extraction happens</h3>
        <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {['Pool', 'Chain', 'Depth', 'Swaps', 'Hit', 'Median loss', 'Attack rate'].map((h) => (
                  <th key={h} className="eyebrow pb-2 font-normal last:text-right">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.by_pool?.map((p) => (
                <tr key={p.pool_id} className="border-b border-line/60 last:border-0">
                  <td className="py-2.5">
                    <div className="font-medium text-ink">{p.symbol}</div>
                    <div className="text-[0.6875rem] text-ink-faint">{p.venue}</div>
                  </td>
                  <td className="py-2.5">
                    <Badge tone={p.chain === 'solana' ? 'info' : 'neutral'}>{p.chain}</Badge>
                  </td>
                  <td className="num py-2.5 text-ink-dim">{compactUsd(p.tvl_usd)}</td>
                  <td className="num py-2.5 text-ink-faint">{p.swaps.toLocaleString()}</td>
                  <td className="num py-2.5 text-ink-faint">{p.sandwiched.toLocaleString()}</td>
                  <td className="num py-2.5 text-warn">{p.median_loss_bps ? bps(p.median_loss_bps) : '—'}</td>
                  <td className="py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      <div className="hidden w-24 sm:block">
                        <Bar value={p.attack_rate} max={maxPoolRate} tone="hot" />
                      </div>
                      <span className="num w-12 text-right text-hot">{pct(p.attack_rate, 1)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
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
          Run <code className="num rounded bg-surface px-1.5 py-0.5 text-ink">python -m backend.ml.train</code> to
          build the model artifacts.
        </p>
      </Section>
    )
  }
  if (!report) return <Section><Skeleton className="h-64" /></Section>

  const m = report.metrics
  const maxImp = Math.max(...report.feature_importance.map((f) => f.importance), 0.0001)

  return (
    <Section
      id="model"
      eyebrow="Model card"
      title="What the model is, and where it is weak"
      lede="Gradient-boosted trees with isotonic calibration, split chronologically by block so no future regime leaks backwards. Calibration matters more than ranking here: the recommendation multiplies this probability by a dollar loss, so a confidently wrong score produces a confidently wrong slippage."
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <div className="panel p-5">
          <div className="eyebrow mb-4">Held-out performance</div>
          <div className="grid grid-cols-2 gap-5">
            <Stat label="ROC AUC" value={m.roc_auc.toFixed(3)} tone="cool" />
            <Stat label="PR AUC" value={m.pr_auc.toFixed(3)} sub={`base rate ${pct(m.base_rate, 2)}`} />
            <Stat label="Brier score" value={m.brier.toFixed(4)} sub="lower is better" tone="cool" />
            <Stat label="Loss MAE" value={`${m.loss_mae_bps}bp`} sub={`median loss ${m.loss_median_bps}bp`} />
          </div>

          <div className="mt-6 border-t border-line pt-4">
            <div className="eyebrow mb-3">Calibration</div>
            <ReliabilityPlot bins={m.reliability} />
            <p className="mt-3 text-xs leading-relaxed text-ink-faint">
              Predicted probability against observed frequency. Points on the diagonal mean a stated 20% risk
              happens about 20% of the time.
            </p>
          </div>
        </div>

        <div className="panel p-5">
          <div className="eyebrow mb-1">Feature importance</div>
          <h3 className="mb-4 text-base font-semibold">Permutation importance on held-out data</h3>
          <div className="space-y-2.5">
            {report.feature_importance.slice(0, 10).map((f) => (
              <div key={f.feature}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="num text-ink-dim">{f.feature}</span>
                  <span className="num text-ink-faint">{f.importance.toFixed(4)}</span>
                </div>
                <Bar value={f.importance} max={maxImp} tone="info" />
              </div>
            ))}
          </div>
          <div className="mt-5 space-y-1.5 border-t border-line pt-4 text-[0.6875rem] text-ink-faint">
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
        </div>
      </div>

      <div className="panel mt-5 border-warn/25 p-5">
        <div className="eyebrow mb-3 text-warn">Known limitations</div>
        <ul className="grid gap-2.5 text-xs leading-relaxed text-ink-dim md:grid-cols-2">
          <li>
            <strong className="text-ink">Training data is simulated.</strong> Without a Helius key or GCP
            credentials the corpus comes from the built-in simulator, not the chain. Metrics describe how well the
            model recovers a known generating process — they are not out-of-sample chain performance.
          </li>
          <li>
            <strong className="text-ink">Constant-product only.</strong> The economics assume an x·y=k curve.
            Uniswap V3 concentrates liquidity, so near spot a V3 pool is deeper than its TVL implies here, and
            thinner once price leaves the active range.
          </li>
          <li>
            <strong className="text-ink">PR AUC is capped by design.</strong> The label carries irreducible noise
            — whether a searcher is watching and wins the auction is a coin flip the features cannot observe — so
            no model reaches 1.0 on it.
          </li>
          <li>
            <strong className="text-ink">Single-hop, single-pool.</strong> Multi-hop routes and aggregator
            splits are not modelled; each leg would need its own scoring.
          </li>
        </ul>
      </div>
    </Section>
  )
}

function ReliabilityPlot({ bins }: { bins: ModelReport['metrics']['reliability'] }) {
  const S = 160
  const P = 22
  const scale = (v: number) => P + v * (S - 2 * P)

  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[220px]" role="img" aria-label="Calibration plot">
      <line x1={P} y1={S - P} x2={S - P} y2={P} stroke="var(--color-line-bright)" strokeDasharray="3 3" />
      <line x1={P} y1={P} x2={P} y2={S - P} stroke="var(--color-line)" />
      <line x1={P} y1={S - P} x2={S - P} y2={S - P} stroke="var(--color-line)" />
      {bins.map((b, i) => (
        <circle
          key={i}
          cx={scale(b.predicted)}
          cy={S - scale(b.observed)}
          r={3.5}
          fill="var(--color-cool)"
          opacity={0.85}
        />
      ))}
      <text x={S / 2} y={S - 4} textAnchor="middle" className="num" fontSize="7" fill="var(--color-ink-faint)">
        predicted
      </text>
      <text
        x={8}
        y={S / 2}
        textAnchor="middle"
        className="num"
        fontSize="7"
        fill="var(--color-ink-faint)"
        transform={`rotate(-90 8 ${S / 2})`}
      >
        observed
      </text>
    </svg>
  )
}

/** How the data gets in and how a sandwich is confirmed. */
export function MethodologySection() {
  const [meth, setMeth] = useState<Methodology | null>(null)
  const [openSql, setOpenSql] = useState<string | null>(null)

  useEffect(() => {
    api.methodology().then(setMeth).catch(() => {})
  }, [])

  if (!meth) return <Section><Skeleton className="h-64" /></Section>

  return (
    <Section
      id="methodology"
      eyebrow="Methodology"
      title="Where the numbers come from"
      lede="Two ingestion paths, one detector, one optimiser. Every figure on this page is either measured from a swap stream or derived in closed form from the constant-product curve — nothing is a fudge factor except the two calibration constants named below."
    >
      <div className="grid gap-5 lg:grid-cols-3">
        {Object.entries(meth.sources).map(([chain, s]) => (
          <div key={chain} className="panel p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="eyebrow">{chain}</div>
              <span className="flex items-center gap-2 text-[0.6875rem] text-ink-faint">
                <LiveDot live={s.live} />
                {s.live ? 'live' : 'not configured'}
              </span>
            </div>
            <h3 className="mb-1.5 text-base font-semibold">{s.provider}</h3>
            <p className="text-xs leading-relaxed text-ink-dim">{s.detail}</p>
          </div>
        ))}

        <div className="panel p-5">
          <div className="eyebrow mb-3">Detection</div>
          <h3 className="mb-2 text-base font-semibold">Confirming a sandwich</h3>
          <p className="mb-3 text-xs text-ink-dim">{meth.detection.pattern}</p>
          <ul className="space-y-1.5">
            {meth.detection.criteria.map((c) => (
              <li key={c} className="flex gap-2 text-xs text-ink-dim">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-hot" />
                {c}
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
            {meth.detection.loss_measurement}
          </p>
        </div>
      </div>

      <div className="panel mt-5 p-5">
        <div className="eyebrow mb-1">The optimisation</div>
        <h3 className="mb-3 text-base font-semibold">Objective and closed forms</h3>
        <div className="space-y-3">
          <Formula label="Expected cost" body={meth.optimisation.objective} />
          <Formula label="Front-run capacity" body={meth.optimisation.frontrun_capacity} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-dim">{meth.optimisation.note}</p>
      </div>

      <div className="panel mt-5 p-5">
        <div className="eyebrow mb-1">Ethereum ingestion</div>
        <h3 className="mb-4 text-base font-semibold">The BigQuery that labels the corpus</h3>
        <div className="space-y-2">
          {meth.bigquery_sql.map((q) => (
            <div key={q.name} className="overflow-hidden rounded-lg border border-line">
              <button
                onClick={() => setOpenSql(openSql === q.name ? null : q.name)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-raised"
              >
                <span>
                  <span className="num block text-xs text-ink">{q.name}</span>
                  <span className="block text-[0.6875rem] text-ink-faint">{q.purpose}</span>
                </span>
                <span className="num shrink-0 text-ink-faint">{openSql === q.name ? '−' : '+'}</span>
              </button>
              {openSql === q.name && (
                <pre className="num overflow-x-auto border-t border-line bg-void px-4 py-3 text-[0.6875rem] leading-relaxed text-ink-dim">
                  {q.sql}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </Section>
  )
}

function Formula({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-lg border border-line bg-void px-4 py-3">
      <div className="eyebrow mb-1.5">{label}</div>
      <code className="num block overflow-x-auto whitespace-pre text-xs text-cool">{body}</code>
    </div>
  )
}
