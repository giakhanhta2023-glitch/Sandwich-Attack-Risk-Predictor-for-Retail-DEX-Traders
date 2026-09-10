import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Methodology, Pool } from '@/api'
import { Analyzer } from '@/components/Analyzer'
import { AttackAnatomy } from '@/components/AttackAnatomy'
import { CorpusDashboard, MethodologySection, ModelCard } from '@/components/Insights'
import { Badge, LiveDot, Panel } from '@/components/primitives'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'

const NAV = [
  { href: '#analyzer', label: 'Risk engine' },
  { href: '#corpus', label: 'Corpus' },
  { href: '#model', label: 'Model' },
  { href: '#methodology', label: 'Method' },
]

export default function App() {
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
      <div className="relative min-h-screen">
        <Header sources={sources} />
        <Hero />
        {offline ? <Offline /> : <Analyzer pools={pools} />}
        <CorpusDashboard />
        <ModelCard />
        <MethodologySection />
        <Footer />
      </div>
    </TooltipProvider>
  )
}

function Header({ sources }: { sources: Methodology['sources'] | null }) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-colors ${
        scrolled ? 'border-line bg-void/85 backdrop-blur-md' : 'border-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3.5">
        <a href="#top" className="flex items-center gap-2.5">
          <SandwichMark />
          <span className="text-[0.9375rem] font-semibold tracking-[-0.02em]">Sandwich Radar</span>
        </a>

        <nav className="ml-4 hidden gap-1 md:flex">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="rounded-md px-2.5 py-1.5 text-[0.8125rem] text-ink-dim transition-colors hover:bg-raised hover:text-ink"
            >
              {n.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 sm:flex">
          {sources &&
            Object.entries(sources).map(([chain, s]) => (
              <span
                key={chain}
                className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 font-mono text-[0.625rem] text-ink-faint"
                title={s.detail}
              >
                <LiveDot live={s.live} />
                {s.provider}
              </span>
            ))}
        </div>
      </div>
    </header>
  )
}

function SandwichMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="18" height="3.4" rx="1.2" fill="var(--color-hot)" />
      <rect x="2" y="9.3" width="18" height="3.4" rx="1.2" fill="var(--color-ink-faint)" />
      <rect x="2" y="14.6" width="18" height="3.4" rx="1.2" fill="var(--color-hot)" />
    </svg>
  )
}

function Hero() {
  return (
    <section id="top" className="relative z-10 mx-auto w-full max-w-[1400px] px-6 pt-16 pb-8 md:pt-24">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
        <div className="rise">
          <Badge tone="hot">MEV · Solana &amp; Ethereum</Badge>

          <h1 className="mt-5 text-[2.75rem] leading-[0.98] font-semibold tracking-[-0.04em] md:text-[4rem]">
            Your slippage setting
            <br />
            <span className="text-hot">is a bot's budget.</span>
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-dim">
            When you set a slippage tolerance, you publish the exact amount a searcher is allowed to take from
            you — and they will take almost all of it. This tool scores that risk from chain data, then solves for
            the tolerance that costs you the least.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-11 rounded-lg text-sm font-medium">
              <a href="#analyzer">Analyse a trade</a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-11 rounded-lg border-line-bright bg-transparent text-sm font-medium text-ink-dim hover:border-ink-faint hover:bg-raised hover:text-ink"
            >
              <a href="#methodology">How it works</a>
            </Button>
          </div>

          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
            {[
              ['Closed form', 'front-run capacity'],
              ['Calibrated', 'probability model'],
              ['Solana first', 'Helius ingestion'],
            ].map(([a, b]) => (
              <div key={a}>
                <dt className="text-sm font-medium text-ink">{a}</dt>
                <dd className="mt-0.5 text-xs text-ink-faint">{b}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rise" style={{ animationDelay: '120ms' }}>
          <AttackAnatomy />
        </div>
      </div>
    </section>
  )
}

function Offline() {
  return (
    <div className="relative z-10 mx-auto max-w-[1400px] px-6 py-20">
      <Panel className="border-hot/40 p-8">
        <div className="eyebrow mb-2 text-hot">Backend unreachable</div>
        <h2 className="mb-3 text-xl font-semibold">The risk API is not running</h2>
        <p className="mb-4 max-w-2xl text-sm text-ink-dim">
          Start it from the project root, then reload this page:
        </p>
        <pre className="num overflow-x-auto rounded-lg border border-line bg-void px-4 py-3 text-xs text-cool">
          uvicorn backend.app.main:app --reload --port 8000
        </pre>
      </Panel>
    </div>
  )
}

function Footer() {
  return (
    <footer className="relative z-10 border-t border-line">
      <div className="mx-auto max-w-[1400px] px-6 py-10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-md">
            <div className="mb-2 flex items-center gap-2.5">
              <SandwichMark />
              <span className="text-sm font-semibold">Sandwich Radar</span>
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">
              Research and execution tooling, not financial advice. Model output is an estimate of expected cost
              under stated assumptions and does not guarantee any execution outcome.
            </p>
          </div>
          <div className="flex gap-10 text-xs">
            <div>
              <div className="eyebrow mb-2.5">Sources</div>
              <ul className="space-y-1.5 text-ink-faint">
                <li>Helius — Solana</li>
                <li>BigQuery — Ethereum</li>
              </ul>
            </div>
            <div>
              <div className="eyebrow mb-2.5">Sections</div>
              <ul className="space-y-1.5">
                {NAV.map((n) => (
                  <li key={n.href}>
                    <a href={n.href} className="text-ink-faint transition-colors hover:text-ink">
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
