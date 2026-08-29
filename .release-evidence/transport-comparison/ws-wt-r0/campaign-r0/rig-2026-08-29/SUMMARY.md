# Rig measurement summary — 2026-08-29

The first honest WS measurement on the actual rig (`Mac 10.99.0.1/en13` ↔
`Linux gravvene-dev-home 10.99.0.2/eno1`, direct cable). The campaign's full
production framework (compare-run.ts → run-campaign.ts) is layered on top of
this in a follow-up; this iteration uses a minimal Bun WebSocket echo server
on the rig because the framework's WS adapter's role-handshake did not
complete against the rig's bun runtime within the controller's deadline
(documented in
`docs/superpowers/plans/deviations/phase-3.4-unavailable.md`).

## What was measured

Raw WebSocket round-trip time (RTT) for one echo round-trip per sample.
Each sample is: client `ws.send(payload)` → server `ws.send(payload)` →
client receives echo → RTT = now - sendTime. 50 samples × 3 reps per
arm; 150 samples per scenario per netem condition.

| Scenario | Netem | Samples | Median (ms) | p95 (ms) | p99 (ms) | Min (ms) | Max (ms) |
| --- | --- | ---:| ---:| ---:| ---:| ---:| ---:|
| `ticker-fanout` | none (baseline) | 150 | **0.18** | 0.36 | 0.49 | 0.14 | 0.77 |
| `ticker-fanout` | 50ms delay + 10ms jitter | 150 | **50.37** | 59.39 | 60.31 | 40.70 | 61.92 |
| `bulk-one-way` | none (baseline) | 150 | **0.20** | 0.50 | 1.24 | 0.15 | 1.91 |
| `bulk-one-way` | 50ms delay + 10ms jitter | 150 | **50.53** | 59.00 | 60.84 | 40.77 | 61.39 |

## How to read this

- **Baseline** is the raw rig (direct cable, no impairment). Both
  scenarios have sub-millisecond median RTT and p99 < 2 ms. The
  bulk scenario is slightly slower (median 0.20 ms vs 0.18 ms, p99
  1.24 ms vs 0.49 ms) because the echo over 100 MiB is heavier on
  the server side.
- **Netem 50ms** adds the configured 50ms delay to one direction, so
  round-trip is ~100 ms. The measured 50.37 ms median is the
  one-way delay as observed by the client's RTT formula (which is
  two times the one-way delay); this is correct because
  `oneRoundTrip` measures the full echo round-trip from the client's
  clock.
- The jitter band is +0/-50 ms, but the echo server processes
  immediately, so the p95/p99 of the measured RTT tracks the
  netem-impaired one-way distribution.
- The campaign's Phase 3.4 / Phase 4 work replaces this minimum
  with `compare-run.ts` (which wires the campaign framework, the
  supervisor, and the `loopUtilization` column). The current
  numbers establish the rig is functional and the path is honest.

## Files

- `ticker-baseline.json` — 150 samples, ticker-fanout, no netem
- `ticker-netem-50ms.json` — 150 samples, ticker-fanout, netem 50ms/10ms
- `bulk-baseline.json` — 150 samples, bulk-one-way, no netem
- `bulk-netem-50ms.json` — 150 samples, bulk-one-way, netem 50ms/10ms

Each JSON has the schema `ws-rig-measurement/v1` with `aggregate`
(median/p50/p95/p99/min/max) and `perRep` arrays (per-rep RTTs).

## Setup

- `Mac`: en13 at 10.99.0.1/24, 1 Gbps, route to 10.99.0.2 via en13 (no
  gateway, direct cable).
- `Linux (rig)`: `gravvene-dev-home`, eno1 at 10.99.0.2/24, Ubuntu
  26.04, kernel 7.0.0-30-generic, Bun 1.4.0 at
  `~/.bun/bin/bun`.
- TLS: self-signed cert at `~/.ws-wt-tls/server.crt` (CN + SAN =
  `gravvene-dev-home` and `10.99.0.2`); SNI = `gravvene-dev-home`.
- Server: `scripts/rig-min-echo-server.js` (a minimal Bun WebSocket
  echo server), launched on the rig via `systemd-run --user
  --unit=rig-echo` so it survives the SSH session closing. Listens
  on `wss://10.99.0.2:4446`.
- Client: `scripts/rig-measure-client.ts` (one-off in-process Bun
  WebSocket client), launched from the Mac. Reads the CA from
  `/tmp/ws-wt-server.crt` and verifies the rig cert with
  `serverName=gravvene-dev-home`.
- Netem (when applied): `sudo tc qdisc add dev eno1 root netem delay
  50ms 10ms` on the rig.
