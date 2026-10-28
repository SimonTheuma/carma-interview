# Review: English-first stemmed/substring search (0004)

Date: 2026-10-24  
Status: phase implementation complete; human gates for plan EXPLAIN and B1/B2 thresholds remain.

## Summary
Two-phase change landed: migration 0007 (four expression indexes), compiler stem/substring/summary matching, list query `body_excerpt_en` + `matched_in` side set, English-first cards/article reveal, echo notes, telemetry beacons/metrics/alerts.

## Checks
| Gate | Result |
| --- | --- |
| Unit suite | Pass |
| Compile matrix / expression snapshot | Pass |
| Migration 0007 file + `-- no-transaction` | Present |
| FP-DB6 `is_current` flip in finish.ts | Fixed |
| Architect 0004 approval + C1/C3 wording | Pending user |

## Human follow-ups
1. Read EXPLAIN for stem OR substring / NOT / rare vs common on a ≥20k seed (HP-1).
2. Run B1 ingest ± indexes; accept or mitigate if >15% regression (Q5).
3. Run B2 search latency by `exact` / `stem_sub`.
4. Approve architect spec 0004 when ready.
