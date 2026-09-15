import { useEffect, useState } from 'react'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import { live, liveConfigured } from '@/lib/live'
import type { LiveHour } from '@/lib/live'
import { LiveDot } from './primitives'

/**
 * Sandwich activity across Solana, hour by hour, from the live scanner.
 *
 * The cost curve above it is a model's average and smooth by nature. This is
 * the market that model describes, and it is not smooth. Each bar is sandwiches
 * caught per 1,000 swaps read that hour: a rate rather than a count, so an hour
 * with failed scans reads as missing coverage instead of as a quiet market.
 */

const REFRESH_MS = 60_000
// Below this many swaps an hour's rate is a handful of events, not a measurement.
const MIN_SWAPS = 5_000

type Row = LiveHour & { measured: boolean; shown: number }

export function LivePulse() {
  const [hours, setHours] = useState<LiveHour[] | null>(null)

  useEffect(() => {
    if (!liveConfigured) return
    let alive = true
    const load = () =>
      live
        .hourly()
        .then((h) => alive && setHours(h))
        .catch(() => {})
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  if (!liveConfigured || !hours?.length) return null

  const measuredRates = hours.filter((h) => h.swaps >= MIN_SWAPS && h.per_1k_swaps != null).map((h) => h.per_1k_swaps!)
  const peak = Math.max(0.1, ...measuredRates)
  const rows: Row[] = hours.map((h) => {
    const measured = h.swaps >= MIN_SWAPS && h.per_1k_swaps != null
    // an unmeasured hour keeps its place on the timeline as a faint stub
    return { ...h, measured, shown: measured ? h.per_1k_swaps! : peak * 0.06 }
  })

  const latest = [...rows].reverse().find((r) => r.measured)
  const latestAgeHours = latest ? (Date.now() - Date.parse(latest.hour)) / 3_600_000 : Infinity
  const current = latestAgeHours < 2
  const gaps = rows.filter((r) => !r.measured).length

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <LiveDot live={current} />
            <span className="eyebrow">Sandwiches across Solana &middot; last 24 hours</span>
          </div>
          <div className="mt-1 text-[0.6875rem] text-ink-faint">
            caught per 1,000 swaps the live scanner read, hour by hour
          </div>
        </div>
        <div className="text-right">
          {latest ? (
            <>
              <div className={`num text-xl font-semibold tracking-[-0.02em] ${current ? 'text-hot' : 'text-ink-dim'}`}>
                {latest.per_1k_swaps!.toFixed(2)}
              </div>
              <div className="text-[0.625rem] text-ink-faint">
                {current ? 'this hour' : `last measured ${hourLabel(latest.hour)}`}
              </div>
            </>
          ) : (
            <div className="text-[0.6875rem] text-warn">scanner has not read enough to measure</div>
          )}
        </div>
      </div>

      <div className="h-[72px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="18%">
            <YAxis hide domain={[0, 'auto']} />
            <Tooltip
              cursor={{ fill: 'var(--ink)', fillOpacity: 0.05 }}
              content={({ active, payload }) => {
                const row = payload?.[0]?.payload as Row | undefined
                return active && row ? <PulseTooltip row={row} /> : null
              }}
            />
            <Bar dataKey="shown" isAnimationActive animationDuration={600} radius={[1, 1, 0, 0]}>
              {rows.map((r, i) => (
                <Cell
                  key={r.hour}
                  fill={r.measured ? 'var(--hot)' : 'var(--line-bright)'}
                  fillOpacity={r.measured ? (i === rows.length - 1 ? 1 : 0.75) : 0.5}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1 flex justify-between text-[0.625rem] text-ink-faint">
        <span>24h ago</span>
        {gaps > 0 && <span>grey: hours the scanner read too little to measure</span>}
        <span>now</span>
      </div>
    </div>
  )
}

function hourLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function PulseTooltip({ row }: { row: Row }) {
  return (
    <div className="rounded-sm border border-line-bright bg-void px-2.5 py-1.5">
      <div className="num text-[0.6875rem] text-ink">{hourLabel(row.hour)}</div>
      {row.measured ? (
        <div className="num mt-1 space-y-0.5 text-[0.625rem]">
          <div className="text-hot">{row.per_1k_swaps!.toFixed(2)} per 1,000 swaps</div>
          <div className="text-ink-dim">
            {row.sandwiches.toLocaleString()} sandwiches in {row.swaps.toLocaleString()} swaps
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[0.625rem] text-ink-faint">
          scanner read {row.swaps.toLocaleString()} swaps, too few to measure
        </div>
      )}
    </div>
  )
}
