import type { ReactNode } from 'react'

export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  className = '',
}: {
  id?: string
  eyebrow?: string
  title?: string
  lede?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={`relative z-10 mx-auto w-full max-w-[1400px] px-6 py-20 ${className}`}>
      {(eyebrow || title) && (
        <header className="mb-10 max-w-3xl">
          {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
          {title && (
            <h2 className="text-[2rem] leading-[1.1] font-semibold tracking-[-0.03em] text-ink md:text-[2.75rem]">
              {title}
            </h2>
          )}
          {lede && <p className="mt-4 text-[0.975rem] leading-relaxed text-ink-dim">{lede}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  size = 'md',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'neutral' | 'hot' | 'cool' | 'warn'
  size?: 'sm' | 'md' | 'lg'
}) {
  const toneClass = {
    neutral: 'text-ink',
    hot: 'text-hot',
    cool: 'text-cool',
    warn: 'text-warn',
  }[tone]
  const sizeClass = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-[2.5rem] leading-none',
  }[size]

  return (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      <div className={`num font-semibold ${sizeClass} ${toneClass}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-faint">{sub}</div>}
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'hot' | 'cool' | 'warn' | 'info'
}) {
  const tones = {
    neutral: 'border-line-bright text-ink-dim',
    hot: 'border-hot/40 text-hot bg-hot/8',
    cool: 'border-cool/40 text-cool bg-cool/8',
    warn: 'border-warn/40 text-warn bg-warn/8',
    info: 'border-info/40 text-info bg-info/8',
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[0.6875rem] tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-cool pulse-dot' : 'bg-ink-faint'}`}
    />
  )
}

/** Horizontal bar used in the dashboard tables. */
export function Bar({
  value,
  max,
  tone = 'hot',
}: {
  value: number
  max: number
  tone?: 'hot' | 'cool' | 'warn' | 'info'
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const colors = { hot: 'bg-hot', cool: 'bg-cool', warn: 'bg-warn', info: 'bg-info' }
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div
        className={`h-full rounded-full ${colors[tone]} transition-[width] duration-700 ease-out`}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-line/60 ${className}`} />
}
