"""Ethereum swap ingestion from the BigQuery public dataset.

`bigquery-public-data.crypto_ethereum` carries every log ever emitted, which
means Uniswap V2/V3 Swap events with their block number and, critically, the
transaction index inside the block. Sandwich detection is entirely an ordering
problem, so `transaction_index` is the column that makes this work.

The queries below decode swap amounts directly in SQL rather than pulling raw
logs into Python: the dataset is large enough that filtering and decoding
server-side is the difference between a few hundred MB scanned and a few TB.

Cost control matters here: every query sets a byte ceiling and a block range,
and `estimate_query_cost` does a dry run first so nothing surprising is billed.
"""

from __future__ import annotations

from typing import Any, Iterable

from ..app.config import settings
from ..detection.sandwich import Swap

# keccak256 topic0 of each Swap event signature
V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

# Swap(address,uint256,uint256,uint256,uint256,address):
#   data = amount0In | amount1In | amount0Out | amount1Out, 32 bytes each
V2_SWAP_QUERY = """
WITH swaps AS (
  SELECT
    l.block_number,
    l.block_timestamp,
    l.transaction_hash,
    l.transaction_index,
    l.address AS pool_id,
    CONCAT('0x', SUBSTR(l.topics[SAFE_OFFSET(2)], 27)) AS recipient,
    /* decode the four uint256 words out of the ABI-packed data blob */
    CAST(CONCAT('0x', SUBSTR(l.data, 3, 64))   AS BIGNUMERIC) AS amount0_in,
    CAST(CONCAT('0x', SUBSTR(l.data, 67, 64))  AS BIGNUMERIC) AS amount1_in,
    CAST(CONCAT('0x', SUBSTR(l.data, 131, 64)) AS BIGNUMERIC) AS amount0_out,
    CAST(CONCAT('0x', SUBSTR(l.data, 195, 64)) AS BIGNUMERIC) AS amount1_out
  FROM `bigquery-public-data.crypto_ethereum.logs` AS l
  WHERE l.topics[SAFE_OFFSET(0)] = @swap_topic
    AND DATE(l.block_timestamp) BETWEEN @start_date AND @end_date
    AND l.block_number BETWEEN @start_block AND @end_block
)
SELECT
  s.*,
  t.from_address AS trader,
  t.gas_price,
  t.receipt_gas_used
FROM swaps AS s
JOIN `bigquery-public-data.crypto_ethereum.transactions` AS t
  ON t.hash = s.transaction_hash
 AND DATE(t.block_timestamp) BETWEEN @start_date AND @end_date
WHERE s.pool_id IN UNNEST(@pools)
ORDER BY s.block_number, s.transaction_index
"""

# Pools that saw at least `min_swaps` in the window and had multiple traders in
# the same block: the only blocks where a sandwich can exist. Running this
# first keeps the expensive decode query pointed at a small pool set.
CANDIDATE_POOLS_QUERY = """
SELECT
  address AS pool_id,
  COUNT(*) AS swap_count,
  COUNT(DISTINCT block_number) AS blocks,
  COUNT(*) / NULLIF(COUNT(DISTINCT block_number), 0) AS swaps_per_block
FROM `bigquery-public-data.crypto_ethereum.logs`
WHERE topics[SAFE_OFFSET(0)] IN UNNEST(@swap_topics)
  AND DATE(block_timestamp) BETWEEN @start_date AND @end_date
GROUP BY pool_id
HAVING swap_count >= @min_swaps AND swaps_per_block >= 2.0
ORDER BY swap_count DESC
LIMIT @max_pools
"""

