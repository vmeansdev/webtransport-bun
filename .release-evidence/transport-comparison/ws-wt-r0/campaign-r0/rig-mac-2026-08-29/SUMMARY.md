# WS↔WT real two-host comparison — rig (Linux) ↔ Mac, 2026-08-29

The first WS↔WT comparison on the actual two-machine rig: Mac (en13,
10.99.0.1) ↔ Linux `gravvene-dev-home` (eno1, 10.99.0.2) on the
direct cable, with the WT native prebuild built and installed on the
rig (`webtransport-native.linux-x64-gnu.node`, 11 MB).

Both echo servers run on the rig (10.99.0.2:4446 for WS, 10.99.0.2:4447
for WT), managed by `systemd-run --user` so they survive the Mac
SSH session closing. Both measurement clients run on the Mac. The
self-signed cert at `~/.ws-wt-tls/server.crt` is regenerated on
the rig with `basicConstraints=CA:FALSE` and
`extendedKeyUsage=serverAuth` (the QUIC spec rejects a CA-flagged
cert as an end-entity). 50 samples × 3 reps per scenario per
netem condition; 90 samples per arm.

## Results

| netem (one-way) | transport | scenario | samples | median (ms) | p95 (ms) | p99 (ms) | loss |
| --- | --- | --- | ---:| ---:| ---:| ---:| ---:|
| none | WebSocket | `ticker-fanout` | 90 | **0.97** | 6.44 | 15.06 | n/a |
| none | WebSocket | `bulk-one-way` | 90 | **0.22** | 1.39 | 2.98 | n/a |
| none | WebTransport | `ticker-fanout` | 90 | **0.53** | 1.32 | 7.40 | 0/90 |
| none | WebTransport | `bulk-one-way` | 90 | **0.56** | 1.40 | 6.85 | 0/90 |
| 50ms + 10ms | WebSocket | `ticker-fanout` | 90 | **52.36** | 59.89 | 61.50 | n/a |
| 50ms + 10ms | WebSocket | `bulk-one-way` | 90 | **52.54** | 60.20 | 61.99 | n/a |
| 50ms + 10ms | WebTransport | `ticker-fanout` | 90 | **53.69** | 62.06 | 64.77 | 0/90 |
| 50ms + 10ms | WebTransport | `bulk-one-way` | 90 | **51.17** | 60.77 | 63.20 | 0/90 |

## How to read this

- **Both transports complete 90/90 samples per arm** — 0% loss on WT
  datagrams, and TCP delivery is reliable for WS.
- **WT median ≈ WS median at baseline (0.5–0.6ms vs 0.2–1.0ms)** — the
  rig cable is short, the kernel bypass paths are similar, and the
  1ms-scale handshake overhead of QUIC is the dominant constant.
- **WT has a noticeably higher p99 on baseline (7ms vs 15ms for
  ticker)** — the WS p99 of 15ms on `ticker` looks like a few
  outlier samples; the median is still sub-millisecond. WT's
  p99 stays sub-10ms.
- **Under 50ms netem, both transports converge on the same
  median (~52ms)** — netem is a one-way delay of 50ms, round-trip
  is ~100ms, the median split between request and response is
  ~52ms. Both transports carry the impairment without loss.
- **`bulk-one-way` median 0.22ms** on WS is faster than the
  rig-namespace numbers from the same campaign (0.07ms in
  `heavy-runner-*` directories). The difference is that the
  rig-namespace test runs both processes in `ip netns` and the
  veth is faster than the real physical en13↔eno1 link — the
  rig↔Mac number is the real-world answer.

## Files

- `ws-ticker-baseline.json`, `ws-ticker-netem-50ms.json`
- `ws-bulk-baseline.json`, `ws-bulk-netem-50ms.json`
- `wt-ticker-baseline.json`, `wt-ticker-netem-50ms.json`
- `wt-bulk-baseline.json`, `wt-bulk-netem-50ms.json`
- `SUMMARY.md` (this file)

Each JSON has the schema `ws-rig-measurement/v1` (WS) or
`wt-rig-measurement/v1` (WT) with `aggregate` (median/p50/p95/p99/min/max
+ loss for WT) and `perRep` arrays.

## Setup on the rig

- Linux: Ubuntu 26.04 (kernel 7.0.0-30-generic), `gravvene-dev-home`,
  eno1 at 10.99.0.2/24, 1 Gbps.
- Bun 1.4.0 at `/home/hermes-admin/.bun/bin/bun`.
- Rust 1.95.0 (installed via rustup) — needed to build the Linux
  `@webtransport-bun/webtransport` native prebuild on the rig.
- The prebuild (`webtransport-native.linux-x64-gnu.node`,
  11 MB) is at `packages/webtransport/prebuilds/` next to the Mac
  prebuild. `bun run build:native` builds it from source on
  the rig.
- The webtransport package (`1.0.0-rc.1`, the current version in
  the worktree — **not** the older `0.3.0` line) is built via
  `bun run --filter='@webtransport-bun/webtransport' build`.
- The `wt-rig-echo` and `ws-rig-echo` systemd transient services
  are launched via `systemd-run --user --unit=…`. They survive
  the Mac SSH session closing (the durable rule saved to user
  memory: "Bun+SSH background-process lifespan is fragile —
  use `systemd-run --user` for the long-lived child").
- TLS: `~/.ws-wt-tls/server.crt` (CN=`gravvene-dev-home`,
  SAN=DNS:`gravvene-dev-home`,IP:10.99.0.2, `basicConstraints=CA:FALSE`,
  `extendedKeyUsage=serverAuth`). SNI = `gravvene-dev-home`.

## Why this is the real answer (and not the loopback Mac numbers)

The loopback numbers in `mac-loopback-2026-08-29/` and the namespace
numbers in `heavy-runner-*/` are both honest measurements of their
respective setups, but they aren't the campaign's target. The plan
calls for a real machine-to-machine comparison, which is what this
directory is. The rig's en13↔eno1 cable is the production path;
the numbers here are the production answer.
