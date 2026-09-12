import { useEffect, useState } from 'react'
import { bps, pct, usd } from '@/api'
import { AuthDialog } from './Auth'
import { Badge, Panel, Section, Skeleton } from './primitives'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { deleteSavedTrade, listSavedTrades, useAccount } from '@/lib/auth'
import type { SavedTrade } from '@/lib/auth'
import { Link, navigate } from '@/lib/router'
import { cn } from '@/lib/utils'
import { Rabbit } from './Rabbit'

/** Trades a signed-in trader kept, newest first. Only ever their own: the
 *  database filters by the session, not this page. */
export function SavedTradesPage() {
  const { account, loading } = useAccount()
  const [rows, setRows] = useState<SavedTrade[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)

  const accountId = account?.id
  useEffect(() => {
    if (!accountId) {
      setRows(null)
      return
    }
    let alive = true
    listSavedTrades()
      .then((data) => alive && setRows(data))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [accountId])

  const remove = async (id: string) => {
    setRows((current) => current?.filter((t) => t.id !== id) ?? null)
    try {
      await deleteSavedTrade(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const reopen = (t: SavedTrade) => {
    navigate(`/?pool=${encodeURIComponent(t.pool_id)}&size=${t.notional_usd}&slippage=${t.slippage_bps}#analyzer`)
  }

  return (
    <Section eyebrow="Account" title="Saved trades" lede="The trades you kept, with what the site recommended at the time. Chain conditions move, so reopen one to score it again.">
      <p className="mb-4 text-[0.75rem]">
        <Link to="/#analyzer" className="text-ink-dim underline decoration-line-bright underline-offset-2 hover:text-ink">
          ← Back to the risk engine
        </Link>
      </p>

      {loading ? (
        <Skeleton className="h-40 bg-line/60" />
      ) : !account ? (
        <Panel className="p-6 text-center">
          <Rabbit pose="hop" size={34} className="mx-auto mb-3" />
          <p className="mb-3 text-sm text-ink-dim">Sign in to see the trades you saved.</p>
          <Button onClick={() => setSignInOpen(true)} className="h-8 rounded-sm px-4 text-[0.75rem]">
            Sign in
          </Button>
          <AuthDialog open={signInOpen} onOpenChange={setSignInOpen} />
        </Panel>
      ) : error ? (
        <Panel className="p-6">
          <p className="text-sm text-hot">{error}</p>
        </Panel>
      ) : rows === null ? (
        <Skeleton className="h-40 bg-line/60" />
      ) : rows.length === 0 ? (
        <Panel className="p-6 text-center">
          <Rabbit pose="sleep" size={34} className="mx-auto mb-3" />
          <p className="text-sm text-ink-dim">
            Nothing saved yet. Analyse a trade and press <span className="text-ink">Save trade</span>.
          </p>
        </Panel>
      ) : (
        <Panel className="p-4">
          <div className="-mx-4 overflow-x-auto px-4">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow className="border-line hover:bg-transparent">
                  {['Saved', 'Pool', 'Size', 'Your slippage', 'Risk then', 'Recommended', 'Saving', ''].map((h, i, a) => (
                    <TableHead
                      key={h || 'actions'}
                      className={cn('eyebrow h-auto pb-2 font-normal', i === a.length - 1 && 'text-right')}
                    >
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TableRow key={t.id} className="border-line/60 hover:bg-raised/40">
                    <TableCell className="num text-ink-faint">
                      {new Date(t.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    </TableCell>
                    <TableCell className="num text-ink">{t.pool_symbol}</TableCell>
                    <TableCell className="num">{usd(t.notional_usd, 0)}</TableCell>
                    <TableCell className="num">{bps(t.slippage_bps)}</TableCell>
                    <TableCell>
                      {t.p_attack != null && (
                        <span className={cn('num', t.risk_band && `risk-${t.risk_band}`)}>{pct(t.p_attack, 1)}</span>
                      )}
                      {t.risk_band && (
                        <Badge tone={t.risk_band === 'minimal' || t.risk_band === 'low' ? 'neutral' : 'hot'}>
                          {t.risk_band}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="num text-cool">
                      {t.recommended_slippage_bps != null ? bps(t.recommended_slippage_bps) : '—'}
                    </TableCell>
                    <TableCell className="num text-cool">
                      {t.expected_saving_usd != null ? usd(t.expected_saving_usd) : '—'}
                    </TableCell>
                    <TableCell className="space-x-3 text-right text-[0.6875rem] whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => reopen(t)}
                        className="text-ink-dim underline decoration-line-bright underline-offset-2 hover:text-ink"
                      >
                        reopen
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(t.id)}
                        className="text-ink-faint transition-colors hover:text-hot"
                      >
                        delete
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
            Saved rows hold the inputs and what was recommended at the time, nothing about a wallet. Deleting one
            removes it for good.
          </p>
        </Panel>
      )}
    </Section>
  )
}
