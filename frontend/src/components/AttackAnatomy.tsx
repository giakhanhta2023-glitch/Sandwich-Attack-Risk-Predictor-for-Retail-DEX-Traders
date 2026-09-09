import { useEffect, useState } from 'react'

/**
 * The hero explainer: one block, three transactions, and the price path the
 * victim actually gets filled on.
 *
 * The point it has to land is that nothing here is a hack or an exploit -- the
 * ordering is legitimate, the searcher just pays to be first and last. So the
 * animation walks the block in execution order and shows the price moving under
 * the victim before their swap ever runs.
 */

const STEPS = [
  {
    actor: 'market',
    tag: 'Block N · pending',
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

const W = 720
const H = 190
const PAD = { l: 44, r: 20, t: 18, b: 34 }

export function AttackAnatomy() {
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), step === 0 ? 2200 : 2600)
    return () => clearTimeout(t)
  }, [step, playing])

  const prices = STEPS.map((s) => s.price)
  const min = Math.min(...prices) - 0.012
  const max = Math.max(...prices) + 0.012

  const x = (i: number) => PAD.l + (i / (STEPS.length - 1)) * (W - PAD.l - PAD.r)
  const y = (p: number) => PAD.t + (1 - (p - min) / (max - min)) * (H - PAD.t - PAD.b)

  const visible = STEPS.slice(0, step + 1)
  const path = visible.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(s.price)}`).join(' ')
  const active = STEPS[step]

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="eyebrow">Anatomy of a sandwich</div>
        <button
          onClick={() => setPlaying((p) => !p)}
          className="rounded-full border border-line-bright px-3 py-1 font-mono text-[0.6875rem] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
        >
          {playing ? '❙❙ pause' : '▶ play'}
        </button>
      </div>

      <div className="px-3 pt-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Price path during a sandwich attack">
          {/* baseline: the price you were quoted */}
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(1.0)}
            y2={y(1.0)}
            stroke="var(--color-line-bright)"
            strokeDasharray="3 4"
          />
          <text x={4} y={y(1.0) + 3} className="num" fontSize="9" fill="var(--color-ink-faint)">
            quoted
          </text>

          {/* the region the attacker opened up between quote and fill */}
          {step >= 2 && (
            <rect
              x={x(1)}
              y={y(1.048)}
              width={x(2) - x(1)}
              height={y(1.0) - y(1.048)}
              fill="var(--color-hot)"
              opacity="0.1"
            />
          )}

          <path
            d={path}
            fill="none"
            stroke="var(--color-hot)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {STEPS.map((s, i) => {
            const on = i <= step
            const isVictim = s.actor === 'victim'
            return (
              <g key={i} opacity={on ? 1 : 0.22}>
                <line
                  x1={x(i)}
                  x2={x(i)}
                  y1={y(s.price)}
                  y2={H - PAD.b}
                  stroke="var(--color-line)"
                  strokeWidth="1"
                />
                <circle
                  cx={x(i)}
                  cy={y(s.price)}
                  r={i === step ? 6 : 4}
                  fill={isVictim ? 'var(--color-ink)' : 'var(--color-hot)'}
                  stroke="var(--color-void)"
                  strokeWidth="2"
                />
                <text
                  x={x(i)}
                  y={H - PAD.b + 15}
                  textAnchor="middle"
                  className="num"
                  fontSize="9"
                  fill={i === step ? 'var(--color-ink)' : 'var(--color-ink-faint)'}
                >
                  {s.tag}
                </text>
              </g>
            )
          })}

          {step >= 2 && (
            <text
              x={(x(1) + x(2)) / 2}
              y={y(1.024)}
              textAnchor="middle"
              className="num"
              fontSize="10"
              fill="var(--color-hot)"
            >
              your loss
            </text>
          )}
        </svg>
      </div>

      <div className="border-t border-line px-5 py-4">
        <div className="flex items-baseline gap-2.5">
          <span
            className={`num text-[0.6875rem] uppercase tracking-widest ${
              active.actor === 'victim' ? 'text-ink' : active.actor === 'attacker' ? 'text-hot' : 'text-ink-faint'
            }`}
          >
            {active.actor}
          </span>
          <h3 className="text-[0.975rem] font-semibold text-ink">{active.title}</h3>
        </div>
        <p className="mt-1.5 min-h-[2.75rem] text-sm leading-relaxed text-ink-dim">{active.body}</p>

        <div className="mt-3 flex gap-1.5">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => {
                setPlaying(false)
                setStep(i)
              }}
              aria-label={`Step ${i + 1}`}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-hot' : 'bg-line'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
