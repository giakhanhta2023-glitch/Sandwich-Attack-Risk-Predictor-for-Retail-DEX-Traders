import { useId, useMemo } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { CurvePoint } from '@/api'
import { usd, bps } from '@/api'

/**
 * Expected cost as a function of slippage tolerance.
 *
 * The curve is stacked into its two competing halves so the trade-off is
 * visible rather than asserted: MEV risk climbs to the right (a wider tolerance
 * is a bigger budget for a searcher), execution risk climbs to the left (a
 * tighter tolerance reverts and has to be resubmitted). The sum is U-shaped and
 * its floor is the recommendation.
 *
 * The x-axis is log-scaled because the interesting range spans 1bp to 2000bp
 * and retail tolerances cluster in the bottom decade of that.
 *
 * Unavoidable price impact is excluded from the plot. It is a constant in `s`,
 * so including it would only flatten the shape the chart exists to show; it is
 * reported separately underneath instead.
 */

interface Props {
  curve: CurvePoint[]
  /** What moving from the current tolerance to the recommended one saves, per trade. */
  savingUsd: number
  baselineUsd: number
  currentBps: number
  recommendedBps: number
  criticalBps: number
}

const TICKS = [1, 5, 10, 25, 50, 100, 300, 1000, 2000]

export function CostCurve({ curve, savingUsd, baselineUsd, currentBps, recommendedBps, criticalBps }: Props) {
  // gradient ids must be unique on the page, and useId's colons are not valid in url(#...)
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const attackFill = `cc-attack-${uid}`
  const executionFill = `cc-execution-${uid}`
  const data = useMemo(
    () =>
      curve.map((p) => {
        const attack = p.p_attack * p.attack_loss_usd
        const total = Math.max(0, p.expected_cost_usd - baselineUsd)
        return {
          ...p,
          attack,
          execution: Math.max(0, total - attack),
          total,
        }
      }),
    [curve, baselineUsd],
  )

  const minBps = data[0]?.slippage_bps ?? 1
  const maxBps = data[data.length - 1]?.slippage_bps ?? 2000
  const ticks = TICKS.filter((t) => t >= minBps && t <= maxBps)

  // snap the markers onto real samples so the dots sit on the drawn curve
  const nearest = (target: number) =>
    data.reduce(
      (best, d) => (Math.abs(d.slippage_bps - target) < Math.abs(best.slippage_bps - target) ? d : best),
      data[0],
    )
  const rec = nearest(recommendedBps)
  const cur = nearest(currentBps)
  const showCritical = criticalBps > minBps && criticalBps < maxBps

  return (
    <div>
      <div className="cost-curve h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 16, right: 16, bottom: 24, left: 4 }}>
            <defs>
              <linearGradient id={attackFill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--hot)', stopOpacity: 0.6 }} />
                <stop offset="100%" style={{ stopColor: 'var(--hot)', stopOpacity: 0.04 }} />
              </linearGradient>
              <linearGradient id={executionFill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--info)', stopOpacity: 0.4 }} />
                <stop offset="100%" style={{ stopColor: 'var(--info)', stopOpacity: 0.03 }} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="var(--line)" strokeDasharray="2 6" vertical={false} />

            <XAxis
              dataKey="slippage_bps"
              type="number"
              scale="log"
              domain={[minBps, maxBps]}
              ticks={ticks}
              tickFormatter={(v: number) => (v < 100 ? `${v}` : `${v / 100}%`)}
              tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-faint)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--line-bright)' }}
              label={{
                value: 'slippage tolerance (bp, log scale)',
                position: 'insideBottom',
                offset: -14,
                style: { fill: 'var(--ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' },
              }}
            />
            <YAxis
              domain={[0, 'auto']}
              tickFormatter={(v: number) => usd(v, v >= 100 ? 0 : v >= 1 ? 1 : 2)}
              tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--ink-faint)' }}
              tickLine={false}
              axisLine={false}
              width={62}
            />

            <Tooltip
              cursor={{ stroke: 'var(--ink)', strokeOpacity: 0.35 }}
              content={({ active, payload }) => {
                const row = payload?.find((entry) => 'total' in (entry.payload ?? {}))?.payload as Row | undefined
                return active && row ? <CostTooltipView row={row} /> : null
              }}
            />

            {/* execution risk sits under MEV risk; the stack top is the total */}
            <Area
              className="cc-execution"
              type="linear"
              dataKey="execution"
              stackId="cost"
              stroke="var(--info)"
              strokeWidth={1}
              fill={`url(#${executionFill})`}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Area
              className="cc-attack"
              type="linear"
              dataKey="attack"
              stackId="cost"
              stroke="var(--hot)"
              strokeWidth={1.5}
              fill={`url(#${attackFill})`}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              className="cc-total"
              type="linear"
              dataKey="total"
              stroke="var(--ink)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: 'var(--ink)', stroke: 'var(--void)', strokeWidth: 2 }}
              animationDuration={700}
              animationEasing="ease-out"
            />

            {/* what moving from your tolerance to the recommended one is worth */}
            {savingUsd >= 0.01 && cur.total > rec.total && (
              <ReferenceArea
                x1={Math.min(rec.slippage_bps, cur.slippage_bps)}
                x2={Math.max(rec.slippage_bps, cur.slippage_bps)}
                y1={rec.total}
                y2={cur.total}
                fill="var(--cool)"
                fillOpacity={0.07}
                stroke="var(--cool)"
                strokeOpacity={0.45}
                strokeDasharray="3 4"
                ifOverflow="visible"
                label={{
                  value: `you'd save ${usd(savingUsd)} a trade`,
                  position: 'insideTop',
                  offset: 8,
                  style: { fill: 'var(--cool)', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600 },
                }}
              />
            )}

            {/* to the left of this the sandwich cannot pay for its own gas */}
            {showCritical && (
              <ReferenceLine
                x={criticalBps}
                stroke="var(--warn)"
                strokeDasharray="4 4"
                label={{
                  value: `break-even ${bps(criticalBps)}`,
                  position: 'insideTopLeft',
                  style: { fill: 'var(--warn)', fontSize: 9.5, fontFamily: 'var(--font-mono)' },
                }}
              />
            )}

            <ReferenceLine
              x={cur.slippage_bps}
              stroke="var(--ink-faint)"
              label={{
                value: `yours ${usd(cur.total)}`,
                position: 'insideBottomLeft',
                style: { fill: 'var(--ink-dim)', fontSize: 9.5, fontFamily: 'var(--font-mono)' },
              }}
            />
            <ReferenceLine
              x={rec.slippage_bps}
              stroke="var(--cool)"
              strokeWidth={1.5}
              label={{
                value: 'optimal',
                position: 'insideBottomRight',
                style: { fill: 'var(--cool)', fontSize: 9.5, fontFamily: 'var(--font-mono)' },
              }}
            />
            <ReferenceDot x={cur.slippage_bps} y={cur.total} colour="var(--hot)" />
            <ReferenceDot x={rec.slippage_bps} y={rec.total} colour="var(--cool)" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 bg-hot/70" /> sandwich risk
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 bg-info/70" /> revert, retry &amp; chase
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-ink" /> average cost
        </span>

        <span className="ml-auto">plus {usd(baselineUsd)} unavoidable fee &amp; price impact</span>
      </div>
    </div>
  )
}

