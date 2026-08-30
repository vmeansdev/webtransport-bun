# WebTransport vs WebSocket Comparison Report

> **Campaign ID**: `campaign-r0-phase4-1788050531` | **Generated**: 2026-08-30T01:21:06.044Z
> **Comparison status**: 2/2 cells comparable; 0 rejected or quarantined
> **Note**: Phase-4 gate subset (not a failed full 35-cell matrix). serverAggregate loop utilization unobserved / non-claim. Sealed p50 table below is the honest measured view when formal compare is blocked.

Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.

`serverAggregate` loop utilization is reported for transparency and is **unobserved** / non-claim for saturation ranking when busyMs is a placeholder.

## Summary Table

| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Loop Utilization | Notes |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `bulk-one-way/physical` | **COMPATIBLE** | application-throughput-mbps (Mbps) | 938.48 | 285.81 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `ticker-fanout/rate-10000` | **COMPATIBLE** | delivered-updates-per-second (count) | 1,100.75 | 58.72 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |

## Provenance

- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.
- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.
- Loop-utilization saturation caveat fires when per-session busyMs/windowMs exceeds 0.3 (30%); server-aggregate utilization is shown for transparency and never triggers the caveat.
- Generated output belongs under the ignored `.release-evidence/transport-comparison/` tree.

## Sealed primary metrics (honest measured view)

| Cell | Unit | WS p50 | WT p50 | WS samples | WT samples |
| :--- | :---: | ---: | ---: | ---: | ---: |
| `bulk-one-way/physical` | Mbps | 938.47552 | 285.80696 | 10 | 38 |
| `ticker-fanout/rate-10000` | count | 2223.5 | 1253 | 46 | 85 |

Source: median-promoted `*-ws.json` / `*-wt.json` under this campaign root; see `campaign-index.json` for per-rep PASS/FAIL.
