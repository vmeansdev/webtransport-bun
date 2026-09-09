# WebTransport vs WebSocket Comparison Report

> **Campaign ID**: `campaign-r0-real` | **Generated**: 2026-08-29T14:48:38.545Z
> **Comparison status**: 0/35 cells comparable; 35 rejected or quarantined

Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.

## Summary Table

| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Notes |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- |
| `chat-fanout/subscribers-1000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `chat-fanout/subscribers-5000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `chat-fanout/subscribers-10000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ticker-fanout/rate-10000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ticker-fanout/rate-50000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ticker-fanout/rate-100000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-20-loss-1-delay-20` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-20-loss-1-delay-40` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-20-loss-2.5-delay-20` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-20-loss-2.5-delay-40` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-20-loss-5-delay-20` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-20-loss-5-delay-40` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-60-loss-1-delay-20` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-60-loss-1-delay-40` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-60-loss-2.5-delay-20` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-60-loss-2.5-delay-40` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-60-loss-5-delay-20` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `game-tick-loss/tick-60-loss-5-delay-40` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `reconnect-storm/cold-full` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `reconnect-storm/warm-after-prime` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `connection-memory/live-1000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `connection-memory/live-5000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `connection-memory/live-10000` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `crdt-sync/default` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ai-token-stream/chunk-32` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ai-token-stream/chunk-64` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ai-token-stream/chunk-128` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `ai-token-stream/chunk-256` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `handshake-matrix/physical-cold` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `handshake-matrix/physical-warm-after-prime` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `handshake-matrix/delay40-cold` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `handshake-matrix/delay40-warm-after-prime` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `bulk-one-way/physical` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `bulk-one-way/delay40-loss1` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |
| `tail-under-cross-traffic/default` | *INCOMPATIBLE* | - | - | - | - | - | Missing or quarantined WS or WT evidence artifact |

## Provenance

- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.
- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.
- Generated output belongs under the ignored `.release-evidence/transport-comparison/` tree.
