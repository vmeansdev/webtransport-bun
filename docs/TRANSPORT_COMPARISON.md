# WebTransport vs WebSocket Scenario Comparison

This document describes the comparative benchmark methodology, topology, scenario registry, and fail-closed evidence contract between Bun-native WebSocket and native WebTransport (`@webtransport-bun/webtransport`).

## Architecture & Topology

All comparison measurements must run over the dedicated physical cable between the Mac controller and Linux server:

```text
Mac controller/client                 Linux server
darwin-arm64                          linux-x86_64
10.99.0.1 / en8        cable          10.99.0.2 / eno1
       scenario traffic  <=========>  Bun WS or native WT server
```

- **Loopback and Proxy Rejection**: `localhost`, `127.0.0.1`, Unix domain sockets, Tailscale measurement paths, reverse proxies, and load balancers are strictly rejected.
- **TLS Identity**: Strict custom CA with Subject Alternative Name (SAN) covering the physical Linux endpoint (`IP:10.99.0.2`, `DNS:wt-compare.local`).
- **Resource Limits**: Soft file-descriptor limits raised to an effective minimum of 65,536 per staged child process.
- **`SO_REUSEPORT` Carve-out**: Kernel-level `SO_REUSEPORT` socket sharding within a single host is not an intermediary and is not excluded by this document; it introduces no additional network hop, no TLS termination point and no address rewriting. Any campaign that uses it MUST record the achieved per-arm process and thread counts in the artifact. Off-host load balancers, reverse proxies and QUIC-LB CID steering remain excluded.

### Scope — a direct path, not a deployed system

This caveat is mandatory report language and must appear adjacent to every number, never in an appendix.

> **This campaign measures a single WebSocket process and a single WebTransport process on one direct 1 Gbps cable between two hosts, with no intermediary of any kind.** Loopback, Unix sockets, VPN paths, reverse proxies, and load balancers are excluded by contract and by validator. Consequently these numbers **do not** describe a deployed system.
>
> The exclusion is not neutral in what it hides. Production WebTransport at scale typically requires CID-aware steering (QUIC-LB), because QUIC connections are not 4-tuple-stable across migration or NAT rebinding; production WebSocket typically uses 4-tuple hashing, which is correct by construction for TCP but requires TLS termination and per-connection state at the balancer. **Excluding balancers therefore removes a per-packet cost from the WebTransport side and removes an architectural requirement from it at the same time, while removing a different set of costs from the WebSocket side.** These two mechanisms are not equivalent and cannot be fairly paired: on a static-client workload (every cell here) pairing them favours WebSocket, because CID decode is strictly more work than a 4-tuple hash; on a migrating-client workload it favours WebTransport enormously, because 4-tuple hashing mis-routes. **No cell in this report may be read as a deployment recommendation.**

## Canonical Capacity Profile (v1)

Both transports use identical submitted capacity and admission control settings:

| Parameter | Value |
| :--- | :--- |
| `maxSessions` | 12,000 |
| `maxHandshakesInFlight` | 512 |
| `maxStreamsPerSessionBidi` | 8 |
| `maxStreamsPerSessionUni` | 8 |
| `maxStreamsGlobal` | 24,000 |
| `maxDatagramSize` | 1,200 bytes |
| `maxQueuedBytesGlobal` | 512 MiB |
| `maxQueuedBytesPerSession` | 2 MiB |
| `maxQueuedBytesPerStream` | 256 KiB |
| `backpressureTimeoutMs` | 5,000 ms |
| `handshakeTimeoutMs` | 10,000 ms |
| `idleTimeoutMs` | 60,000 ms |
| `handshakesPerSec` / `burst` | 20,000 / 20,000 |
| `streamsPerSec` / `burst` | 20,000 / 20,000 |
| `datagramsPerSec` / `burst` | 20,000 / 20,000 |

## Scenario Registry (10 Scenarios, 35 Primary Cells)

