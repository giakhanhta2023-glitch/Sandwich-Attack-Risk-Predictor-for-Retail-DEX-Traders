import { useMemo } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
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
  baselineUsd: number
  currentBps: number
  recommendedBps: number
  criticalBps: number
}

const TICKS = [1, 5, 10, 25, 50, 100, 300, 1000, 2000]

export function CostCurve({ curve, baselineUsd, currentBps, recommendedBps, criticalBps }: Props) {
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
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 16, right: 16, bottom: 24, left: 4 }}>
            <defs>
              <linearGradient id="gradAttack" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--hot)" stopOpacity={0.5} />
                <stop offset="100%" stopColor="var(--hot)" stopOpacity={0.06} />
              </linearGradient>
              <linearGradient id="gradExecution" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--info)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--info)" stopOpacity={0.04} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="var(--line)" vertical={false} />

            <XAxis
              dataKey="slippage_bps"
              type="number"
              scale="log"
              domain={[minBps, maxBps]}
              ticks={ticks}
              tickFormatter={(v: number) => (v < 100 ? `${v}` : `${v / 100}%`)}
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
              tickFormatter={(v: number) => usd(v, v >= 100 ? 0 : v >= 1 ? 1 : 2)}
              tickLine={false}
              axisLine={false}
              width={62}
            />

            <Tooltip
              cursor={{ stroke: 'var(--ink)', strokeOpacity: 0.35 }}
              content={({ active, payload }) => {
                const row = payload?.[0]?.payload as Row | undefined
                return active && row ? <CostTooltipView row={row} /> : null
              }}
            />

            {/* execution risk sits under MEV risk; the stack top is the total */}
            <Area
              type="monotone"
              dataKey="execution"
              stackId="cost"
              stroke="none"
              fill="url(#gradExecution)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="attack"
              stackId="cost"
              stroke="none"
              fill="url(#gradAttack)"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke="var(--ink)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3.5, fill: 'var(--ink)' }}
              isAnimationActive={false}
            />

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
                value: 'yours',
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
            <ReferenceDot x={rec.slippage_bps} y={rec.total} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-hot/60" /> sandwich risk
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-info/50" /> revert, retry &amp; chase
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-ink" /> total controllable cost
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
function ReferenceDot({ x, y }: { x: number; y: number }) {
  return (
    <ReferenceLine
      segment={[
        { x, y },
        { x, y },
      ]}
      stroke="var(--cool)"
      strokeWidth={7}
      strokeLinecap="round"
      ifOverflow="visible"
    />
  )
}

type Row = CurvePoint & { attack: number; execution: number; total: number }

function CostTooltipView({ row }: { row: Row }) {
  return (
    <div className="rounded-lg border border-line-bright bg-void/95 px-3 py-2 shadow-lg backdrop-blur-sm">
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