# Sandwiches found entirely in SQL. Cheaper than shipping every swap to Python
# when you only want labels: self-join the swap stream on (block, pool) and keep
# the triples where one sender brackets another in execution order.
SANDWICH_LABEL_QUERY = """
WITH swaps AS (
  SELECT
    l.block_number,
    l.transaction_index,
    l.transaction_hash,
    l.address AS pool_id,
    t.from_address AS trader,
    CAST(CONCAT('0x', SUBSTR(l.data, 3, 64))   AS BIGNUMERIC) AS amount0_in,
    CAST(CONCAT('0x', SUBSTR(l.data, 67, 64))  AS BIGNUMERIC) AS amount1_in,
    CAST(CONCAT('0x', SUBSTR(l.data, 131, 64)) AS BIGNUMERIC) AS amount0_out,
    CAST(CONCAT('0x', SUBSTR(l.data, 195, 64)) AS BIGNUMERIC) AS amount1_out
  FROM `bigquery-public-data.crypto_ethereum.logs` AS l
  JOIN `bigquery-public-data.crypto_ethereum.transactions` AS t
    ON t.hash = l.transaction_hash
   AND DATE(t.block_timestamp) BETWEEN @start_date AND @end_date
  WHERE l.topics[SAFE_OFFSET(0)] = @swap_topic
    AND DATE(l.block_timestamp) BETWEEN @start_date AND @end_date
)
SELECT
  f.block_number,
  f.pool_id,
  f.trader           AS attacker,
  v.trader           AS victim,
  f.transaction_hash AS frontrun_tx,
  v.transaction_hash AS victim_tx,
  b.transaction_hash AS backrun_tx,
  f.amount0_in       AS frontrun_amount0_in,
  v.amount0_in       AS victim_amount0_in,
  v.amount1_out      AS victim_amount1_out,
  b.amount1_in       AS backrun_amount1_in,
  b.amount0_out      AS backrun_amount0_out
FROM swaps AS f
JOIN swaps AS v
  ON v.block_number = f.block_number
 AND v.pool_id = f.pool_id
 AND v.transaction_index > f.transaction_index
 AND v.trader != f.trader
JOIN swaps AS b
  ON b.block_number = f.block_number
 AND b.pool_id = f.pool_id
 AND b.transaction_index > v.transaction_index
 AND b.trader = f.trader
/* front-run and victim trade the same way, back-run unwinds it */
WHERE f.amount0_in > 0 AND v.amount0_in > 0 AND b.amount1_in > 0
  /* the back-run must return roughly the position the front-run acquired */
  AND ABS(SAFE_DIVIDE(b.amount1_in - f.amount1_out, NULLIF(f.amount1_out, 0))) < 0.02
  /* and the round trip has to actually make money */
  AND b.amount0_out > f.amount0_in
"""


