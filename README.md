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

The searcher's front-run is sized so your trade still lands — just barely inside the
tolerance you allowed. Your tolerance is therefore not a safety limit. It is the
attacker's budget.

## What this does

1. **Ingests swaps** from Helius (Solana, the primary source) and BigQuery
   (Ethereum), with execution ordering preserved, because a sandwich is defined
   entirely by ordering.
2. **Detects and labels** sandwiches by matching front-run/victim/back-run triples and
   reconstructing what the victim *would* have received.
3. **Predicts risk** with a calibrated gradient-boosted classifier, plus a severity
   model for loss magnitude.
4. **Solves for the sweet spot** — the slippage tolerance minimising expected cost —
   and for whether splitting the order into chunks beats executing it whole.

---

## The mathematics

Everything is built on the constant-product invariant `x·y = k`, with `γ = 1 − fee`.

### Front-run capacity — how much room your tolerance leaves

Your transaction carries a `minAmountOut` of `(1 − s)·out₀`. The largest front-run `a`
that still lets your trade land solves `out_victim(a) / out₀ = 1 − s`, which reduces to
a quadratic in `a`. With `u = 1 − s`:

```
u·γ·a² + u·(Rx·(1+γ) + γ²·v)·a − s·Rx·(Rx + γ·v) = 0
```

The positive root is the searcher's budget. This is the load-bearing equation — it is
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
concentrates in thin pools, volatile pairs, and low fee tiers — a $12k swap that is
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
arithmetic cannot know — whether a searcher is watching this pool right now — and the
closed form supplies everything that follows deterministically. The API inverts the
model's probability through the take-rate curve to recover latent presence, then holds
it fixed while sweeping slippage, so the risk score and the recommendation stay
consistent with each other.

### Order splitting

A searcher's profit falls faster than trade size, so `n` small victims can each be worth
less than the bundle costs to run. Splitting is not free: you pay gas per chunk and hold
market risk for the duration, both of which are charged in the objective.

---

## Running it

```bash
pip install -r backend/requirements.txt
python -m backend.ml.train                 # builds model artifacts (~2 min)
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

Schema lives in Supabase Postgres (six tables, three aggregate views):

| Table | Holds |
|---|---|
| `pools` | pool registry — TVL, fee tier, volatility; refreshable without a redeploy |
| `swaps` | normalised swap stream with execution ordering preserved |
| `sandwich_events` | detected attacks with the victim's counterfactual output |
| `ingestion_cursors` | per-source watermarks so pulls resume instead of rescanning |
| `analyses` | every risk query and what was recommended |
| `model_runs` | training metrics over time, so drift is visible |

`swaps` and `sandwich_events` are the point of the whole thing: each live pull
appends to them, which is how the corpus stops being simulated and starts being
measured.

**Security.** RLS is on for every table, and grants are separate from policies —
`anon` gets `SELECT` on the four public research tables and nothing else. There
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

### Live data (optional)

Without credentials the project runs on a built-in simulator and labels every figure
`simulated`. To use real chain data, create `.env` in the project root:

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
  detection/sandwich.py the labeller — front-run/victim/back-run matching
  ingestion/helius.py   Solana: slot scans and Enhanced Transactions
  ingestion/bigquery_eth.py  Ethereum: decode + label in SQL
  ingestion/synthetic.py     offline simulator for running without credentials
  ml/train.py           chronological split, isotonic calibration, model report
  ml/predictor.py       serving wrapper with per-prediction ablation attribution
frontend/
  src/components/       Analyzer, CostCurve, AttackAnatomy, Insights
  src/components/ui/    shadcn/ui primitives (Radix + CVA)
  src/lib/utils.ts      cn() class merger
tests/                  41 tests over the invariants, detector, optimiser and API
```

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript, Vite 8 |
| UI | Tailwind CSS v4 + **shadcn/ui** (Radix primitives, CVA variants) |
| Charts | **Recharts** — cost curve, attack path, corpus bars, calibration scatter, feature importance |
| Backend | FastAPI + Uvicorn, Pydantic v2 |
| ML | scikit-learn — `HistGradientBoosting` classifier (isotonic-calibrated) + regressor |
| Inference | In-process on the backend; models loaded once into a singleton |
| Database | **Supabase Postgres** — pools, swaps, detected sandwiches, telemetry, model runs |
| Storage | `joblib` model artifacts on disk; corpus in Postgres, Parquet as the offline fallback |
| Chain data | **Solana via Helius** (primary), Ethereum via BigQuery `crypto_ethereum` |

The models run server-side rather than in the browser because six of the twenty features
are computed by the AMM solver in `core/amm.py` — scoring in the client would mean
shipping both the math engine and a converted model just to reproduce one probability.

---

## Honest limitations

- **The shipped corpus is simulated.** Without credentials, training data comes from the
  built-in simulator. Reported metrics describe how well the model recovers a known
  generating process — they are *not* out-of-sample chain performance. The ingestion and
  detection code paths are real and run against live data when configured.
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
- **The write path is unverified end to end.** Reads, RLS enforcement and the
  degradation paths are tested against the live database, but inserts require a
  service_role key that was deliberately never handled here. `insert_swaps` and
  `insert_sandwich_events` are exercised only against their refusal behaviour.
- **Boundary solutions on Solana.** A failed Solana transaction costs a fraction of a
  cent, so once a trade is attackable at all the optimiser often wants the tightest
  tolerance in range. The API flags that case (`at_grid_floor`) and the UI says the
  number is a floor rather than a fine-tuned optimum.

Research and execution tooling, not financial advice.
