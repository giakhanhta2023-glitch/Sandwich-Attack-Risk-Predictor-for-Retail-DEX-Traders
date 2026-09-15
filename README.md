# Sandwich Radar

**Sandwich-attack risk prediction and slippage optimisation for retail DEX traders.**

When you set a slippage tolerance on a DEX swap, you publish the exact amount an MEV
searcher is permitted to take from you. This project scores that risk from chain data
and solves for the tolerance that minimises expected cost.

---

## The problem

A sandwich attack has three transactions in one block:

| # | Actor | Action |
|---|-------|--------|
| 1 | Searcher | Buys the token you are about to buy, pushing the price up (**front-run**) |
| 2 | You | Your swap fills at the worsened price |
| 3 | Searcher | Sells what it just bought into the price you created (**back-run**) |

The searcher's front-run is sized so your trade still lands, just barely inside the
tolerance you allowed. Your tolerance is therefore not a safety limit. It is the
attacker's budget.

## What this does

1. **Watches Solana mainnet every minute.** A scheduled Supabase Edge Function reads
   the newest blocks, finds every DEX swap from the pools' side, and records detected
   sandwiches plus a training sample. Anyone can watch it work at
   [`/live`](https://sandwich-attack-risk-predictor-for.vercel.app/live).
2. **Detects and labels** sandwiches by matching front-run/victim/back-run triples:
   one wallet on both legs, the back-run unwinding the front-run, a victim in between,
   all inside one validator's leader window, and a round trip that made money.
3. **Predicts risk** for Solana pools with a model trained on real mainnet swaps and
   retrained every six hours. Ethereum pools are hidden until a live Ethereum feed is
   connected, because without one they could only show a formula estimate.
4. **Solves for the sweet spot**, the slippage tolerance minimising expected cost,
   and for whether splitting the order into chunks beats executing it whole.

---

## The mathematics

Everything is built on the constant-product invariant `x·y = k`, with `γ = 1 − fee`.

### Front-run capacity: how much room your tolerance leaves

Your transaction carries a `minAmountOut` of `(1 − s)·out₀`. The largest front-run `a`
that still lets your trade land solves `out_victim(a) / out₀ = 1 − s`, which reduces to
a quadratic in `a`. With `u = 1 − s`:

```
u·γ·a² + u·(Rx·(1+γ) + γ²·v)·a − s·Rx·(Rx + γ·v) = 0
```

The positive root is the searcher's budget. This is the load-bearing equation. It is
literally what a searcher solves for, and it is why a wider tolerance is strictly worse.

### The break-even law

A sandwich is only worth running when what the searcher extracts exceeds the LP fee they
pay on their own round trip. To first order that means:

```
v / R  >  2 · fee
```

Your trade must move the price further than the attacker's round-trip fee costs them.
This has a sharp consequence: **in a deep pool at a 30bp fee tier, retail-sized trades
are mathematically un-sandwichable**, no matter how careless the slippage setting. Risk
concentrates in thin pools, volatile pairs, and low fee tiers: a $12k swap that is
unattackable in an 8.5M 30bp pool becomes profitable to attack in the same pool at 5bp.

### The objective

```
E[C(s)] = p_atk(s)·L(s)                        ← sandwich branch
        + (1 − p_atk(s))·(chase(s) + unfilled(s))  ← adverse-move branch
        + gas·E[attempts(s)]                   ← paid either way
        + baseline impact                      ← unavoidable
```

Two risks pull in opposite directions. Too wide and a searcher takes the tolerance you
granted; too tight and the trade reverts on ordinary volatility, burning gas and forcing
you to re-quote into a price that has moved. The recommendation is the argmin.

`p_atk` factorises as `presence × take_rate(profit(s))`. The ML model supplies the part
arithmetic cannot know (whether a searcher is watching this pool right now), and the
closed form supplies everything that follows deterministically. The API inverts the
model's probability through the take-rate curve to recover latent presence, then holds
it fixed while sweeping slippage, so the risk score and the recommendation stay
consistent with each other.

### Order splitting

A searcher's profit falls faster than trade size, so `n` small victims can each be worth
less than the bundle costs to run. Splitting is not free: you pay gas per chunk and hold
market risk for the duration, both of which are charged in the objective.

**Live:** https://sandwich-attack-risk-predictor-for.vercel.app

---

## Live mainnet data

```
pg_cron, every minute ──> solana-ingest Edge Function ──> Supabase Postgres
                                                           ├─ sandwich_events      every detection
                                                           ├─ pool_activity_daily  swaps and attacks per pool
                                                           ├─ swap_samples         the training sample
                                                           └─ ingest_runs          what each scan covered
pg_cron, every 5 min ─────> per-pool rate snapshot (cache.pool_risk, behind live_pool_risk)
GitHub Actions, every 6h ──> train_live.py ──> backend/artifacts/live_model.json ──> Vercel redeploy
```

**Scanning.** Each run reads the two most recent complete leader windows (8 slots). A
full block is ~6MB and Solana produces ~2.5 a second, so no free tier can read every
block: this is a rolling sample of the newest ones, roughly 5% of all blocks. Every run
records exactly what it covered and why any block was missed, and `/live` shows it.

**Labelling.** A sandwich is one attacker moving a pool vault one way and back by the
same amount (±3%), another trader going the same way in between, both legs inside one
validator's leader window (only a leader can order transactions across its own slots),
and a profitable round trip valued from the pool's side. The two legs belong to one
attacker when they share a fee payer or, for bots that rotate fee payers, when the
position was bought into and sold out of the same token account. Pump.fun bonding
curves hold their SOL as the curve account's lamports rather than in a token account,
so their quote side is read from that balance. A window with a missing block could hide
one leg of an attack, so its swaps are kept out of the training sample and the per-pool
rates, and so are the attacker's own legs.

**Sampling.** Every victim swap is kept; other swaps are kept at 2% with a weight of 50,
so weighted statistics describe the real population rather than the sample.

**Training.** `python -m backend.ml.train_live` fits a weighted logistic regression on
seven observable features (trade size, pool depth, size relative to depth, direction,
time of day, quote asset), scores it on a chronological holdout, and exports the
coefficients as JSON. Serving is plain arithmetic, so it runs on Vercel without
scikit-learn. A scheduled GitHub Action retrains every six hours and commits the new
artifact once there is enough data (300 rows and 30 victims). The model never
extrapolates past its data: time of day is held at the average until the sample covers
the whole day, and every input is clipped at four standard deviations from real flow. (The first version skipped this, and a time-of-day curve fitted to one
evening pushed afternoon risk a hundred times too low.)

**Setting the number.** Two questions decide whether a trade gets sandwiched, and they
are answered separately. *How often do bots reach trades like this?* is measured on
mainnet by the live model. *Is this trade worth attacking at your tolerance?* is exact
AMM arithmetic, and it is the one thing chain data cannot show, because a trader's
tolerance never appears in balance changes. The chance shown is their product: a
tolerance too tight to pay takes it to zero, and a wide one on a big trade keeps it at
the reach rate. A bot takes an attack only when it pays; the take rate is zero at or
below break-even and rises smoothly above it.

The risk label is the expected loss as a share of the trade, that chance times what a
bot takes when it attacks: under 0.5bp minimal, under 3bp low, under 10bp elevated,
under 30bp high, above that severe. Labelling by the chance alone called a 4% chance of
losing over a tenth of a $100k trade "low".

A young model is labelled early, and the API lists what it still lacks against an
established bar: 100 real victims spread over at least 20 pools, no pool supplying more
than a third of them, and a holdout AUC of 0.6. Because the model goes live unattended, a
retrain that cannot beat a coin flip on its holdout keeps the previous model.

**Real pools.** The analyser leads with the real pools where the scanner caught the
largest share of trades in sandwiches over the last seven days (at least 150 swaps and
10 victims each), described by what it measured rather than by the registry's
illustrative specs. For such a pool its own measured rate sets the level, shrunk toward
the model by a prior worth 100 swaps, and the model only shifts it for the trade's size,
in log-odds from the pool's average trade. A sandwich catches everyone trading the same
way between the bot's two legs, so a pool a bot works hard can see most of its trades
caught: at the time of writing the hottest had 113 of 217.

**Helius.** Without a key the function uses the public mainnet RPC, which rate-limits
and drops blocks. With one, every scan is complete. Set it as an Edge Function secret,
never in the repo:

```bash
supabase secrets set HELIUS_API_KEY=<your key> --project-ref zhmgaubrpkbooabztajo
```

or in the Supabase dashboard under Edge Functions → Secrets. No redeploy is needed; runs
switch to Helius within a few minutes, and `/live` shows the provider in use.

---

## Design rules

The interface is a trading surface, not a landing page, and the CSS layer
enforces that rather than leaving it to discipline:

- **Separation is a 1px border.** No shadow, gradient, blur or raised card.
  Hierarchy comes from the border plus the fill step between `#000000` and
  `#0c0c0e`.
- **Two functional hues.** Emerald `#10b981` for safe/optimal, crimson
  `#ef4444` for risk/loss, carried on the numeral or a 2px inset rule, never
  as a tint behind a figure, which only makes the figure harder to read.
  A chart's second series is neutral grey so red always and only means MEV.
- **Every figure is monospaced** and tabular, with slashed zero, so digits align
  down a column. That includes chart axis ticks, and Recharts' off-screen
  measurement span is pinned to the same font so label placement is measured in
  the font it renders in.
- **2px radius, everywhere.** No pills.
- **Motion on state change only.** Entrance animations delay data.

Progressive disclosure sits on top of this: the decision (risk, sweet spot,
recommendations) is always visible, while the searcher's ledger, model
attribution, split ladder, corpus, model card and methodology live behind three
disclosures. Default view is 1.8 screens; it was 8.1 before.

---

## Deployment

Vercel, git-connected: every push to `main` builds the Vite frontend as static
output and `api/index.py` as a Python function wrapping the FastAPI app.

The deployed function does **not** carry scikit-learn. The full stack is ~370MB
unpacked against a 250MB function limit, so the serving path was restructured to
need none of it: feature medians and corpus aggregates are precomputed at
training time into small JSON files. Sandwich probability in production comes
from the mainnet model, which is served as plain arithmetic, so every pool the
site offers is scored from real swaps. Everything else (the AMM math, the sweet-spot
optimiser, the split ladder, the corpus) is identical to a local run.

To run the trained model in production you need a host that fits a ~210MB
Python runtime (Fly, Render, Railway, a container on Cloud Run). Point the
frontend at it with `VITE_API_TARGET`; nothing else changes, because the
predictor loads the artifacts whenever scikit-learn is importable.

The Supabase URL and publishable key are public by design (RLS limits them to
`SELECT` on research tables), so they ship in `backend/public.env` and
`frontend/.env.production`, and every deployment reads live data with no
configuration. Real environment variables and `.env` override them. Secrets (the
service-role key, the Helius key) never go in the repo.

Two platform behaviours worth recording, both of which cost a debugging cycle:

- Vercel decides whether a file in `api/` is a function by inspecting it
  statically. Binding `app` inside a `try`/`except` makes detection fail and the
  **whole build** error with "the pattern doesn't match any Serverless
  Functions". `api/index.py` exports a top-level `async def app` and imports
  FastAPI lazily.
- `excludeFiles` in the `functions` config broke that same detection.

---

## Running it

```bash
pip install -r backend/requirements.txt
python -m backend.ml.train                 # builds model artifacts (~2 min)
python -m backend.ml.train_live            # trains on real mainnet samples, when there are enough
uvicorn backend.app.main:app --port 8000
```

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173
```

Tests:

```bash
python -m pytest tests -q
```

### Database

Schema lives in Supabase Postgres (eleven tables, five views):

| Table | Holds |
|---|---|
| `pools` | pool registry: TVL, fee tier, volatility; refreshable without a redeploy |
| `swaps` | normalised swap stream with execution ordering preserved |
| `sandwich_events` | every sandwich detected on mainnet, with Solscan-linkable signatures |
| `swap_samples` | the live training sample: every victim, 2% of everything else, weighted |
| `pool_activity_daily` | swaps and sandwiches per pool per day, from fully read windows |
| `ingest_runs` | one row per scan: slots covered, blocks read, lag, and why any were missed |
| `ingestion_cursors` | per-source watermarks so pulls resume instead of rescanning |
| `analyses` | every risk query and what was recommended |
| `model_runs` | training metrics over time, so drift is visible |
| `profiles` | one username per account; passwords live in Supabase Auth, hashed, never here |
| `saved_trades` | trades a signed-in trader kept, readable only by that account |

`sandwich_events`, `swap_samples` and `pool_activity_daily` are filled every minute by
the live pipeline, which is how the corpus stops being simulated and starts being
measured. Per-pool rates are rolled up into a snapshot every five minutes and read from
there: computing them per request meant aggregating seven days of every pool on the chain
(3.5s) on every page load, against the same instance the scanner writes to. The snapshot
carries the time it was taken as `measured_through`, and the API already cached these for
five minutes, so nothing shows a number it would not have shown before. Retention runs daily: analyses 180 days, runs 14, samples 30, pool counts 90;
detections are kept.

**Security.** RLS is on for every table, and grants are separate from policies:
`anon` gets `SELECT` on the public research tables and live views and nothing else. The two account
tables go further: signed-out visitors hold no privileges on them at all, and every policy on them is
keyed to `auth.uid()`, so a trader reads and deletes only their own rows. There
is no public write path anywhere; ingestion and telemetry go through the service
role. `analyses` (query telemetry) and `ingestion_cursors` (scheduler state) are
denied at both the grant and policy layer.

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   # RLS-constrained, safe to ship
SUPABASE_SERVICE_KEY=                         # secret; required for writes
```

Without `SUPABASE_SERVICE_KEY` the app runs read-only against the database.
Without any Supabase config at all it falls back to the static registry and the
Parquet corpus, so a fresh checkout still works with no credentials.

After adding a service key, seed the registry once:

```bash
curl -X POST http://localhost:8000/api/db/sync-pools
```

### Local credentials (optional)

The live pipeline runs inside Supabase and needs nothing locally. For the on-demand
`/api/live/solana` endpoint and Ethereum ingestion, create `.env` in the project root:

```
HELIUS_API_KEY=your-key            # Solana swaps + parsed transactions
BIGQUERY_PROJECT=your-gcp-project  # Ethereum via bigquery-public-data
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

BigQuery access also needs `pip install google-cloud-bigquery`. Every query does a dry
run first and reports estimated bytes scanned before it runs, and all queries carry a
`maximum_bytes_billed` ceiling.

---

## Layout

```
backend/
  core/amm.py           constant-product mechanics, closed-form sandwich economics
  core/optimizer.py     expected-cost objective, sweet spot, split ladder
  core/features.py      feature construction shared by training and serving
  core/pools.py         pool registry and per-chain execution environment
  detection/sandwich.py the labeller (front-run/victim/back-run matching)
  ingestion/helius.py   Solana: slot scans and Enhanced Transactions
  ingestion/bigquery_eth.py  Ethereum: decode + label in SQL
  ingestion/synthetic.py     offline simulator for running without credentials
  ml/train.py           chronological split, isotonic calibration, model report
  ml/predictor.py       serving wrapper with per-prediction ablation attribution
  ml/train_live.py      trains on the real mainnet sample; exports JSON coefficients
  ml/live_model.py      serves that model as plain arithmetic (no scikit-learn)
supabase/functions/solana-ingest/   the every-minute mainnet scanner (Edge Function)
.github/workflows/retrain-live-model.yml   six-hourly retrain and commit
frontend/
  src/components/       Analyzer, CostCurve, AttackAnatomy, Insights, LiveDashboard, Legal
  src/components/ui/    shadcn/ui primitives (Radix + CVA)
  src/lib/live.ts       read-only Supabase queries behind the /live dashboard
  src/lib/router.tsx    path routing for /live, /terms and /privacy
  src/lib/utils.ts      cn() class merger
tests/                  75 tests over the invariants, detector, optimiser, live model and API
```

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript, Vite 8 |
| UI | Tailwind CSS v4 + **shadcn/ui** (Radix primitives, CVA variants) |
| Design | Quantitative terminal: flat surfaces, 1px neutral-800 borders, 2px radius, Inter + JetBrains Mono, emerald/crimson only |
| Charts | **Recharts**: cost curve, attack path, corpus bars, calibration scatter, feature importance |
| Backend | FastAPI + Uvicorn, Pydantic v2 |
| ML | scikit-learn: `HistGradientBoosting` classifier (isotonic-calibrated) + regressor; weighted logistic regression on live mainnet samples |
| Inference | In-process on the backend; models loaded once into a singleton |
| Database | **Supabase Postgres**: pools, swaps, detected sandwiches, telemetry, model runs |
| Storage | `joblib` model artifacts on disk; corpus in Postgres, Parquet as the offline fallback |
| Chain data | **Solana mainnet every minute** via a Supabase Edge Function (Helius with a key, public RPC without); Ethereum via BigQuery `crypto_ethereum` |

The models run server-side rather than in the browser because six of the twenty features
are computed by the AMM solver in `core/amm.py`; scoring in the client would mean
shipping both the math engine and a converted model just to reproduce one probability.

---

## Honest limitations

- **The gradient-boosted model is trained on the simulator.** Its reported metrics
  describe how well it recovers a known generating process, not chain performance. Real
  mainnet data trains the separate live model, which replaces it for Solana once proven.
- **Live coverage is a sample, and the label is a lower bound.** Roughly 5% of blocks are
  read, an attack is only seen when both legs fall inside a scanned leader window, and a
  victim's loss is measured as the attacker's profit, a floor on what the victim lost.
- **Detector accuracy is measured on clean input.** Precision and recall of 1.00 against
  simulator ground truth validate the implementation, not robustness to aggregator hops,
  multi-hop routes, or partially-filled bundles.
- **Constant-product only.** Uniswap V3 concentrates liquidity, so near spot a V3 pool is
  deeper than its TVL implies here and thinner once price leaves the active range. Treat
  the registry's TVL for V3 pools as effective depth at spot.
- **Two calibrated constants.** `chase_factor` (how much of an adverse move a trader eats
  before giving up) and the take-rate logistic width are fitted judgement, not derived.
  Both are surfaced in the API response so the assumption stays visible.
- **PR AUC is capped by construction.** Whether a searcher is watching and wins the
  auction is a coin flip the features cannot observe, so no model reaches 1.0 on this
  label.
- **Single-hop, single-pool.** Multi-hop routes and aggregator splits are not scored.
- **The Python write path is unverified end to end.** The live pipeline writes through
  the service role Supabase injects into the Edge Function. The Python `insert_swaps` is
  exercised only against its refusal behaviour, because a service-role key was
  deliberately never handled here.
- **Boundary solutions on Solana.** A failed Solana transaction costs a fraction of a
  cent, so once a trade is attackable at all the optimiser often wants the tightest
  tolerance in range. The API flags that case (`at_grid_floor`) and the UI says the
  number is a floor rather than a fine-tuned optimum.

Research and execution tooling, not financial advice.