/**
 * Recharts has a ReferenceDot, but it renders under the areas at this stack
 * order; drawing the marker as a tiny overlay keeps it on top of the curve.
 */
function ReferenceDot({ x, y, colour }: { x: number; y: number; colour: string }) {
  return (
    <ReferenceLine
      segment={[
        { x, y },
        { x, y },
      ]}
      stroke={colour}
      strokeWidth={9}
      strokeLinecap="round"
      ifOverflow="visible"
    />
  )
}

type Row = CurvePoint & { attack: number; execution: number; total: number }

function CostTooltipView({ row }: { row: Row }) {
  return (
    <div className="rounded-sm border border-line-bright bg-void px-2.5 py-1.5">
      <div className="num text-[0.6875rem] text-ink">{bps(row.slippage_bps)} tolerance</div>
      <div className="num mt-1.5 space-y-0.5 text-[0.625rem]">
        <div className="flex justify-between gap-4 text-hot">
          <span>sandwich risk</span>
          <span>
            {usd(row.attack)} · {(row.p_attack * 100).toFixed(1)}%
          </span>
        </div>
        <div className="flex justify-between gap-4 text-info">
          <span>execution risk</span>
          <span>{usd(row.execution)}</span>
        </div>
        <div className="flex justify-between gap-4 border-t border-line pt-0.5 text-ink">
          <span>total</span>
          <span>{usd(row.total)}</span>
        </div>
      </div>
    </div>
  )
}
