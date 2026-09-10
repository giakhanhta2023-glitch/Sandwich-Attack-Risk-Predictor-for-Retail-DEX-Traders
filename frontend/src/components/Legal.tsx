import type { ReactNode } from 'react'
import { Link } from '@/lib/router'
import { Panel } from './primitives'

/**
 * Terms of use and privacy policy.
 *
 * Every statement in the privacy policy describes what the code actually does:
 * the fields in the analyses table, the absence of cookies and trackers, the
 * third parties a browser really talks to, and the retention windows enforced
 * by the `retention-daily` cron job. Change one of those and this page has to
 * change with it.
 */

const EFFECTIVE = '10 September 2026'
const REPO = 'https://github.com/giakhanhta2023-glitch/Sandwich-Attack-Risk-Predictor-for-Retail-DEX-Traders'
const CONTACT = `${REPO}/issues`

function LegalPage({
  eyebrow,
  title,
  lede,
  other,
  children,
}: {
  eyebrow: string
  title: string
  lede: string
  other: ReactNode
  children: ReactNode
}) {
  return (
    <section className="relative z-10 mx-auto w-full max-w-[1600px] px-6 py-10">
      <div className="max-w-[68ch]">
        <Link to="/" className="text-[0.75rem] text-ink-faint transition-colors hover:text-ink">
          ← Back to the risk engine
        </Link>
        <div className="eyebrow mt-6 mb-2">{eyebrow}</div>
        <h1 className="text-[1.625rem] leading-tight font-semibold tracking-[-0.01em] text-balance">{title}</h1>
        <p className="num mt-2 text-[0.6875rem] text-ink-faint">Effective {EFFECTIVE}</p>
        <p className="mt-4 text-[0.875rem] leading-relaxed text-ink-dim">{lede}</p>
        <div className="mt-8 space-y-7">{children}</div>
        <p className="mt-10 border-t border-line pt-4 text-[0.75rem] text-ink-faint">
          Questions? <Contact />. See also {other}.
        </p>
      </div>
    </section>
  )
}

function Clause({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="mb-2 text-[0.9375rem] font-semibold text-ink">{title}</h2>
      <div className="space-y-2.5 text-[0.8125rem] leading-relaxed text-ink-dim">{children}</div>
    </div>
  )
}

function Contact() {
  return (
    <a href={CONTACT} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
      open an issue on GitHub
    </a>
  )
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
      {children}
    </a>
  )
}

function Plain({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 marker:text-ink-faint">{children}</ul>
}

export function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Privacy"
      title="Privacy policy"
      lede="Sandwich Radar is a free research tool. It has no accounts and does not track you. This page explains exactly what data it handles and why."
      other={
        <Link to="/terms" className="text-ink underline underline-offset-2">
          the terms of use
        </Link>
      }
    >
      <Panel className="border-l-2 border-l-cool p-4 text-[0.8125rem] leading-relaxed text-ink-dim">
        <strong className="text-ink">In short:</strong> no accounts, no cookies, no tracking, and no wallet
        connection. We never ask for private keys or seed phrases. When a trade analysis is stored, it holds only the
        trade details you typed and our answer — never your IP address, wallet, or anything that identifies you.
      </Panel>

      <Clause title="1. What happens when you analyse a trade">
        <p>
          The details you enter — the pool, trade size, slippage tolerance and routing choice — are sent to our server
          so it can calculate the risk and the recommended settings.
        </p>
        <p>
          When our database is connected, each analysis may be saved: those inputs, the hour of the day (UTC), and the
          results we returned, such as the risk score and recommended slippage. No IP address, wallet address, name,
          email or other identifier is saved with it, so a saved analysis cannot be traced back to you. We keep these to
          check whether our recommendations hold up against what later happens on-chain.
        </p>
      </Clause>

      <Clause title="2. What we don’t collect">
        <Plain>
          <li>No accounts, sign-ins or email addresses.</li>
          <li>No cookies, local storage or similar browser storage.</li>
          <li>No analytics, advertising or tracking scripts, and no fingerprinting.</li>
          <li>No wallet connection, and never private keys or seed phrases.</li>
        </Plain>
      </Clause>

      <Clause title="3. Public blockchain data">
        <p>
          The live data feature reads public Solana blockchain data. When it detects a sandwich attack, it stores the
          transaction signatures and public wallet addresses involved, together with amounts and times. This
          information is already public on the blockchain. We do not try to identify the people behind wallet
          addresses. If one of your addresses appears in our records and you would like it removed, <Contact />.
        </p>
      </Clause>

      <Clause title="4. Other companies involved">
        <p>These services help run the site. Each only receives what is described here.</p>
        <Plain>
          <li>
            <strong className="text-ink">Vercel</strong> hosts the website and its server. Like any web host, it
            processes technical request data such as your IP address and browser type in its logs, under{' '}
            <Ext href="https://vercel.com/legal/privacy-policy">Vercel’s privacy policy</Ext>.
          </li>
          <li>
            <strong className="text-ink">Supabase</strong> hosts our database in the United States. The live data page
            loads public figures directly from Supabase, so your browser contacts it when you open that page. See{' '}
            <Ext href="https://supabase.com/privacy">Supabase’s privacy policy</Ext>.
          </li>
          <li>
            <strong className="text-ink">Google Fonts</strong> serves the site’s typefaces. Your browser requests them
            from Google, which receives your IP address. See{' '}
            <Ext href="https://policies.google.com/privacy">Google’s privacy policy</Ext>.
          </li>
          <li>
            <strong className="text-ink">Helius</strong> and the public Solana network supply blockchain data to our
            servers. Your browser does not contact them, and they receive nothing about you.
          </li>
        </Plain>
      </Clause>

      <Clause title="5. How long we keep it">
        <Plain>
          <li>Saved trade analyses: 180 days.</li>
          <li>Records of each blockchain scan: 14 days.</li>
          <li>Sampled swap data used to train the model: 30 days.</li>
          <li>Daily per-pool activity counts: 90 days.</li>
          <li>Detected sandwich attacks: kept as a research record, since they are public blockchain data.</li>
        </Plain>
        <p>Older records are deleted automatically every day.</p>
      </Clause>

      <Clause title="6. Sharing">
        <p>
          We do not sell, rent or trade data. Statistics built from public blockchain data, such as attack rates per
          pool, are shown publicly on this site.
        </p>
      </Clause>

      <Clause title="7. Your choices">
        <p>
          Because we do not store anything that identifies you, we usually cannot find records that relate to you. If
          you believe we hold data about you — for example a wallet address — <Contact /> and we will look into it.
        </p>
      </Clause>

      <Clause title="8. Children">
        <p>This service is not directed at children.</p>
      </Clause>

      <Clause title="9. Changes">
        <p>
          If this policy changes, we will update this page and its effective date. The source code is public on{' '}
          <Ext href={REPO}>GitHub</Ext>, so any change to what the site collects is visible there too.
        </p>
      </Clause>
    </LegalPage>
  )
}

