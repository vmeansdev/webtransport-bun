# Phase 4 framework measurement — `bulk-one-way/physical`

**Date:** 2026-08-29  
**Candidate:** `ws-wt-r0`  
**Campaign:** `campaign-r0-framework`  
**Cell:** `bulk-one-way` (100 MiB / 64 KiB chunks)  
**Path:** production adapters (`createWebSocketAdapter` / `createWebTransportAdapter`) via `tools/compare/client.ts` → `executeBulkOneWay`  
**Topology note:** this run uses the shared reliable-message send path both arms already expose (client opens, server echoes and the client drains). The registry's `server-opened-uni` role topology (ticket 02b) is not yet the server role used here; numbers are comparable across arms on the path that ran, not a claim that the physical role plan is closed.

## Rig

| Host | Interface | Address |
| --- | --- | --- |
| Mac controller | `en13` | `10.99.0.1` |
| Linux bench | `eno1` | `10.99.0.2` (`gravvene-dev-home`) |

TLS: self-signed end-entity cert (`basicConstraints=CA:FALSE`, `extendedKeyUsage=serverAuth`) with SAN `DNS:gravvene-dev-home,IP:10.99.0.2`. Client reads CA PEM from `/tmp/ws-wt-server.crt` and SNI `gravvene-dev-home`.

## Results (one rep each)

| transport | samples | p50 (Mbps) | p95 (Mbps) | mean (Mbps) | span (ms) | deliveredBytes |
| --- | ---:| ---:| ---:| ---:| ---:| ---:|
| WebSocket | 38 | **228.07** | 251.66 | 228.51 | 3703 | 104 857 600 |
| WebTransport | 88 | **104.86** | 110.10 | 95.92 | 8753 | 104 857 600 |

Artifacts: `ws-leg.json`, `wt-leg.json` (attested `MeasuredLeg`s with `sampleUnit: "Mbps"`).

## How to read

- Both arms completed the full 100 MiB schedule with attested Mbps samples from `openThroughputMeasurement`.
- Empty idle windows are skipped (so the median is not zeroed by echo-drain pauses).
- WS outran WT on this echo-drain path; that is a real observation for this topology, not a promotion claim. Server-opened-uni (02b) is the next honest topology for the physical cell.
- Harness cross-check (out of band): `gh workflow run ws-wt-real.yml -f candidate_commit=<sha>` against the same commit.

## Reproduce

```bash
# Linux (after SCP of worktree + native linux-x64 prebuild):
export WS_WT_TLS_CERT_CONTENT="$(cat ~/.ws-wt-tls/server.crt)"
export WS_WT_TLS_KEY_CONTENT="$(cat ~/.ws-wt-tls/server.key)"
export WS_WT_TLS_SERVER_NAME=gravvene-dev-home
bun run tools/compare/server.ts --transport ws --scenario bulk-one-way --port 4433 --bind 10.99.0.2 --run-id phase4

# Mac:
cp ~/.ws-wt-tls/server.crt /tmp/ws-wt-server.crt
bun run tools/compare/client.ts --transport ws --scenario bulk-one-way \
  --server-url wss://10.99.0.2:4433 --run-id phase4-bulk-ws \
  --output ws-leg.json --tls-ca /tmp/ws-wt-server.crt --tls-sni gravvene-dev-home
# then --transport wt --server-url https://10.99.0.2:4433 for the WT arm
```
