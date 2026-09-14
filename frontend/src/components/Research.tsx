/**
 * Research: everything that justifies the number, on its own page.
 *
 * The risk engine answers one question about one trade and should read as a
 * tool. The evidence behind it (the measured corpus, the model card, how the
 * data is collected, and the working behind a particular trade) lives here, one
 * click away, where it can be read properly instead of unfolding underneath the
 * answer.
 *
 * The working needs a trade, so the link from the risk engine carries the pool,
 * size and tolerance in the URL and this page prices it again. That also makes
 * the working a real link: it can be bookmarked, or sent to someone who wants
 * to check the arithmetic.
 */
import { useEffect, useState } from 'react'
import { api, usd, bps } from '@/api'
import type { Analysis } from '@/api'
import { Panel, Section, Skeleton } from './primitives'
import { Link } from '@/lib/router'
import { AttackerLedger, Drivers, SplitLadder } from './Analyzer'
import { CorpusDashboard, MethodologySection, ModelCard } from './Insights'
import { Rabbit } from './Rabbit'

function tradeFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const poolId = params.get('pool') ?? ''
  const size = Number(params.get('size'))
  const slippage = Number(params.get('slippage'))
  const relay = params.get('relay') === '1'
  return poolId && size > 0 && slippage > 0 ? { poolId, size, slippage, relay } : null
}

export function ResearchPage() {
  const [trade] = useState(tradeFromUrl)
  const [result, setResult] = useState<Analysis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!trade) return
    let alive = true
    api
      .analyze({
        pool_id: trade.poolId,
        notional_usd: trade.size,
        slippage_bps: trade.slippage,
        private_relay: trade.relay,
      })
      .then((r) => {
        if (alive) {
          setResult(r)
          setError(null)
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [trade])

  return (
    <>
      <Section
        id="research"
        eyebrow="Research"
        title="The working behind the number"
        lede="What the bot earns on a trade, why the model scored it that way, measured attack rates across every pool the scanner reads, and how the data is collected."
      >
        <Link to="/" className="mb-5 inline-block text-[0.75rem] text-ink-faint transition-colors hover:text-ink">
          &larr; Back to the risk engine
        </Link>

        <div id="working" className="scroll-mt-20">
          {!trade ? (
            <Panel className="flex items-center gap-4 p-5">
              <Rabbit pose="question" size={56} />
              <div>
                <div className="text-[0.8125rem] font-medium text-ink">No trade to show the working for</div>
                <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-dim">
                  Price a trade on the{' '}
                  <Link to="/#analyzer" className="text-cool underline-offset-2 hover:underline">
                    risk engine
                  </Link>{' '}
                  and follow &ldquo;Show the working&rdquo;. The ledger, the model drivers and the split ladder
                  for that trade appear here.
                </p>
              </div>
            </Panel>
          ) : error ? (
            <Panel className="border-l-2 border-l-hot p-4 text-[0.75rem] text-hot">
              Could not price that trade: {error}
            </Panel>
          ) : !result ? (
            <div className="space-y-4">
              <Skeleton className="h-40 bg-line/60" />
              <Skeleton className="h-64 bg-line/60" />
            </div>
          ) : (
            <>
              <Panel className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <div className="eyebrow mb-1">Working for</div>
                  <div className="num text-[0.8125rem] text-ink">
                    {result.input.pool.symbol} &middot; {usd(result.input.notional_usd)} &middot;{' '}
                    {bps(result.input.slippage_bps)} tolerance
                    {result.input.private_relay && ' \u00b7 private routing'}
                  </div>
                </div>
                <Link
                  to={`/?pool=${encodeURIComponent(trade.poolId)}&size=${trade.size}&slippage=${trade.slippage}&relay=${trade.relay ? 1 : 0}#analyzer`}
                  className="text-[0.75rem] text-cool transition-colors hover:text-ink"
                >
                  Open in the risk engine &rarr;
                </Link>
              </Panel>

              <div className="grid gap-4 md:grid-cols-2">
                <AttackerLedger result={result} />
                <Drivers result={result} />
              </div>
              <SplitLadder result={result} />
            </>
          )}
        </div>
      </Section>

      <CorpusDashboard />
      <ModelCard />
      <MethodologySection />
    </>
  )
}
