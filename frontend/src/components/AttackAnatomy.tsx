import { useEffect, useState } from 'react'
import {
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import type { DotProps } from 'recharts'
import { Button } from '@/components/ui/button'

/**
 * The hero explainer: one block, three transactions, and the price path your
 * swap actually gets filled on.
 *
 * The point it has to land is that nothing here is a hack -- the ordering is
 * legitimate, the searcher just pays to be first and last. So the animation
 * walks the block in execution order and shows the price moving under the
 * victim before their swap ever runs.
 */

const STEPS = [
  {
    actor: 'market',
    tag: 'pending',
    title: 'You submit a swap',
    body: 'Your transaction sits in the public mempool with a slippage tolerance attached. Anyone can read both.',
    price: 1.0,
  },
  {
    actor: 'attacker',
    tag: 'tx #1',
    title: 'Searcher front-runs',
    body: 'A bot pays a higher priority fee to land immediately before you, buying the same token and pushing the price up.',
    price: 1.031,
  },
  {
    actor: 'victim',
    tag: 'tx #2',
    title: 'Your swap fills — worse',
    body: 'You still execute, because the bot moved the price to just inside the tolerance you allowed. You receive less.',
    price: 1.048,
  },
  {
    actor: 'attacker',
    tag: 'tx #3',
    title: 'Searcher back-runs',
    body: 'The bot immediately sells what it just bought into the price your trade created. The difference is their profit.',
    price: 1.014,
  },
] as const

export function AttackAnatomy() {
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), step === 0 ? 2200 : 2600)
    return () => clearTimeout(t)
  }, [step, playing])

  // Recharts draws a Line across every row, so the reveal is done by nulling
  // the price of steps that have not happened yet rather than slicing the array
  // -- that keeps the x-axis stable instead of rescaling on each tick.
  const data = STEPS.map((s, i) => ({
    idx: i,
    tag: s.tag,
    actor: s.actor,
    price: i <= step ? s.price : null,
  }))

  const active = STEPS[step]

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="eyebrow">Anatomy of a sandwich</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPlaying((p) => !p)}
          className="num h-7 rounded-full border-line-bright bg-transparent px-3 text-[0.6875rem] text-ink-dim hover:border-ink-faint hover:text-ink"
        >
          {playing ? '❙❙ pause' : '▶ play'}
        </Button>
      </div>

      <div className="h-[190px] px-2 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 14, right: 16, bottom: 6, left: 30 }}>
            <XAxis
              dataKey="tag"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 9, fontFamily: 'var(--font-mono)', fill: 'var(--ink-faint)' }}
            />
            <YAxis domain={[0.996, 1.06]} hide />

            {/* the price you were quoted, before anyone touched the block */}
            <ReferenceLine
              y={1.0}
              stroke="var(--line-bright)"
              strokeDasharray="3 4"
              label={{
                value: 'quoted',
                position: 'left',
                style: { fill: 'var(--ink-faint)', fontSize: 9, fontFamily: 'var(--font-mono)' },
              }}
            />

            {/* the gap the searcher opened between your quote and your fill */}
            {step >= 2 && (
              <ReferenceArea
                x1="tx #1"
                x2="tx #2"
                y1={1.0}
                y2={1.048}
                fill="var(--hot)"
                fillOpacity={0.12}
                label={{
                  value: 'your loss',
                  style: { fill: 'var(--hot)', fontSize: 10, fontFamily: 'var(--font-mono)' },
                }}
              />
            )}

            <Line
              type="linear"
              dataKey="price"
              stroke="var(--hot)"
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
              dot={<StepDot activeIndex={step} />}
              activeDot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-line px-5 py-4">
        <div className="flex items-baseline gap-2.5">
          <span
            className={`num text-[0.6875rem] uppercase tracking-widest ${
              active.actor === 'victim'
                ? 'text-ink'
                : active.actor === 'attacker'
                  ? 'text-hot'
                  : 'text-ink-faint'
            }`}
          >
            {active.actor}
          </span>
          <h3 className="text-[0.975rem] font-semibold text-ink">{active.title}</h3>
        </div>
        <p className="mt-1.5 min-h-[2.75rem] text-sm leading-relaxed text-ink-dim">{active.body}</p>

        <div className="mt-3 flex gap-1.5">
          {STEPS.map((s, i) => (
            <button
              key={s.tag}
              onClick={() => {
                setPlaying(false)
                setStep(i)
              }}
              aria-label={`Step ${i + 1}: ${s.title}`}
              className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-hot' : 'bg-line'}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Victim fill is inked, searcher legs are hot, the current step is enlarged. */
function StepDot({ cx, cy, payload, activeIndex }: DotProps & { payload?: { idx: number; actor: string }; activeIndex?: number }) {
  if (cx == null || cy == null || !payload) return null
  const isVictim = payload.actor === 'victim'
  const isCurrent = payload.idx === activeIndex
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isCurrent ? 6 : 4}
      fill={isVictim ? 'var(--ink)' : 'var(--hot)'}
      stroke="var(--void)"
      strokeWidth={2}
    />
  )
}