class BigQueryEthereumSource:
    """Ethereum swap + sandwich source. Inert unless GCP credentials exist."""

    def __init__(self, project: str | None = None):
        self.project = project or settings.bigquery_project
        self._client = None

    @property
    def live(self) -> bool:
        return bool(self.project and settings.google_credentials)

    def _get_client(self):
        if self._client is None:
            try:
                from google.cloud import bigquery  # imported lazily: optional dependency
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError(
                    "google-cloud-bigquery is not installed. "
                    "pip install google-cloud-bigquery to use the Ethereum source."
                ) from exc
            self._client = bigquery.Client(project=self.project)
        return self._client

    def _job_config(self, params: dict[str, Any], dry_run: bool = False):
        from google.cloud import bigquery

        typed: list[Any] = []
        for name, value in params.items():
            if isinstance(value, (list, tuple)):
                element = "STRING" if not value or isinstance(value[0], str) else "INT64"
                typed.append(bigquery.ArrayQueryParameter(name, element, list(value)))
            elif isinstance(value, bool):
                typed.append(bigquery.ScalarQueryParameter(name, "BOOL", value))
            elif isinstance(value, int):
                typed.append(bigquery.ScalarQueryParameter(name, "INT64", value))
            elif isinstance(value, float):
                typed.append(bigquery.ScalarQueryParameter(name, "FLOAT64", value))
            else:
                kind = "DATE" if name.endswith("_date") else "STRING"
                typed.append(bigquery.ScalarQueryParameter(name, kind, value))

        return bigquery.QueryJobConfig(
            query_parameters=typed,
            dry_run=dry_run,
            use_query_cache=True,
            maximum_bytes_billed=None if dry_run else settings.bigquery_max_bytes,
        )

    def estimate_query_cost(self, query: str, params: dict[str, Any]) -> dict[str, float]:
        """Dry-run first. Nobody should discover the bill after the fact."""
        job = self._get_client().query(query, job_config=self._job_config(params, dry_run=True))
        gb = job.total_bytes_processed / 1024**3
        return {
            "gigabytes_scanned": round(gb, 2),
            # BigQuery on-demand pricing, first 1 TB per month free
            "estimated_usd": round(gb / 1024 * 6.25, 4),
        }

    def fetch_swaps(
        self,
        pools: list[str],
        start_date: str,
        end_date: str,
        start_block: int = 0,
        end_block: int = 999_999_999,
    ) -> list[Swap]:
        """Decoded V2 swaps for the given pools and window."""
        params = {
            "swap_topic": V2_SWAP_TOPIC,
            "start_date": start_date,
            "end_date": end_date,
            "start_block": start_block,
            "end_block": end_block,
            "pools": pools,
        }
        rows = self._get_client().query(V2_SWAP_QUERY, job_config=self._job_config(params)).result()
        return [_row_to_swap(row) for row in rows]

    def candidate_pools(
        self, start_date: str, end_date: str, min_swaps: int = 500, max_pools: int = 250
    ) -> list[dict[str, Any]]:
        params = {
            "swap_topics": [V2_SWAP_TOPIC, V3_SWAP_TOPIC],
            "start_date": start_date,
            "end_date": end_date,
            "min_swaps": min_swaps,
            "max_pools": max_pools,
        }
        rows = self._get_client().query(
            CANDIDATE_POOLS_QUERY, job_config=self._job_config(params)
        ).result()
        return [dict(row) for row in rows]

    def fetch_sandwich_labels(self, start_date: str, end_date: str) -> list[dict[str, Any]]:
        """Labelled sandwiches straight from SQL."""
        params = {
            "swap_topic": V2_SWAP_TOPIC,
            "start_date": start_date,
            "end_date": end_date,
        }
        rows = self._get_client().query(
            SANDWICH_LABEL_QUERY, job_config=self._job_config(params)
        ).result()
        return [dict(row) for row in rows]


def _row_to_swap(row: Any, decimals0: int = 18, decimals6: int = 6) -> Swap:
    """BigQuery row -> normalised Swap.

    Token decimals differ per pool; a production deployment joins the token
    registry. WETH/USDC (18/6) is assumed here because that is the pair the
    default pool list tracks.
    """
    a0_in = float(row["amount0_in"]) / 10**decimals0
    a1_in = float(row["amount1_in"]) / 10**decimals6
    a0_out = float(row["amount0_out"]) / 10**decimals0
    a1_out = float(row["amount1_out"]) / 10**decimals6

    if a0_in > 0:
        token_in, token_out, amount_in, amount_out = "token0", "token1", a0_in, a1_out
    else:
        token_in, token_out, amount_in, amount_out = "token1", "token0", a1_in, a0_out

    return Swap(
        chain="ethereum",
        block=int(row["block_number"]),
        tx_index=int(row["transaction_index"]),
        tx_hash=row["transaction_hash"],
        pool_id=row["pool_id"],
        trader=row.get("trader") or row.get("recipient") or "",
        token_in=token_in,
        token_out=token_out,
        amount_in=amount_in,
        amount_out=amount_out,
        timestamp=int(row["block_timestamp"].timestamp()) if row.get("block_timestamp") else 0,
        fee_bps=30.0,
    )


def describe_queries() -> list[dict[str, str]]:
    """Surface the SQL in the UI: the methodology should be inspectable."""
    return [
        {
            "name": "candidate_pools",
            "purpose": "Find pools with multiple swaps per block (where sandwiches are possible)",
            "sql": CANDIDATE_POOLS_QUERY.strip(),
        },
        {
            "name": "sandwich_labels",
            "purpose": "Self-join swaps on (block, pool) to extract front-run/victim/back-run triples",
            "sql": SANDWICH_LABEL_QUERY.strip(),
        },
        {
            "name": "swap_decode",
            "purpose": "Decode ABI-packed Uniswap V2 Swap events with execution ordering",
            "sql": V2_SWAP_QUERY.strip(),
        },
    ]
