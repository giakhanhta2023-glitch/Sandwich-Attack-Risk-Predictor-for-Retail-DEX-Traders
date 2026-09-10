import { useState, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge as ShadBadge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

export { Skeleton } from '@/components/ui/skeleton'

/**
 * shadcn Card carrying the project's panel treatment.
 *
 * `.panel` is declared outside Tailwind's cascade layers, so its gradient and
 * hairline win over Card's `bg-card` without needing `!important`; the padding
 * and gap Card ships with are cleared here so each panel sets its own.
 */
export function Panel({ className, ...props }: ComponentProps<typeof Card>) {
  return <Card className={cn('panel gap-0 py-0 shadow-none', className)} {...props} />
}

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
    <section id={id} className={cn('relative z-10 mx-auto w-full max-w-[1400px] px-6 py-20', className)}>
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
  return (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      <div
        className={cn(
          'num font-semibold',
          { sm: 'text-lg', md: 'text-2xl', lg: 'text-[2.5rem] leading-none' }[size],
          { neutral: 'text-ink', hot: 'text-hot', cool: 'text-cool', warn: 'text-warn' }[tone],
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-faint">{sub}</div>}
    </div>
  )
}

type Tone = 'neutral' | 'hot' | 'cool' | 'warn' | 'info'

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'border-line-bright bg-transparent text-ink-dim',
  hot: 'border-hot/40 bg-hot/10 text-hot',
  cool: 'border-cool/40 bg-cool/10 text-cool',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  info: 'border-info/40 bg-info/10 text-info',
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <ShadBadge
      variant="outline"
      className={cn('rounded-full font-mono text-[0.6875rem] font-normal tracking-wide', BADGE_TONES[tone])}
    >
      {children}
    </ShadBadge>
  )
}

export function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={cn('inline-block h-1.5 w-1.5 rounded-full', live ? 'bg-cool pulse-dot' : 'bg-ink-faint')}
      aria-label={live ? 'live' : 'offline'}
    />
  )
}

const BAR_TONES = {
  hot: '[&>[data-slot=progress-indicator]]:bg-hot',
  cool: '[&>[data-slot=progress-indicator]]:bg-cool',
  warn: '[&>[data-slot=progress-indicator]]:bg-warn',
  info: '[&>[data-slot=progress-indicator]]:bg-info',
}

/** Proportional bar used across the dashboard tables. */
export function Bar({
  value,
  max,
  tone = 'hot',
}: {
  value: number
  max: number
  tone?: keyof typeof BAR_TONES
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return <Progress value={pct} className={cn('h-1.5 bg-line', BAR_TONES[tone])} />
}


/**
 * Progressive disclosure for supporting detail.
 *
 * Most of what this app can show is evidence rather than decision: the
 * searcher's ledger, the model's attribution, the corpus, the calibration plot.
 * Useful for anyone asking "why should I believe this", noise for someone who
 * just wants to know what slippage to set. Collapsed by default keeps the
 * decision unobstructed; the summary line says what is inside, so hidden is
 * not the same as buried.
 */
export function Disclosure({
  label,
  hint,
  children,
  open,
  onOpenChange,
  defaultOpen = false,
  className,
}: {
  label: string
  hint?: string
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  className?: string
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const isOpen = open ?? uncontrolled
  const setOpen = onOpenChange ?? setUncontrolled

  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-3 rounded-xl border border-line px-4 py-3 text-left',
          'transition-colors hover:border-line-bright hover:bg-raised/40',
        )}
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-ink-faint transition-transform duration-200',
            isOpen && 'rotate-180',
          )}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">{label}</span>
          {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
        </span>
        <span className="num ml-auto shrink-0 text-[0.6875rem] text-ink-faint">
          {isOpen ? 'hide' : 'show'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="pt-5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
