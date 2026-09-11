import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Methodology, Pool } from '@/api'
import { Analyzer } from '@/components/Analyzer'
import { AttackAnatomy } from '@/components/AttackAnatomy'
import { CorpusDashboard, MethodologySection, ModelCard } from '@/components/Insights'
import { LiveDashboard } from '@/components/LiveDashboard'
import { PrivacyPage, TermsPage } from '@/components/Legal'
import { Badge, Disclosure, LiveDot, Panel } from '@/components/primitives'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HEALTH_LABEL, ageLabel, healthOf, liveConfigured, useLiveSummary, useNow } from '@/lib/live'
import type { Health } from '@/lib/live'
import { Link, usePath } from '@/lib/router'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/#analyzer', label: 'Risk engine', path: '/' },
  { to: '/live', label: 'Live data', path: '/live' },
  { to: '/#research', label: 'Research', path: '/' },
]

export default function App() {
  const path = usePath()
  const [pools, setPools] = useState<Pool[]>([])
  const [sources, setSources] = useState<Methodology['sources'] | null>(null)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    api
      .pools()
      .then((r) => setPools(r.pools))
      .catch(() => setOffline(true))
    api
      .health()
      .then((h) => setSources(h.sources))
      .catch(() => setOffline(true))
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative flex min-h-screen flex-col">
        <Header sources={sources} path={path} />
        <main className="flex-1">
          {path === '/live' ? (
            <LiveDashboard />
          ) : path === '/terms' ? (
            <TermsPage />
          ) : path === '/privacy' ? (
            <PrivacyPage />
          ) : (
            <Home pools={pools} offline={offline} />
          )}
        </main>
        <Footer />
      </div>
    </TooltipProvider>
  )
}

function Home({ pools, offline }: { pools: Pool[]; offline: boolean }) {
  // The research sections are collapsed by default, so a link to #research has
  // to open them as well as scroll -- otherwise the anchor lands on a closed
  // panel and looks broken.
  const [researchOpen, setResearchOpen] = useState(false)

  useEffect(() => {
    const openIfTargeted = () => {
      if (window.location.hash === '#research') setResearchOpen(true)
    }
    openIfTargeted()
    window.addEventListener('hashchange', openIfTargeted)
    return () => window.removeEventListener('hashchange', openIfTargeted)
  }, [])

  return (
    <>
      <Hero />
      {offline ? <Offline /> : <Analyzer pools={pools} />}

      {/* Evidence, not decision: measured attack rates, the model card and the
          ingestion methodology. Kept one click away so the tool above stays the
          page rather than the preamble to a research report. */}
      <section id="research" className="relative z-10 mx-auto w-full max-w-[1600px] px-6 pb-6">
        <Disclosure
          label="Research &amp; methodology"
          hint="Measured attack rates, model performance and how the data is collected"
          open={researchOpen}
          onOpenChange={setResearchOpen}
        >
          <CorpusDashboard />
          <ModelCard />
          <MethodologySection />
        </Disclosure>
      </section>
    </>
  )
}

function Header({ sources, path }: { sources: Methodology['sources'] | null; path: string }) {
  const [scrolled, setScrolled] = useState(false)
  const summary = useLiveSummary(30_000)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={cn('sticky top-0 z-50 border-b bg-void', scrolled ? 'border-line' : 'border-line/50')}>
      <div className="mx-auto flex max-w-[1600px] items-center gap-5 px-6 py-2">
        <Link to="/" className="flex items-center gap-2.5">
          <SandwichMark />
          <span className="text-[0.8125rem] font-semibold tracking-[0.04em] uppercase">Sandwich Radar</span>
        </Link>

        <nav className="ml-4 hidden gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                'rounded-sm px-2 py-1 text-[0.75rem] transition-colors hover:bg-raised hover:text-ink',
                n.path === '/live' && path === '/live' ? 'text-ink' : 'text-ink-dim',
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <LiveIndicator summary={summary} />
          {sources &&
            Object.entries(sources).map(([chain, s]) => {
              // Solana data reaches the site through the live scanner, so its badge
              // reports the scanner's provider and health, not this server's settings.
              const shown =
                chain === 'solana' && summary
                  ? {
                      provider: summary.provider === 'helius' ? 'Helius' : 'Solana public RPC',
                      live: healthOf(summary.last_success_at, Date.now()) === 'live',
                      detail: `Live scanner via ${summary.provider ?? 'unknown provider'}`,
                    }
                  : s
              return (
                <span
                  key={chain}
                  className="hidden items-center gap-1.5 rounded-sm border border-line px-2 py-0.5 font-mono text-[0.625rem] text-ink-faint lg:flex"
                  title={shown.detail}
                >
                  <LiveDot live={shown.live} />
                  {shown.provider}
                </span>
              )
            })}
        </div>
      </div>
    </header>
  )
}

const INDICATOR_DOT: Record<Health, string> = {
  live: 'bg-cool pulse-dot',
  stale: 'bg-warn',
  down: 'bg-hot',
  none: 'bg-line-bright',
}

const INDICATOR_TEXT: Record<Health, string> = {
  live: 'text-cool',
  stale: 'text-warn',
  down: 'text-hot',
  none: 'text-ink-faint',
}

