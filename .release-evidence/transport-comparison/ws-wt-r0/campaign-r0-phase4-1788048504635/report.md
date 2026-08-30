# WebTransport vs WebSocket Comparison Report

> **Campaign ID**: `campaign-r0-phase4-1788048504635` | **Generated**: 2026-08-30T00:34:57.783Z
> **Comparison status**: 0/2 cells comparable; 2 rejected or quarantined
> **Note**: Phase-4 gate subset (not a failed full 35-cell matrix). serverAggregate loop utilization unobserved / non-claim. Formal pair deltas require matching runId + sample counts; sealed p50 table below is the honest measured view when compare is blocked.

Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.

`serverAggregate` loop utilization is reported for transparency and is **unobserved** / non-claim for saturation ranking when busyMs is a placeholder.

## Summary Table

| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Loop Utilization | Notes |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `bulk-one-way/physical` | *INCOMPATIBLE* | - | - | - | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | EVIDENCE_LEDGER_INVALID: ledger.serverObserved cannot exceed its preceding stage |
| `ticker-fanout/rate-10000` | *INCOMPATIBLE* | - | - | - | - | - | WS ps=0%/agg=0%; WT ps=3%/agg=0% | RUN_ID_MISMATCH: WS and WT run IDs differ; METRICS_SAMPLE_COUNT_INCOMPATIBLE: paired arms have different sample counts |

## Provenance

- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.
- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.
- Loop-utilization saturation caveat fires when per-session busyMs/windowMs exceeds 0.3 (30%); server-aggregate utilization is shown for transparency and never triggers the caveat.
- Generated output belongs under the ignored `.release-evidence/transport-comparison/` tree.

## Sealed primary metrics (honest measured view)

| Cell | Unit | WS p50 | WT p50 | WS samples | WT samples |
| :--- | :---: | ---: | ---: | ---: | ---: |
| `bulk-one-way/physical` | Mbps | 938.47552 | 8.19264 | 9 | 214 |
| `ticker-fanout/rate-10000` | count | 1771 | 1072 | 61 | 101 |

Source: median-promoted `*-ws.json` / `*-wt.json` under this campaign root; see `campaign-index.json` for per-rep PASS/FAIL.
