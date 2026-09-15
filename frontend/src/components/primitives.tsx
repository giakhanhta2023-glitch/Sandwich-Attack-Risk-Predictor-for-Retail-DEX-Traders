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
  return <Card className={cn('panel gap-0 rounded-sm py-0 shadow-none', className)} {...props} />
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
    <section id={id} className={cn('relative z-10 mx-auto w-full max-w-[1600px] px-6 py-10', className)}>
      {(eyebrow || title) && (
        <header className="mb-6 max-w-3xl">
          {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
          {title && (
            <h2 className="text-[1.375rem] leading-tight font-semibold tracking-[-0.01em] text-ink md:text-[1.625rem]">
              {title}
            </h2>
          )}
          {lede && <p className="mt-2 max-w-2xl text-[0.8125rem] leading-relaxed text-ink-dim">{lede}</p>}
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
      <div className="eyebrow mb-1">{label}</div>
      <div
        className={cn(
          'num font-semibold',
          { sm: 'text-base', md: 'text-xl', lg: 'text-[2rem] leading-none tracking-[-0.02em]' }[size],
          { neutral: 'text-ink', hot: 'text-hot', cool: 'text-cool', warn: 'text-warn' }[tone],
        )}
      >
        {value}
      </div>
      {sub && <div className="num mt-1 text-[0.6875rem] text-ink-faint">{sub}</div>}
    </div>
  )
}

type Tone = 'neutral' | 'hot' | 'cool' | 'warn' | 'info'

// Tone is carried by the border and the label, not by a filled background.
const BADGE_TONES: Record<Tone, string> = {
  neutral: 'border-line text-ink-dim',
  hot: 'border-hot/50 text-hot',
  cool: 'border-cool/50 text-cool',
  warn: 'border-warn/50 text-warn',
  info: 'border-line-bright text-ink-dim',
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <ShadBadge
      variant="outline"
      className={cn(
        'rounded-sm bg-transparent px-1.5 py-0 font-mono text-[0.625rem] font-normal tracking-wide uppercase',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </ShadBadge>
  )
}

export function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={cn('inline-block size-1.5', live ? 'bg-cool pulse-dot' : 'bg-line-bright')}
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
  return <Progress value={pct} className={cn('h-1 rounded-none bg-line', BAR_TONES[tone])} />
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
          'group flex w-full items-center gap-2.5 rounded-sm border border-line bg-surface px-3 py-2 text-left',
          'transition-colors hover:border-line-bright hover:bg-raised',
        )}
      >
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-ink-faint transition-transform duration-150',
            isOpen && 'rotate-180',
          )}
        />
        <span className="min-w-0">
          <span className="block text-[0.8125rem] font-medium text-ink">{label}</span>
          {hint && <span className="block text-[0.6875rem] text-ink-faint">{hint}</span>}
        </span>
        <span className="eyebrow ml-auto shrink-0">{isOpen ? 'hide' : 'show'}</span>
      </CollapsibleTrigger>
      {/* Height is deliberately not animated. Hand-rolled collapsible-down/up
          keyframes collided with the identically named ones tw-animate-css
          ships, and the open panel stayed pinned at height:0: expanded, in
          the DOM, and invisible. Radix hides the closed state on its own, so
          the content keeps its natural height and only opacity is animated,
          which cannot collapse layout if it goes wrong. */}
      <CollapsibleContent>
        <div className="pt-3 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
