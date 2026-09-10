import { useEffect, useState } from 'react'
import { usd, pct } from '@/api'
import { Badge, Panel, Section, Skeleton, Stat } from './primitives'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Link } from '@/lib/router'
import {
  HEALTH_LABEL,
  SLOT_SECONDS,
  ageLabel,
  healthOf,
  live,
  liveConfigured,
  mintLabel,
  solscanToken,
  solscanTx,
  useNow,
} from '@/lib/live'
import type { Health, IngestRun, LivePool, LiveSandwich, LiveSummary } from '@/lib/live'
import { cn } from '@/lib/utils'

const REFRESH_MS = 15_000

const HEALTH_ACCENT: Record<Health, string> = {
  live: 'accent-low',
  stale: 'accent-elevated',
  down: 'accent-severe',
  none: '',
}

const HEALTH_DOT: Record<Health, string> = {
  live: 'bg-cool pulse-dot',
  stale: 'bg-warn',
  down: 'bg-hot',
  none: 'bg-line-bright',
}

const HEALTH_TEXT: Record<Health, string> = {
  live: 'text-cool',
  stale: 'text-warn',
  down: 'text-hot',
  none: 'text-ink-faint',
}

/**
 * How fresh the chain data is, and what it has found.
 *
 * Kept deliberately small: one status line, four numbers, a strip of recent
 * scans, and two tables. Everything polls every 15 seconds, and the ages tick
 * every second so "12s ago" is never a stale claim.
 */
