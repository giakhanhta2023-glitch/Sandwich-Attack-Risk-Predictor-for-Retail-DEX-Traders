import { useMemo, useRef, useState } from 'react'
import type { CurvePoint } from '../api'
import { usd, bps } from '../api'

/**
 * Expected cost as a function of slippage tolerance.
 *
 * The curve is stacked into its two competing halves so the trade-off is
 * visible rather than asserted: MEV risk climbs to the right (a wider tolerance
 * is a bigger budget for a searcher), execution risk climbs to the left (a
 * tighter tolerance reverts and has to be resubmitted). The sum is U-shaped and
 * its floor is the recommendation.
 *
 * Unavoidable price impact is excluded from the plot. It is a constant in `s`,
 * so including it would only flatten the shape the chart exists to show; it is
 * reported separately underneath instead.
 */

const W = 860
const H = 320
const PAD = { l: 62, r: 22, t: 22, b: 46 }

interface Props {
  curve: CurvePoint[]
  baselineUsd: number
  currentBps: number
  recommendedBps: number
  criticalBps: number
}

export function CostCurve({ curve, baselineUsd, currentBps, recommendedBps, criticalBps }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const data = useMemo(() => {
    return curve.map((p) => {
      const attack = p.p_attack * p.attack_loss_usd
      const total = Math.max(0, p.expected_cost_usd - baselineUsd)
      return {
        ...p,
        attack,
        execution: Math.max(0, total - attack),
        total,
      }
    })
  }, [curve, baselineUsd])

  const minBps = data[0]?.slippage_bps ?? 1
  const maxBps = data[data.length - 1]?.slippage_bps ?? 2000
  const maxCost = Math.max(...data.map((d) => d.total)) || 1

  const lx = Math.log(minBps)
  const rx = Math.log(maxBps)
  const x = (b: number) => PAD.l + ((Math.log(Math.max(b, minBps)) - lx) / (rx - lx)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - v / maxCost) * (H - PAD.t - PAD.b)

  const areaPath = (key: 'attack' | 'total') => {
    const top = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(d.slippage_bps)} ${y(d[key])}`).join(' ')
    return `${top} L ${x(maxBps)} ${y(0)} L ${x(minBps)} ${y(0)} Z`
  }

  const linePath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(d.slippage_bps)} ${y(d.total)}`)
    .join(' ')

  const nearest = (targetBps: number) =>
    data.reduce((best, d, i) =>
      Math.abs(d.slippage_bps - targetBps) < Math.abs(data[best].slippage_bps - targetBps) ? i : best,
    0)

  const recIdx = nearest(recommendedBps)
  const curIdx = nearest(currentBps)
  const hovered = hoverIdx !== null ? data[hoverIdx] : null

  const ticks = [1, 5, 10, 25, 50, 100, 300, 1000, 2000].filter((t) => t >= minBps && t <= maxBps)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxCost)

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    if (px < PAD.l || px > W - PAD.r) return setHoverIdx(null)
    const targetLog = lx + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (rx - lx)
    setHoverIdx(nearest(Math.exp(targetLog)))
  }

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Expected cost versus slippage tolerance"
      >
        <defs>
          <linearGradient id="gradAttack" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-hot)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--color-hot)" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-info)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--color-info)" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* horizontal guides */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--color-line)"
              strokeWidth="1"
            />
            <text x={PAD.l - 8} y={y(v) + 3.5} textAnchor="end" className="num" fontSize="10" fill="var(--color-ink-faint)">
              {usd(v, v >= 100 ? 0 : v >= 1 ? 1 : 2)}
            </text>
          </g>
        ))}

        {/* execution risk sits under the total line, MEV risk is drawn on top */}
        <path d={areaPath('total')} fill="url(#gradTotal)" />
        <path d={areaPath('attack')} fill="url(#gradAttack)" />
        <path d={linePath} fill="none" stroke="var(--color-ink)" strokeWidth="2" />

        {/* the break-even tolerance: to its left a sandwich cannot pay for itself */}
        {criticalBps > minBps && criticalBps < maxBps && (
          <g>
            <line
              x1={x(criticalBps)}
              x2={x(criticalBps)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="var(--color-warn)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <text
              x={x(criticalBps) + 5}
              y={PAD.t + 11}
              className="num"
              fontSize="9.5"
              fill="var(--color-warn)"
            >
              break-even {bps(criticalBps)}
            </text>
          </g>
        )}

        {/* current setting */}
        <g>
          <line
            x1={x(data[curIdx].slippage_bps)}
            x2={x(data[curIdx].slippage_bps)}
            y1={y(data[curIdx].total)}
            y2={H - PAD.b}
            stroke="var(--color-ink-faint)"
            strokeWidth="1"
          />
          <circle
            cx={x(data[curIdx].slippage_bps)}
            cy={y(data[curIdx].total)}
            r="4.5"
            fill="var(--color-void)"
            stroke="var(--color-ink-dim)"
            strokeWidth="2"
          />
          <text
            x={x(data[curIdx].slippage_bps)}
            y={H - PAD.b + 26}
            textAnchor="middle"
            className="num"
            fontSize="9.5"
            fill="var(--color-ink-dim)"
          >
            yours
          </text>
        </g>

        {/* the recommendation */}
        <g>
          <line
            x1={x(data[recIdx].slippage_bps)}
            x2={x(data[recIdx].slippage_bps)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="var(--color-cool)"
            strokeWidth="1.5"
          />
          <circle
            cx={x(data[recIdx].slippage_bps)}
            cy={y(data[recIdx].total)}
            r="6"
            fill="var(--color-cool)"
            stroke="var(--color-void)"
            strokeWidth="2.5"
          />
          <text
            x={x(data[recIdx].slippage_bps)}
            y={H - PAD.b + 26}
            textAnchor="middle"
            className="num"
            fontSize="9.5"
            fill="var(--color-cool)"
          >
            optimal
          </text>
        </g>

        {/* hover readout */}
        {hovered && hoverIdx !== null && (
          <g pointerEvents="none">
            <line
              x1={x(hovered.slippage_bps)}
              x2={x(hovered.slippage_bps)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="var(--color-ink)"
              strokeWidth="1"
              strokeOpacity="0.35"
            />
            <circle cx={x(hovered.slippage_bps)} cy={y(hovered.total)} r="3.5" fill="var(--color-ink)" />
            <g
              transform={`translate(${Math.min(
                Math.max(x(hovered.slippage_bps) - 78, PAD.l),
                W - PAD.r - 156,
              )}, ${PAD.t + 4})`}
            >
              <rect width="156" height="62" rx="7" fill="var(--color-void)" stroke="var(--color-line-bright)" />
              <text x="10" y="17" className="num" fontSize="10" fill="var(--color-ink)">
                {bps(hovered.slippage_bps)} tolerance
              </text>
              <text x="10" y="33" className="num" fontSize="9.5" fill="var(--color-hot)">
                MEV {usd(hovered.attack)} · {(hovered.p_attack * 100).toFixed(1)}%
              </text>
              <text x="10" y="47" className="num" fontSize="9.5" fill="var(--color-info)">
                execution {usd(hovered.execution)}
              </text>
              <text x="10" y="58" className="num" fontSize="9" fill="var(--color-ink-faint)">
                total {usd(hovered.total)}
              </text>
            </g>
          </g>
        )}

        {/* x axis */}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--color-line-bright)" />
        {ticks.map((t) => (
          <text
            key={t}
            x={x(t)}
            y={H - PAD.b + 14}
            textAnchor="middle"
            className="num"
            fontSize="10"
            fill="var(--color-ink-faint)"
          >
            {t < 100 ? `${t}` : `${t / 100}%`}
          </text>
        ))}
        <text x={W / 2} y={H - 4} textAnchor="middle" className="num" fontSize="10" fill="var(--color-ink-faint)">
          slippage tolerance (bp, log scale)
        </text>
      </svg>

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
        <span className="ml-auto">
          plus {usd(baselineUsd)} unavoidable fee &amp; price impact
        </span>
      </div>
    </div>
  )
}