/**
 * The entry point to the live dashboard: a status light that also says how old
 * the newest chain data is. Clicking it opens the dashboard.
 */
function LiveIndicator({ summary }: { summary: ReturnType<typeof useLiveSummary> }) {
  const now = useNow(1000)
  if (!liveConfigured) return null
  const health = healthOf(summary?.last_success_at, now)

  return (
    <Link
      to="/live"
      title="Open the live Solana data dashboard"
      className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-0.5 font-mono text-[0.625rem] transition-colors hover:border-line-bright hover:bg-raised"
    >
      <span className={cn('inline-block size-1.5', INDICATOR_DOT[health])} />
      <span className={cn('uppercase tracking-[0.12em]', INDICATOR_TEXT[health])}>{HEALTH_LABEL[health]}</span>
      {summary?.last_success_at && (
        <span className="text-ink-faint">{ageLabel(summary.last_success_at, now)}</span>
      )}
    </Link>
  )
}

function SandwichMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="18" height="3.4" fill="var(--color-hot)" />
      <rect x="2" y="9.3" width="18" height="3.4" fill="var(--color-ink-faint)" />
      <rect x="2" y="14.6" width="18" height="3.4" fill="var(--color-hot)" />
    </svg>
  )
}

function Hero() {
  return (
    <section id="top" className="relative z-10 mx-auto w-full max-w-[1600px] px-6 pt-8 pb-6">
      <div className="grid items-center gap-8 lg:grid-cols-[1fr_1fr]">
        <div>
          <Badge tone="hot">MEV · Solana &amp; Ethereum</Badge>

          <h1 className="mt-3 text-[1.75rem] leading-[1.08] font-semibold tracking-[-0.025em] md:text-[2.25rem]">
            Your slippage setting
            <br />
            <span className="text-hot">is a bot's budget.</span>
          </h1>

          <p className="mt-3 max-w-xl text-[0.8125rem] leading-relaxed text-ink-dim">
            When you set a slippage tolerance, you publish the exact amount a searcher is allowed to take from
            you — and they will take almost all of it. This tool scores that risk from chain data, then solves for
            the tolerance that costs you the least.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button asChild size="sm" className="h-8 rounded-sm px-4 text-[0.75rem] font-medium">
              <a href="#analyzer">Analyse a trade</a>
            </Button>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-8 rounded-sm border-line bg-transparent px-4 text-[0.75rem] font-medium text-ink-dim hover:bg-raised hover:text-ink"
            >
              <Link to="/live">See live chain data</Link>
            </Button>
          </div>

          <dl className="mt-6 grid max-w-lg grid-cols-3 gap-4 border-t border-line pt-4">
            {[
              ['Exact AMM math', 'front-run capacity'],
              ['Real-data model', 'trained on mainnet swaps'],
              ['Live mainnet', 'scanned every minute'],
            ].map(([a, b]) => (
              <div key={a}>
                <dt className="text-[0.75rem] font-medium text-ink">{a}</dt>
                <dd className="mt-0.5 text-[0.6875rem] text-ink-faint">{b}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div>
          <AttackAnatomy />
        </div>
      </div>
    </section>
  )
}

function Offline() {
  return (
    <div className="relative z-10 mx-auto max-w-[1600px] px-6 py-10">
      <Panel className="border-l-2 border-l-hot p-5">
        <div className="eyebrow mb-2 text-hot">Backend unreachable</div>
        <h2 className="mb-3 text-xl font-semibold">The risk API is not running</h2>
        <p className="mb-4 max-w-2xl text-sm text-ink-dim">Start it from the project root, then reload this page:</p>
        <pre className="num overflow-x-auto rounded-sm border border-line bg-void px-3 py-2 text-[0.6875rem] text-cool">
          uvicorn backend.app.main:app --reload --port 8000
        </pre>
      </Panel>
    </div>
  )
}

function Footer() {
  return (
    <footer className="relative z-10 border-t border-line">
      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-md">
            <div className="mb-2 flex items-center gap-2.5">
              <SandwichMark />
              <span className="text-[0.8125rem] font-semibold tracking-[0.04em] uppercase">Sandwich Radar</span>
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">
              Research and execution tooling, not financial advice. Model output is an estimate of expected cost
              under stated assumptions and does not guarantee any execution outcome.
            </p>
          </div>
          <div className="flex gap-10 text-xs">
            <div>
              <div className="eyebrow mb-2.5">Sections</div>
              <ul className="space-y-1.5">
                {NAV.map((n) => (
                  <li key={n.to}>
                    <Link to={n.to} className="text-ink-faint transition-colors hover:text-ink">
                      {n.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="eyebrow mb-2.5">Legal</div>
              <ul className="space-y-1.5">
                <li>
                  <Link to="/terms" className="text-ink-faint transition-colors hover:text-ink">
                    Terms of use
                  </Link>
                </li>
                <li>
                  <Link to="/privacy" className="text-ink-faint transition-colors hover:text-ink">
                    Privacy policy
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <div className="eyebrow mb-2.5">Sources</div>
              <ul className="space-y-1.5 text-ink-faint">
                <li>Solana mainnet — Helius / public RPC</li>
                <li>Ethereum — AMM formula; BigQuery feed not connected</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