export function LiveDashboard() {
  const now = useNow(1000)
  const [summary, setSummary] = useState<LiveSummary | null>(null)
  const [runs, setRuns] = useState<IngestRun[]>([])
  const [events, setEvents] = useState<LiveSandwich[]>([])
  const [pools, setPools] = useState<LivePool[]>([])
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!liveConfigured) return
    let alive = true
    const load = async () => {
      try {
        const [s, r, e, p] = await Promise.all([live.summary(), live.runs(40), live.sandwiches(15), live.pools(8)])
        if (!alive) return
        setSummary(s)
        setRuns(r)
        setEvents(e)
        setPools(p)
        setLoadedAt(Date.now())
        setError(null)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const latest = runs[0]
  const health = healthOf(summary?.last_success_at, now)

  return (
    <Section
      id="live"
      eyebrow="Live data"
      title="Solana mainnet, scanned every minute"
      lede="Every minute a scanner reads the newest blocks on Solana, finds each swap from the pool's side, and flags sandwiches. This page shows how fresh that data is and what it has found."
    >
      <Link
        to="/"
        className="mb-4 inline-block text-[0.75rem] text-ink-faint transition-colors hover:text-ink"
      >
        ← Back to the risk engine
      </Link>

      {!liveConfigured ? (
        <Panel className="border-l-2 border-l-warn p-4 text-[0.8125rem] text-ink-dim">
          Live data isn’t configured for this deployment.
        </Panel>
      ) : (
        <>
          {error && (
            <Panel className="mb-4 border-l-2 border-l-hot p-3 text-[0.75rem] text-hot">
              {error} Retrying every {REFRESH_MS / 1000} seconds.
            </Panel>
          )}

          {!loadedAt && !error ? (
            <div className="space-y-4">
              <Skeleton className="h-12 bg-line/60" />
              <Skeleton className="h-24 bg-line/60" />
              <Skeleton className="h-64 bg-line/60" />
            </div>
          ) : (
            <>
              <StatusLine health={health} summary={summary} latest={latest} now={now} loadedAt={loadedAt} />
              <Totals summary={summary} />
              <RunStrip runs={runs} now={now} />
              <div className="mt-4 grid gap-4 xl:grid-cols-[1.55fr_1fr]">
                <RecentSandwiches events={events} now={now} />
                <AttackedPools pools={pools} />
              </div>
              <Coverage provider={latest?.provider ?? summary?.provider ?? null} />
            </>
          )}
        </>
      )}
    </Section>
  )
}

function StatusLine({
  health,
  summary,
  latest,
  now,
  loadedAt,
}: {
  health: Health
  summary: LiveSummary | null
  latest: IngestRun | undefined
  now: number
  loadedAt: number | null
}) {
  const lag = latest?.lag_slots
  return (
    <Panel
      className={cn(
        'mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 px-3 py-2.5 text-[0.75rem]',
        HEALTH_ACCENT[health],
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('inline-block size-2', HEALTH_DOT[health])} />
        <span className={cn('eyebrow !text-[0.6875rem]', HEALTH_TEXT[health])}>{HEALTH_LABEL[health]}</span>
      </span>
      <span className="text-ink-dim">
        Last good scan <span className="num text-ink">{ageLabel(summary?.last_success_at, now)}</span>
      </span>
      {latest?.last_slot != null && (
        <span className="text-ink-dim">
          Newest slot <span className="num text-ink">{latest.last_slot.toLocaleString()}</span>
        </span>
      )}
      {lag != null && (
        <span className="text-ink-dim">
          <span className="num text-ink">{lag}</span> slots behind the chain tip{' '}
          <span className="num text-ink-faint">(~{(lag * SLOT_SECONDS).toFixed(1)}s)</span>
        </span>
      )}
      {latest?.sol_usd != null && (
        <span className="text-ink-dim">
          SOL <span className="num text-ink">{usd(latest.sol_usd)}</span>
          <span className="text-ink-faint"> from on-chain swaps</span>
        </span>
      )}
      <span className="num ml-auto text-[0.6875rem] text-ink-faint">
        refreshes every {REFRESH_MS / 1000}s · updated {ageLabel(loadedAt ? new Date(loadedAt).toISOString() : null, now)}
      </span>
    </Panel>
  )
}

function Totals({ summary }: { summary: LiveSummary | null }) {
  const rate = summary && summary.swaps_24h > 0 ? summary.sandwiches_24h / summary.swaps_24h : null
  return (
    <Panel className="mb-4 grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-4">
      <div className="bg-ground p-4">
        <Stat
          label="Scans · last hour"
          value={summary ? `${summary.runs_ok_1h}/${summary.runs_1h}` : '—'}
          sub="succeeded / started, one a minute"
        />
      </div>
      <div className="bg-ground p-4">
        <Stat
          label="Blocks read · 24h"
          value={summary ? summary.blocks_24h.toLocaleString() : '—'}
          sub="newest blocks, sampled each scan"
        />
      </div>
      <div className="bg-ground p-4">
        <Stat
          label="Pool swaps seen · 24h"
          value={summary ? summary.swaps_24h.toLocaleString() : '—'}
          sub="across every Solana DEX"
        />
      </div>
      <div className="bg-ground p-4">
        <Stat
          label="Sandwiches · 24h"
          value={summary ? summary.sandwiches_24h.toLocaleString() : '—'}
          sub={rate != null ? `${pct(rate, 3)} of swaps seen` : 'none measured yet'}
          tone={summary && summary.sandwiches_24h > 0 ? 'hot' : 'neutral'}
        />
      </div>
    </Panel>
  )
}

const RUN_COLOUR: Record<IngestRun['status'], string> = {
  ok: 'bg-cool/70',
  partial: 'bg-warn/70',
  error: 'bg-hot',
  running: 'bg-line-bright',
}

/** One bar per scan: height is swaps read, colour is how the scan went. */
function RunStrip({ runs, now }: { runs: IngestRun[]; now: number }) {
  const ordered = [...runs].reverse()
  const max = Math.max(1, ...ordered.map((r) => r.pool_swaps))

  return (
    <Panel className="p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="eyebrow">Last {ordered.length} scans</span>
        <span className="flex items-center gap-3 text-[0.625rem] text-ink-faint">
          <Legend className="bg-cool/70" label="complete" />
          <Legend className="bg-warn/70" label="some blocks missed" />
          <Legend className="bg-hot" label="failed" />
          <span className="flex items-center gap-1">
            <span className="inline-block size-1 bg-hot" /> sandwich found
          </span>
        </span>
      </div>

      {ordered.length === 0 ? (
        <p className="py-4 text-[0.75rem] text-ink-faint">Waiting for the first scan.</p>
      ) : (
        <>
          <div className="flex h-12 items-end gap-[2px]" role="img" aria-label="Recent scans">
            {ordered.map((r) => (
              <div
                key={r.id}
                className="relative flex h-full min-w-[3px] flex-1 items-end"
                title={`${new Date(r.started_at).toLocaleTimeString()} · ${r.status} · ${r.blocks_ok}/${r.blocks_requested} blocks · ${r.pool_swaps.toLocaleString()} swaps · ${r.sandwiches} sandwiches`}
              >
                {r.sandwiches > 0 && (
                  <span className="absolute -top-2 left-1/2 inline-block size-1 -translate-x-1/2 bg-hot" />
                )}
                <div
                  className={cn('w-full', RUN_COLOUR[r.status])}
                  style={{ height: `${Math.max(8, (r.pool_swaps / max) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="num mt-1 flex justify-between text-[0.625rem] text-ink-faint">
            <span>{ageLabel(ordered[0].started_at, now)}</span>
            <span>now</span>
          </div>
        </>
      )}
    </Panel>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('inline-block h-2 w-1.5', className)} /> {label}
    </span>
  )
}

function formatQuote(amount: number, symbol: string) {
  if (symbol === 'SOL') return `${amount.toFixed(amount < 1 ? 4 : 2)} SOL`
  return usd(amount)
}

function RecentSandwiches({ events, now }: { events: LiveSandwich[]; now: number }) {
  return (
    <Panel className="p-4">
      <div className="eyebrow mb-1">Detected</div>
      <h3 className="mb-3 text-[0.9375rem] font-semibold">Recent sandwiches</h3>
      <div className="-mx-4 overflow-x-auto px-4">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              {['Seen', 'Pair', 'Span', 'Victims', 'Attacker made', 'Victim loss ≥', 'On-chain'].map((h, i, a) => (
                <TableHead
                  key={h}
                  className={cn('eyebrow h-auto pb-2 font-normal', i === a.length - 1 && 'text-right')}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-6 text-center text-[0.75rem] text-ink-faint">
                  No sandwiches in the blocks scanned so far.
                </TableCell>
              </TableRow>
            ) : (
              events.map((e) => (
                <TableRow key={e.id} className="border-line/60 hover:bg-raised/40">
                  <TableCell className="num text-ink-faint">{ageLabel(e.block_time ?? e.detected_at, now)}</TableCell>
                  <TableCell>
                    <a
                      href={solscanToken(e.base_mint)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-ink hover:underline"
                    >
                      {mintLabel(e.base_mint)}
                    </a>
                    <span className="text-ink-faint">/{e.quote_symbol}</span>
                  </TableCell>
                  <TableCell>
                    <Badge tone={e.tier === 'high' ? 'hot' : 'warn'}>
                      {e.slot_span === 0 ? '1 block' : `${e.slot_span + 1} blocks`}
                    </Badge>
                  </TableCell>
                  <TableCell className="num text-ink-dim">{e.victim_count}</TableCell>
                  <TableCell className="num text-hot">
                    {formatQuote(e.attacker_profit_quote, e.quote_symbol)}
                    {e.attacker_profit_usd != null && e.quote_symbol === 'SOL' && (
                      <span className="text-ink-faint"> · {usd(e.attacker_profit_usd)}</span>
                    )}
                  </TableCell>
                  <TableCell className="num text-warn">
                    {e.victim_loss_bps_lb != null ? `${e.victim_loss_bps_lb.toFixed(1)}bp` : '—'}
                  </TableCell>
                  <TableCell className="num space-x-2 text-right text-[0.6875rem]">
                    <TxLink sig={e.frontrun_tx} label="front" />
                    <TxLink sig={e.victim_tx} label="victim" />
                    <TxLink sig={e.backrun_tx} label="back" />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
        “Attacker made” is measured from the pool’s balances, before the attacker’s fees and tips. The victims lost
        at least that much, so “victim loss ≥” is that profit as a share of what they spent.
      </p>
    </Panel>
  )
}

function TxLink({ sig, label }: { sig: string; label: string }) {
  return (
    <a
      href={solscanTx(sig)}
      target="_blank"
      rel="noreferrer"
      className="text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
    >
      {label}↗
    </a>
  )
}

function AttackedPools({ pools }: { pools: LivePool[] }) {
  return (
    <Panel className="p-4">
      <div className="eyebrow mb-1">Last 7 days</div>
      <h3 className="mb-3 text-[0.9375rem] font-semibold">Most attacked pools</h3>
      <div className="-mx-4 overflow-x-auto px-4">
        <Table className="min-w-[380px]">
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              {['Pair', 'Swaps', 'Hit', 'Rate'].map((h, i, a) => (
                <TableHead
                  key={h}
                  className={cn('eyebrow h-auto pb-2 font-normal', i === a.length - 1 && 'text-right')}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pools.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-6 text-center text-[0.75rem] text-ink-faint">
                  A pool appears here once it has 100 swaps and at least one sandwich.
                </TableCell>
              </TableRow>
            ) : (
              pools.map((p) => (
                <TableRow key={p.pool_key} className="border-line/60 hover:bg-raised/40">
                  <TableCell>
                    <span className="font-medium text-ink">{mintLabel(p.base_mint)}</span>
                    <span className="text-ink-faint">/{p.quote_symbol ?? mintLabel(p.quote_mint)}</span>
                  </TableCell>
                  <TableCell className="num text-ink-dim">{p.swaps.toLocaleString()}</TableCell>
                  <TableCell className="num text-ink-dim">{p.sandwiches}</TableCell>
                  <TableCell className="num text-right text-hot">{pct(p.attack_rate, 2)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Panel>
  )
}

function Coverage({ provider }: { provider: string | null }) {
  return (
    <Panel className="mt-4 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow">How much of the chain this sees</span>
        {provider && <Badge tone={provider === 'helius' ? 'cool' : 'neutral'}>{provider}</Badge>}
      </div>
      <div className="grid gap-x-8 gap-y-2 text-[0.75rem] leading-relaxed text-ink-dim md:grid-cols-2">
        <p>
          Each scan reads the two most recent complete leader windows — 8 slots, about 3 seconds of chain time — and
          runs once a minute. That is roughly 5% of all blocks, sampled evenly through the day, so the counts are real
          measurements of a sample rather than a census.
        </p>
        <p>
          A round trip only counts as a sandwich if it lands inside one validator’s window: only the leader can order
          transactions across its own slots, so a buy-then-sell spanning two validators is an ordinary fast trade.
          {provider !== 'helius' &&
            ' Scans currently use the public Solana RPC, which drops some requests; a Helius key makes every scan complete.'}
        </p>
      </div>
    </Panel>
  )
}
