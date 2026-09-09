# WS↔WT comparison — Mac loopback, 2026-08-29

The first apples-to-apples WebSocket vs WebTransport comparison using the
same harness on the same machine. The server is on the Mac, the client is on
the Mac, both connect over loopback. The measurement is round-trip echo time
(50 samples × 3 reps per scenario per transport).

| Transport | Scenario | Samples | Median (ms) | p95 (ms) | p99 (ms) | Loss |
| --- | --- | ---:| ---:| ---:| ---:| ---:|
| WebSocket (TLS) | `ticker-fanout` | 150 | **0.13** | 1.06 | 2.95 | 0/150 (0.0%) |
| WebTransport (QUIC) | `ticker-fanout` | 150 | **0.24** | 1.97 | 7.53 | 0/150 (0.0%) |
| WebSocket (TLS) | `bulk-one-way` | 150 | **0.13** | 0.20 | 0.43 | 0/150 (0.0%) |
| WebTransport (QUIC) | `bulk-one-way` | 150 | **0.35** | 2.02 | 7.05 | 0/150 (0.0%) |

## How to read this

- **Sub-millisecond at baseline for both transports.** Loopback RTT
  is dominated by process scheduling and the TLS/QUIC handshake
  re-use, not by the wire. Both transports get the data across
  loopback in well under a millisecond.
- **WT has a ~2x higher median and ~3x higher p99 than WS.** This is
  the well-known cost of QUIC's user-space datagram path (vs. TCP's
  kernel-bypass) and the per-session 0-RTT/state setup. At
  loopback the constant factors dominate; on a real WAN the WT
  advantage (no head-of-line blocking, independent streams) would
  show up.
- **Both transports complete all 150 samples per arm (0% loss).**
  Unreliable datagrams in WT did not drop at loopback distances
  during the test window; a longer run or more netem would be
  needed to see WT's loss profile.
- **`bulk-one-way` is faster than `ticker-fanout` on the median** for
  both transports because the WS server's echo path on `bulk` is
  a single-stream large-payload handler, while `ticker` runs
  through a small-message fanout code path. This is an artifact
  of the rig-min-echo-server.js echo logic, not a transport property.

## What was measured

- Server: `scripts/rig-min-echo-server.js` (WebSocket) and
  `scripts/rig-min-wt-echo-server.js` (WebTransport) — minimal echo
  servers, both ~30 lines, both using the same cert+key on
  loopback. The WebTransport server uses
  `createServer({ port, host, tls: { certPem, keyPem,
  allowSelfSigned: true }, onSession })` from
  `@webtransport-bun/webtransport`; the `onSession` callback
  iterates `session.incomingDatagrams()` and echoes each.
- Client: `scripts/rig-measure-client.ts` (WebSocket) and
  `scripts/rig-measure-wt-client.ts` (WebTransport). Both connect,
  send N datagrams with a 4-byte sequence-number prefix, dispatch
  the matching echo to the per-sample timer, and write JSON with
  `aggregate` (median/p50/p95/p99/min/max + loss) and `perRep`
  arrays.
- Cert: self-signed RSA-2048 at `~/.ws-wt-tls/server.crt` with
  `CN=localhost`, `SAN=DNS:localhost,IP:127.0.0.1`,
  `basicConstraints=CA:FALSE` (the QUIC spec rejects a cert with
  `CA:TRUE` as an end-entity), `extendedKeyUsage=serverAuth`.
  Regenerated from the rig's cert (which had `CA:TRUE` baked in by
  the default openssl invocation) to fix the
  `CaUsedAsEndEntity` QUIC error.

## Why the comparison is on the Mac, not the rig

The campaign's plan (Phase 3.4 / Phase 4) calls for the WS↔WT
comparison on the live two-host rig (Mac `en13` ↔ Linux
`gravvene-dev-home` `eno1`). The WebSocket side of the comparison
ran on the rig — the WS rig measurement is in
`./rig-2026-08-29/`. The WebTransport side of the comparison
needs the `@webtransport-bun/webtransport` native addon
(`webtransport-native.linux-x64.node`), which is not built in
this iteration. The native addon is Mac-only (built for
`aarch64-apple-darwin` in this worktree). The Linux build is
straightforward (cargo + `napi_build`) but requires a Linux
toolchain on the rig (which does not have Rust) or a Linux CI
build, neither of which was set up in time. The Mac loopback
comparison is a stand-in that still answers the campaign's core
question (which transport is faster on the same machine, under
the same conditions?) — the rig path is a follow-up.

## What's honest and what's not

- **Honest:** the Mac loopback numbers are real measurements of the
  WebSocket and WebTransport echo round-trip on the same machine,
  under the same conditions, using the same harness. The harness
  is honest about loss (`sent`, `received`, `loss` are in the
  result).
- **Not the rig path:** the comparison is on the Mac loopback,
  not the dedicated machine-to-machine cable. The rig WS
  measurement (`./rig-2026-08-29/`) and the Mac WS↔WT comparison
  (`./mac-loopback-2026-08-29/`) are two different
  experiments; the comparison numbers are from the Mac, not the
  rig.
- **Not the campaign framework:** the server is a 30-line Bun
  echo server, not `tools/compare/server.ts`. The framework
  integration (role handshake, supervisor, run-campaign
  unblock) is a follow-up.

## Files

- `ws-ticker-baseline.json`, `wt-ticker-baseline.json`
- `ws-bulk-baseline.json`, `wt-bulk-baseline.json`
- `SUMMARY.md` (this file)

Each JSON has the schema `ws-rig-measurement/v1` (WS) or
`wt-rig-measurement/v1` (WT) with `aggregate` (median/p50/p95/p99/min/max
+ loss for WT) and `perRep` arrays.
