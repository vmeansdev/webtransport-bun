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

## Current Evidence Status

Real comparison measurements remain absent until a fresh campaign has run with
the Linux role on the required `10.99.0.2/eno1` host and the Mac role on the
required `10.99.0.1/en8` host. Historical, synthetic, and pure-test outputs
are not measured comparison evidence and cannot populate a numeric result.

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
- **Launch Linux Server Role**:
  ```bash
  bun run compare:server --transport <ws|wt> --scenario <id> --port 4433 --bind 10.99.0.2
  ```
- **Launch Mac Client Role**:
  ```bash
  bun run compare:client --transport <ws|wt> --scenario <id> --server-url https://10.99.0.2:4433
  ```
- **Execute Full Campaign**:
  ```bash
  bun run compare:run --scenarios all --transports both --candidate "$CANDIDATE" --campaign-id "$CAMPAIGN_ID" --output-dir "$OUTPUT_DIR"
  ```
- **Verify Run Artifacts**:
  ```bash
  bun run compare:verify "$OUTPUT_DIR"
  ```
- **Render Comparison Report**:
  ```bash
  bun run compare:report "$OUTPUT_DIR"
  ```

## Evidence & Verification Contract

- Every run produces a JSON artifact with schema version `v1` and a SHA-256 byte digest.
- An opaque external trust marker alone never promotes an artifact; evidence remains quarantined until the R1 external validation contract is implemented.
- An artifact `comparisonId` must match the campaign directory identity; mismatches are rejected before comparison.
- Artifact and report leaves reject symbolic links, and report publication uses a same-directory atomic write.
- If any parameter, capacity hash, route proof, or certificate fingerprint diverges between arms, the comparator marks the cell `INCOMPATIBLE` and suppresses ranking.
- Overload is an open-loop measured outcome; rate downshifting is strictly prohibited.
