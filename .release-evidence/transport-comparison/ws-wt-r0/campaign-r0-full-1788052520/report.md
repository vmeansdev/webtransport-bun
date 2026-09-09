# WebTransport vs WebSocket Comparison Report

> **Campaign ID**: `campaign-r0-full-1788052520` | **Generated**: 2026-08-30T15:24:20.629Z
> **Comparison status**: 35/35 cells comparable; 0 rejected or quarantined
> **Note**: Full matrix campaign index entries=336. serverAggregate loop utilization unobserved / non-claim. Sealed p50 table below is the honest measured view when formal compare is blocked.

Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.

`serverAggregate` loop utilization is reported for transparency and is **unobserved** / non-claim for saturation ranking when busyMs is a placeholder.

## Summary Table

| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Loop Utilization | Notes |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `chat-fanout/subscribers-1000` | **COMPATIBLE** | delivered-messages-per-second (count) | 1,027.07 | 1,206.03 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `chat-fanout/subscribers-5000` | **COMPATIBLE** | delivered-messages-per-second (count) | 2,555.8 | 1,130.81 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `chat-fanout/subscribers-10000` | **COMPATIBLE** | delivered-messages-per-second (count) | 2,525.42 | 1,233.3 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `ticker-fanout/rate-10000` | **COMPATIBLE** | delivered-updates-per-second (count) | 115.12 | 1,366.4 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `ticker-fanout/rate-50000` | **COMPATIBLE** | delivered-updates-per-second (count) | 2,174.78 | 712.42 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `ticker-fanout/rate-100000` | **COMPATIBLE** | delivered-updates-per-second (count) | 2,232.05 | 828.91 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `game-tick-loss/tick-20-loss-1-delay-20` | **COMPATIBLE** | delivery-percent (percent) | 100 | 99 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-20-loss-1-delay-40` | **COMPATIBLE** | delivery-percent (percent) | 100 | 98.17 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-20-loss-2.5-delay-20` | **COMPATIBLE** | delivery-percent (percent) | 100 | 98.17 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-20-loss-2.5-delay-40` | **COMPATIBLE** | delivery-percent (percent) | 100 | 98.33 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-20-loss-5-delay-20` | **COMPATIBLE** | delivery-percent (percent) | 100 | 95.33 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-20-loss-5-delay-40` | **COMPATIBLE** | delivery-percent (percent) | 100 | 95.5 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-60-loss-1-delay-20` | **COMPATIBLE** | delivery-percent (percent) | 100 | 98.67 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-60-loss-1-delay-40` | **COMPATIBLE** | delivery-percent (percent) | 100 | 98.89 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-60-loss-2.5-delay-20` | **COMPATIBLE** | delivery-percent (percent) | 100 | 97.78 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-60-loss-2.5-delay-40` | **COMPATIBLE** | delivery-percent (percent) | 100 | 97.22 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-60-loss-5-delay-20` | **COMPATIBLE** | delivery-percent (percent) | 100 | 94.83 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `game-tick-loss/tick-60-loss-5-delay-40` | **COMPATIBLE** | delivery-percent (percent) | 100 | 95 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `reconnect-storm/cold-full` | **COMPATIBLE** | recovery-time-ms (ms) | 0.59 | 1.36 | - | - | WS ps=0%/agg=0%; WT ps=1%/agg=0% | - |
| `reconnect-storm/warm-after-prime` | **COMPATIBLE** | recovery-time-ms (ms) | 0.54 | 1.33 | - | - | WS ps=0%/agg=0%; WT ps=1%/agg=0% | - |
| `connection-memory/live-1000` | **COMPATIBLE** | rss-bytes-per-connection (bytes) | 266,452,992 | 267,026,432 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `connection-memory/live-5000` | **COMPATIBLE** | rss-bytes-per-connection (bytes) | 313,573,376 | 314,753,024 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `connection-memory/live-10000` | **COMPATIBLE** | rss-bytes-per-connection (bytes) | 315,555,840 | 316,030,976 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `crdt-sync/default` | **COMPATIBLE** | applied-unique-ops-per-second (count) | 2,702.56 | 1,223.71 | - | - | WS ps=0%/agg=0%; WT ps=3%/agg=0% | - |
| `ai-token-stream/chunk-32` | **COMPATIBLE** | inter-token-latency-ms (ms) | 1.23 | 1.98 | - | - | WS ps=0%/agg=0%; WT ps=3%/agg=0% | - |
| `ai-token-stream/chunk-64` | **COMPATIBLE** | inter-token-latency-ms (ms) | 1.66 | 1.66 | - | - | WS ps=0%/agg=0%; WT ps=3%/agg=0% | - |
| `ai-token-stream/chunk-128` | **COMPATIBLE** | inter-token-latency-ms (ms) | 1.31 | 1.74 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `ai-token-stream/chunk-256` | **COMPATIBLE** | inter-token-latency-ms (ms) | 1.39 | 2.09 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |
| `handshake-matrix/physical-cold` | **COMPATIBLE** | first-message-latency-ms (ms) | 2.49 | 16.13 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `handshake-matrix/physical-warm-after-prime` | **COMPATIBLE** | first-message-latency-ms (ms) | 2.76 | 15.1 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `handshake-matrix/delay40-cold` | **COMPATIBLE** | first-message-latency-ms (ms) | 44.16 | 48.16 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `handshake-matrix/delay40-warm-after-prime` | **COMPATIBLE** | first-message-latency-ms (ms) | 43.86 | 48.19 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `bulk-one-way/physical` | **COMPATIBLE** | application-throughput-mbps (Mbps) | 938.48 | 305.59 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `bulk-one-way/delay40-loss1` | **COMPATIBLE** | application-throughput-mbps (Mbps) | 5.24 | 7.16 | - | - | WS ps=0%/agg=0%; WT ps=0%/agg=0% | - |
| `tail-under-cross-traffic/default` | **COMPATIBLE** | control-latency-ms (ms) | 1.41 | 2.66 | - | - | WS ps=0%/agg=0%; WT ps=2%/agg=0% | - |