export function TermsPage() {
  return (
    <LegalPage
      eyebrow="Terms"
      title="Terms of use"
      lede="By using Sandwich Radar you agree to these terms. They are short, and written to be read."
      other={
        <Link to="/privacy" className="text-ink underline underline-offset-2">
          the privacy policy
        </Link>
      }
    >
      <Clause title="1. What this service is">
        <p>
          Sandwich Radar is a free research and educational tool. It estimates the risk that a swap on a decentralised
          exchange will be sandwich-attacked, and suggests slippage settings that may reduce the expected cost. No
          account is needed.
        </p>
      </Clause>

      <Clause title="2. Not financial advice">
        <p>
          Nothing on this site is investment, financial, legal or tax advice. Every figure is an estimate from a
          statistical model and can be wrong. Parts of the service use simulated data, and the site labels where. You
          alone decide whether and how to trade, and you are responsible for the results.
        </p>
      </Clause>

      <Clause title="3. We never touch your funds">
        <p>
          We do not execute trades, hold funds or connect to your wallet. Never share your private keys or seed phrase
          with anyone — we will never ask for them.
        </p>
      </Clause>

      <Clause title="4. Data accuracy and availability">
        <p>
          Blockchain data comes from third parties and from a rolling sample of recent blocks. It may be delayed,
          incomplete or inaccurate. We may change, pause or stop any part of the service at any time, without notice.
        </p>
      </Clause>

      <Clause title="5. Fair use">
        <p>Please don’t:</p>
        <Plain>
          <li>try to disrupt, overload or break the website, its API or its data pipeline;</li>
          <li>get around limits or security measures;</li>
          <li>use the service for anything unlawful.</li>
        </Plain>
        <p>Automated access at reasonable volumes is fine.</p>
      </Clause>

      <Clause title="6. No warranty">
        <p>
          The service is provided “as is” and “as available”, without warranties of any kind, to the fullest extent
          the law allows.
        </p>
      </Clause>

      <Clause title="7. Limitation of liability">
        <p>
          To the fullest extent the law allows, we are not liable for any loss or damage arising from your use of, or
          reliance on, the service — including trading losses, losses to MEV or sandwich attacks, and lost profits.
        </p>
      </Clause>

      <Clause title="8. Changes to these terms">
        <p>
          We may update these terms. The effective date above shows when they last changed, and continuing to use the
          service means you accept the current version.
        </p>
      </Clause>
    </LegalPage>
  )
}
