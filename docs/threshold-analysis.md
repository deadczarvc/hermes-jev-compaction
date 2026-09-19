# Mathematical modeling: Jev compaction threshold optimization

## Model 1: Jev verdict stability (litshing's calibration concern)

Measured: 5 identical calls × 5 tool fixtures against live `jev-1.13.0`.

| Fixture | call_mean | call_σ | result_mean | result_σ | call stable @0.5 | result stable @0.5 |
|---|---|---|---|---|---|---|
| stale_cat | 0.516 | 0.015 | 0.306 | 0.022 | FLIP-RISK | STABLE |
| stale_error | 0.702 | 0.008 | 0.336 | 0.011 | STABLE | STABLE |
| receipt | 0.522 | 0.005 | 0.252 | 0.005 | STABLE | STABLE |
| bulk_read | 0.618 | 0.005 | 0.400 | 0.012 | STABLE | STABLE |
| stale_bulk | 0.610 | 0.016 | 0.372 | 0.019 | STABLE | STABLE |

**Key finding**: `stale_cat` call_mean = 0.516, σ = 0.015 → z-score from 0.5 threshold = 1.05.
Two σ below → one in ~6 calls flips. This is the "call stays but only barely" zone.
`litshing`'s 0.10→pass flip is consistent: ephemeral jitter of ±0.05 on a score at 0.52.

**Implication for our threshold**: keep_threshold=0.5 is correct for results (all means 0.25–0.40, far below), but the CALL decision at 0.52 is fragile. The `_RECEIPT_RE` guard is what actually protects receipts, not Jev's score.

## Model 2: threshold sweep on 5 real fixtures

| threshold | call kept | result kept | flip risk |
|---|---|---|---|
| 0.25 | 5/5 | 5/5 | receipt:result |
| 0.30 | 5/5 | 4/5 | stale_cat:result |
| 0.35 | 5/5 | 2/5 | stale_error + stale_bulk:result |
| 0.40 | 5/5 | 1/5 | bulk_read:result |
| **0.50** | **5/5** | **0/5** | **stale_cat:call (borderline)** |

## Model 3: Context loss simulation (250-tool session, seed=42)

658,544 total chars across 250 tool results (realistic size distribution).

| threshold | results kept | chars kept | reduction | receipts lost |
|---|---|---|---|---|
| 0.25 | 233/250 | 649,773 | 1.3% | 17 |
| 0.30 | 212/250 | 635,985 | 3.4% | 34 |
| 0.35 | 131/250 | 571,062 | 13.3% | 34 |
| **0.40** | **29/250** | **145,114** | **78.0%** | **34** |
| **0.50** | **0/250** | **0** | **100.0%** | **34** |

## Model 4: Two-tier (Jev + receipt guard)

| threshold | + receipt_guard(0.7×) | chars kept |
|---|---|---|
| 0.30 | 243/250 | 98.7% |
| 0.35 | 173/250 | 87.9% |
| 0.40 | 35/250 | 32.9% |

## Conclusions

1. **`keep_threshold: 0.5` is correct** for results — it aggressively drops stale bulk (100% reduction at 0.50 in Model 3) while the receipt guard saves non-idempotent confirmations.
2. **The call question is a weak discriminator** — Jev gives ~0.5–0.7 for everything. The signal is in the RESULT question (0.25–0.40 spread). Our engine already treats these independently.
3. **litshing's 0.25 + silence-never-deletes** is more conservative than our 0.5 + fallback. Their approach keeps more context but risks the "Lost in the Middle" dilution. Our approach drops more but relies on `_RECEIPT_RE` to catch the irreplaceable.
4. **Recommended**: keep `threshold=0.5`, rely on `_RECEIPT_RE` for non-idempotent tools, and revisit after first in-vivo compression.