## Provenance

- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.
- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.
- Loop-utilization saturation caveat fires when per-session busyMs/windowMs exceeds 0.3 (30%); server-aggregate utilization is shown for transparency and never triggers the caveat.
- Generated output belongs under the ignored `.release-evidence/transport-comparison/` tree.

## Sealed primary metrics (honest measured view)

| Cell | Unit | WS p50 | WT p50 | WS samples | WT samples |
| :--- | :---: | ---: | ---: | ---: | ---: |
| `chat-fanout/subscribers-1000` | count | 1027.071800576892 | 1206.0265997175338 | 1 | 1 |
| `chat-fanout/subscribers-5000` | count | 2555.8042214031966 | 1130.8055240880535 | 1 | 1 |
| `chat-fanout/subscribers-10000` | count | 2525.4175632433366 | 1233.2990750256938 | 1 | 1 |
| `ticker-fanout/rate-10000` | count | 2473 | 1465 | 49 | 69 |
| `ticker-fanout/rate-50000` | count | 2598.5 | 1206 | 194 | 422 |
| `ticker-fanout/rate-100000` | count | 2586 | 1427 | 386 | 708 |
| `game-tick-loss/tick-20-loss-1-delay-20` | percent | 100 | 99 | 1 | 1 |
| `game-tick-loss/tick-20-loss-1-delay-40` | percent | 100 | 98.16666666666667 | 1 | 1 |
| `game-tick-loss/tick-20-loss-2.5-delay-20` | percent | 100 | 98.16666666666667 | 1 | 1 |
| `game-tick-loss/tick-20-loss-2.5-delay-40` | percent | 100 | 98.33333333333333 | 1 | 1 |
| `game-tick-loss/tick-20-loss-5-delay-20` | percent | 100 | 95.33333333333334 | 1 | 1 |
| `game-tick-loss/tick-20-loss-5-delay-40` | percent | 100 | 95.5 | 1 | 1 |
| `game-tick-loss/tick-60-loss-1-delay-20` | percent | 100 | 98.66666666666667 | 1 | 1 |
| `game-tick-loss/tick-60-loss-1-delay-40` | percent | 100 | 98.88888888888889 | 1 | 1 |
| `game-tick-loss/tick-60-loss-2.5-delay-20` | percent | 100 | 97.77777777777777 | 1 | 1 |
| `game-tick-loss/tick-60-loss-2.5-delay-40` | percent | 100 | 97.22222222222221 | 1 | 1 |
| `game-tick-loss/tick-60-loss-5-delay-20` | percent | 100 | 94.83333333333334 | 1 | 1 |
| `game-tick-loss/tick-60-loss-5-delay-40` | percent | 100 | 95 | 1 | 1 |
| `reconnect-storm/cold-full` | ms | 0.5894775390625 | 1.3607177734375 | 10 | 10 |
| `reconnect-storm/warm-after-prime` | ms | 0.53955078125 | 1.3255615234375 | 10 | 10 |
| `connection-memory/live-1000` | bytes | 266452992 | 267026432 | 1 | 1 |
| `connection-memory/live-5000` | bytes | 313573376 | 314753024 | 1 | 1 |
| `connection-memory/live-10000` | bytes | 315555840 | 316030976 | 1 | 1 |
| `crdt-sync/default` | count | 2702.563608555831 | 1223.7079066588115 | 1 | 1 |
| `ai-token-stream/chunk-32` | ms | 0.31640625 | 0.7135009765625 | 1500 | 1500 |
| `ai-token-stream/chunk-64` | ms | 0.322265625 | 0.708740234375 | 1500 | 1500 |
| `ai-token-stream/chunk-128` | ms | 0.3134765625 | 0.71435546875 | 1500 | 1500 |
| `ai-token-stream/chunk-256` | ms | 0.331787109375 | 0.69677734375 | 1500 | 1500 |
| `handshake-matrix/physical-cold` | ms | 2.4853515625 | 16.12548828125 | 1 | 1 |
| `handshake-matrix/physical-warm-after-prime` | ms | 2.759521484375 | 15.10107421875 | 1 | 1 |
| `handshake-matrix/delay40-cold` | ms | 44.16455078125 | 48.1591796875 | 1 | 1 |
| `handshake-matrix/delay40-warm-after-prime` | ms | 43.8564453125 | 48.185546875 | 1 | 1 |
| `bulk-one-way/physical` | Mbps | 938.47552 | 305.58568 | 10 | 28 |
| `bulk-one-way/delay40-loss1` | Mbps | 5.24288 | 7.1552 | 1485 | 1113 |
| `tail-under-cross-traffic/default` | ms | 0.3995361328125 | 0.87451171875 | 180 | 180 |

Source: median-promoted `*-ws.json` / `*-wt.json` under this campaign root; see `campaign-index.json` for per-rep PASS/FAIL.