1. **`chat-fanout`**: 10 publishers, 1,000 / 5,000 / 10,000 subscribers, 128-byte reliable messages.
2. **`ticker-fanout`**: 1 publisher, 100 subscribers, 100-byte records at 10k / 50k / 100k records/s (1:100 broadcast).
3. **`game-tick-loss`**: 1 publisher, 100 receivers, 64-byte latest-state ticks at 20 / 60 Hz under netem loss (1%, 2.5%, 5%) and delay (20ms, 40ms).
4. **`reconnect-storm`**: 100 clients x 10 reconnect cycles, 32-byte first message; cold vs warm-after-prime 0-RTT.
5. **`connection-memory`**: 1,000 / 5,000 / 10,000 concurrent idle connections held 30 s.
6. **`crdt-sync`**: 100 clients, 96-byte operations at 1,000 ops/s aggregate for 60 s, convergence hash verification.
7. **`ai-token-stream`**: 100 sessions, 32 / 64 / 128 / 256-byte chunks at 50 chunks/s/session with 500 ms pauses every 5 s.
8. **`handshake-matrix`**: 100 connections per cell; cold vs warm; direct baseline vs delay 40ms.
9. **`bulk-one-way`**: Exactly 100 MiB transfer in 64 KiB chunks over one connection / stream; baseline vs delay40-loss1%.
10. **`tail-under-cross-traffic`**: 1 Hz control ping-ack during concurrent 700 Mbps bulk transfer; tests head-of-line stream isolation.

### Impairment direction

The cell names record the impairment that was requested, not the direction it reached. This footnote is mandatory wherever an impaired cell is reported.

> netem is applied to Linux egress only. Client→server legs traverse an unimpaired path. Cells labelled `delay40-loss1` are impaired downstream only.

## Current Evidence Status

Real comparison measurements remain absent until a fresh campaign has run with
the Linux role on the required `10.99.0.2/eno1` host and the Mac role on the
required `10.99.0.1/en8` host. Historical, synthetic, and pure-test outputs
are not measured comparison evidence and cannot populate a numeric result.

R0 additionally keeps official artifact/report filesystem I/O quarantined. The
campaign, verifier, and report entrypoints fail closed with the typed
`OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` error until R1 supplies a validated,
staged external trust boundary. Pure byte/object parsing and verification stay
available for fixtures and tests; they do not publish or promote evidence.

## Tooling Commands

The official output directory is
`.release-evidence/transport-comparison/<candidate>/<campaign-id>/`. It is
ignored by Git and must be selected by explicit candidate and campaign
identities. The campaign CLI accepts `--candidate <candidate>` and
`--campaign-id <campaign-id>` for those path segments:

```bash
CANDIDATE="<candidate>"
CAMPAIGN_ID="<campaign-id>"
export WEBTRANSPORT_COMPARISON_CANDIDATE="$CANDIDATE"
export WEBTRANSPORT_COMPARISON_CAMPAIGN="$CAMPAIGN_ID"
OUTPUT_DIR=".release-evidence/transport-comparison/$CANDIDATE/$CAMPAIGN_ID"
```

- **Run Pure Policy/CLI Test Suite**:
  ```bash
  bun run test:compare
  ```
- **Run Pure Evidence Verification Tests**:
  ```bash
  bun test tools/compare/evidence.test.ts
  ```
- **Deferred Physical Roles (R1 only)**:
  ```bash
  bun run compare:server --transport <ws|wt> --scenario <id> --port 4433 --bind 10.99.0.2
  bun run compare:client --transport <ws|wt> --scenario <id> --server-url https://10.99.0.2:4433
  ```
- **Deferred Official Campaign (R1 only)**:
  ```bash
  bun run compare:run --scenarios all --transports both --candidate "$CANDIDATE" --campaign-id "$CAMPAIGN_ID" --output-dir "$OUTPUT_DIR"
  ```
- **Deferred Official Verification (R1 only)**:
  ```bash
  bun run compare:verify "$OUTPUT_DIR"
  ```
- **Deferred Official Report (R1 only)**:
  ```bash
  bun run compare:report "$OUTPUT_DIR"
  ```

## Evidence & Verification Contract

- Every run produces a JSON artifact with schema version `v1` and a SHA-256 byte digest.
- An opaque external trust marker alone never promotes an artifact; evidence remains quarantined until the R1 external validation contract is implemented.
- An artifact `comparisonId` must match the campaign directory identity; mismatches are rejected before comparison.
- Official artifact/report reads and publication fail closed with `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`; R0 intentionally makes no portable openat/renameat safety claim.
- R1 must provide the validated staged boundary before any official filesystem read or report publication is enabled.
- If any parameter, capacity hash, route proof, or certificate fingerprint diverges between arms, the comparator marks the cell `INCOMPATIBLE` and suppresses ranking.
- Overload is an open-loop measured outcome; rate downshifting is strictly prohibited.
