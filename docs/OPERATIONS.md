# OPERATIONS.md

## Running an in-process server (example)
Example usage (JS/TS):

- create server with TLS cert/key
- handle session: datagrams and streams

Operational requirements:
- UDP port must be reachable from the internet (firewall rules).
- Certificates must be valid for the hostname used by clients/browsers.

Canonical release truth: `docs/release-status.json`. This page describes operational guidance for the current candidate surfaces.

## Recommended defaults
- Keep maxSessions conservative initially (e.g., 200–500) until tested.
- Keep per-session queued bytes low (<= 2 MiB).
- Prefer backpressure over drops; enable drop policy only for datagrams if you accept loss.

## WASM footguns (multi-session / 0-RTT / QPACK)

- **Primary CONNECT close tears down the whole QUIC connection** (and every
  extra WT session on it). Close only non-primary sessions when you want
  siblings to survive (`SessionClosed`).
- **Inbound host-queue pressure** can also close the entire QUIC connection
  (budget is keyed by `conn`, not per WT `sessionId`).
- **`enable0Rtt`**: default false. Ticket stores are **per-endpoint** unless
  you set `shareProcess0RttTicketStore: true` (loopback / same-process resume
  only). Optional `ticketStore` (JS `TicketStoreHost`) hydrates opaque client
  tickets into the Rust store before connect. Manager `close()` auto-dumps when
  a store is configured; `dumpTicketsToHost(authority)` remains available for
  explicit dump after NST. Hosts: `MemoryTicketStoreHost`, `FileTicketStoreHost`
  (Bun/Node), `IndexedDBTicketStoreHost` (IWA/browser).
- **`enableDynamicQpack`**: default off (SETTINGS capacity 0). Opt-in emits
  decoder-stream ICI/section-acks, applies peer ICI to encoder KRC, and may
  index outbound CONNECT/status; expect extra encoder/decoder-stream traffic.
- **CONNECT admission (wasm)**: concurrent unlatched + active WT sessions are
  capped by `wtMaxSessions` / peer `SETTINGS_WT_MAX_SESSIONS`; over-cap
  CONNECTs get early RESET (no MiB HEADERS buffering). Handshake /
  stream-open **rate-limit buckets are not charged** at CONNECT classify —
  those buckets still gate UDP handshakes and WT stream opens only. Size
  `wtMaxSessions` for CONNECT storm resistance; do not assume handshake
  rate limits alone throttle Extended CONNECT floods.

## Enforced caps
- Datagram size: maxDatagramSize (must respect negotiated QUIC max)
- Stream opens: maxStreamsPerSessionBidi, maxStreamsPerSessionUni, maxStreamsGlobal
- WT sessions per QUIC connection: `wtMaxSessions` / `SETTINGS_WT_MAX_SESSIONS`
  (pending client CONNECTs and server unlatched admitted CONNECTs count toward
  the admission occupied set; see OPERATIONS CONNECT admission note)

## Metrics to monitor
- sessionsActive, handshakesInFlight, streamsActive
- wasm: wtSessionsActive, sessionClosedCount (governor snapshot)
- queuedBytesGlobal
- datagramsDropped
- backpressureTimeoutCount
- rateLimitedCount, limitExceededCount

See docs/METRICS.md for full metrics reference and structured log format.

## Prometheus / OTel export

Use `metricsToPrometheus(snapshot)` to convert `server.metricsSnapshot()` to Prometheus text format. Wire to an HTTP endpoint:

```ts
import { createServer, metricsToPrometheus } from "@webtransport-bun/webtransport";

const server = createServer({ ... });

// Expose /metrics for Prometheus scrape
Bun.serve({
  port: 9090,
  fetch(req) {
    if (new URL(req.url).pathname === "/metrics") {
      const text = metricsToPrometheus(server.metricsSnapshot(), { server_id: "main" });
      return new Response(text, {
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});
```

**Cardinality**: Metrics are per-server; add labels sparingly (e.g. `server_id`). Avoid per-session labels to prevent high cardinality.

**Scrape config**: Point Prometheus at `http://host:9090/metrics`. Recommended `scrape_interval`: 15s.

## Dashboards (P3.1)

Recommended panels for Grafana (or equivalent):

| Panel | Query | Unit |
|-------|-------|------|
| Sessions active | `webtransport_sessions_active` | short |
| Handshake p99 | `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m]))` | s |
| Datagram enqueue p99 | `histogram_quantile(0.99, rate(webtransport_datagram_enqueue_latency_seconds_bucket[5m]))` | s |
| Stream open p99 | `histogram_quantile(0.99, rate(webtransport_stream_open_latency_seconds_bucket[5m]))` | s |
| Queued bytes | `webtransport_queued_bytes_global` | bytes |
| Backpressure timeouts | `rate(webtransport_backpressure_timeout_total[5m])` | 1/s |
| Rate limited | `rate(webtransport_rate_limited_total[5m])` | 1/s |
| Limit exceeded | `rate(webtransport_limit_exceeded_total[5m])` | 1/s |

## Alert rules and paging thresholds

Configure Prometheus alerts. Severity: **page** for Sev-2, **ticket** for Sev-3.

| Alert | Condition | Severity | Runbook |
|-------|-----------|----------|---------|
| WebTransportHandshakeP99High | `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m])) > 0.3` | page | Handshake latency |
| WebTransportDatagramEnqueueP99High | `histogram_quantile(0.99, rate(webtransport_datagram_enqueue_latency_seconds_bucket[5m])) > 0.01` | page | Datagram enqueue |
| WebTransportStreamOpenP99High | `histogram_quantile(0.99, rate(webtransport_stream_open_latency_seconds_bucket[5m])) > 0.02` | page | Stream open latency |
| WebTransportQueuedBytesHigh | `webtransport_queued_bytes_global > 0.8 * maxQueuedBytesGlobal` | ticket | Queued bytes climb |
| WebTransportBackpressureTimeouts | `rate(webtransport_backpressure_timeout_total[5m]) > 1` | ticket | Backpressure timeouts |
| WebTransportRateLimited | `rate(webtransport_rate_limited_total[5m]) > 10` | ticket | Rate limited |
| WebTransportLimitExceeded | `rate(webtransport_limit_exceeded_total[5m]) > 5` | ticket | Limit exceeded |

Replace `0.8 * maxQueuedBytesGlobal` with your configured value (e.g. `419430400` for 400 MiB of 512 MiB).

## Idle timeout behavior

- `idleTimeoutMs` (default 60s): connection closed if no activity for this duration.
- Activity: any data sent or received (handshake, datagrams, stream data). QUIC keepalives may extend the window.
- When idle timeout fires: session closes with appropriate code; `closed` promise resolves.
- Slow-reader detection: streams where the peer does not drain within backpressureTimeoutMs are reset (backpressureTimeoutCount incremented).

## Runbook: handshake p99 high

When `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m])) > 0.3`:
- **Cause**: TLS/QUIC handshake slow; CPU saturation; network RTT spike; certificate validation.
- **Check**: `handshakesInFlight`, CPU, network latency to clients.
- **Actions**: Scale out; reduce `maxHandshakesInFlight` to shed load; verify cert chain not oversized.

## Runbook: datagram enqueue p99 high

When datagram enqueue p99 > 10ms:
- **Cause**: QUIC send buffer full; backpressure from slow consumers; CPU contention.
- **Check**: `queuedBytesGlobal`, `backpressureTimeoutCount`, `streamsActive`.
- **Actions**: Reduce `maxQueuedBytesPerStream`; lower `backpressureTimeoutMs`; scale out.

## Runbook: stream open p99 high

When stream open p99 > 20ms:
- **Cause**: QUIC flow control; rate limits; global stream cap saturation.
- **Check**: `streamsActive`, `limitExceededCount`, `rateLimitedCount`.
- **Actions**: Increase `maxStreamsPerSessionBidi`/`Uni` if within capacity; verify rate limits not too strict.

## Runbook: queued bytes climb
When `queuedBytesGlobal` rises and stays high:
- **Cause**: Slow consumers (clients not reading), too many concurrent streams, or bursty senders.
- **Check**: `streamsActive`, `datagramsIn` vs `datagramsOut` (backlog), `backpressureTimeoutCount`.
- **Actions**:
  - Reduce `maxQueuedBytesPerStream` or `maxQueuedBytesPerSession` to shed slow readers sooner.
  - Lower `maxStreamsPerSessionBidi`/`Uni` to limit per-session concurrency.
  - Enable debug logging to identify high-queue sessions.
- **Scale**: Add server instances and load-balance; reduce per-instance `maxSessions`.

## Runbook: tuning limits safely
- **Start conservative**: `maxSessions` 200–500, `maxQueuedBytesPerStream` 256 KiB.
- **Increase gradually**: After soak/load tests, bump by ~20% and re-run tests.
- **Monitor**: Track `limitExceededCount`, `rateLimitedCount`, `backpressureTimeoutCount` after changes.
- **Avoid**: Setting `maxQueuedBytesGlobal` > 512 MiB without load testing; unbounded growth risks OOM.

## RSS trend analysis

`bun run test:load-addon` writes RSS samples to `tools/load/rss-trend.json` and `rss-trend.csv` (override with `RSS_TREND_OUT`). Format: `ts_ms,rss_mb,sessions,streams`.

**Acceptable growth heuristics** (short load, ~15–30s):
- RSS should plateau or decline after load ends; sustained growth suggests a leak.
- Typical baseline: 50–150 MiB depending on platform. Post-load should return within ~2× baseline.
- If final RSS > 3× initial, triage: run with longer duration, check `sessionTasksActive`/`streamTasksActive` drain.

**Triage steps**:
1. Compare first vs last sample: `rss_mb` delta. If >100 MiB growth over 15s with 4 sessions, investigate.
2. Check `queuedBytesGlobal` in metrics—high queue can inflate RSS.
3. Run `bun run test:soak-addon` with `SOAK_DURATION=300`; if RSS grows linearly, suspect leak.

**Raw RSS vs charged memory on long-running servers.** The native backend
uses a whole-program allocator (mimalloc) that keeps freed pages as
reclaimable `MADV_FREE` arenas rather than returning them to the OS
immediately. On a many-hour run this makes **raw RSS climb even when the
process's charged/working-set memory is flat** — harmless with headroom, but
on a memory-constrained host the kernel OOM-killer counts raw RSS and can
kill an otherwise-healthy server. Call `releaseNativeMemory()` (which runs
`mi_collect` and returns those arenas to the OS) **periodically** — e.g. every
few minutes on a timer — for servers that run for hours on small instances.
It is safe under live traffic (proven non-disruptive by the RSS soak) and is
what the soak harness itself does via `SOAK_RELIEF_INTERVAL_MS`. Provision at
least ~2× the observed steady-state RSS, and always configure swap on small
instances.

**Committed memory, not RSS, is what the OOM-killer's world bounds.** When
swap is active the kernel pages out cold anonymous memory, so a leaking
process can show a flat RSS while `RssAnon + VmSwap` grows without bound.
The soak harness samples both from `/proc/self/status` (fields `rssAnonMb`,
`vmSwapMb`, `committedMb` in the samples sidecar) and gates on committed
drift. Its debug knobs:

- `SOAK_COMMITTED_ABORT_MB` — circuit breaker; the segment aborts with a
  partial artifact once committed memory crosses this (0 = off). Prefer this
  on small hosts over letting the kernel SIGKILL with no evidence.
- `SOAK_HEAP_DEBUG=1` — appends the top JSC object-type counts to a
  `.heap-types.jsonl` sidecar every `SOAK_HEAP_DEBUG_INTERVAL_MS` (default
  10 min). Heap scans are stop-the-world: they perturb the measurement, and
  the knobs are recorded in the segment artifact (`debugKnobs`) so evidence
  readers can see when they were active.

**Minimum Bun runtime: 1.3.14.** Bun `<= 1.3.13` permanently leaks one
`WritableStream` + rejection `Error` per stream whose close is rejected
(peer STOP_SENDING racing a close). The soak harness refuses to record or
aggregate evidence from older runtimes, and the library warns once at
startup on them.

## Troubleshooting
1) Browser cannot connect
- Verify UDP port open
- Verify cert valid (SAN matches hostname)
- Verify you are using https:// URL and WebTransport is enabled in the browser
2) Frequent disconnects
- Check idleTimeoutMs
- Check rate limiting thresholds
3) High memory
- queuedBytesGlobal near cap indicates slow consumers or too-large buffers
- reduce highWaterMark, reduce per-session/per-stream limits, scale out
4) Poor performance
- verify batching enabled
- reduce per-message overhead (larger chunk sizes, fewer crossings)

## Diagnostics modes

- **Default (recommended for production):** native diagnostics are redacted/minimal.
- **Debug mode:** set `createServer({ debug: true, ... })` to enable richer native diagnostics.
  Sensitive identifiers remain redacted; use only in trusted environments.

## Tuning guide

- **Low latency**: reduce maxQueuedBytesPerStream, use smaller datagrams, lower backpressureTimeoutMs
- **Throughput**: increase per-session limits, larger highWaterMark on streams
- **queuedBytesGlobal rising**: slow consumers or too many concurrent streams; reduce limits or scale out

### Flow-control windows

Two different things bound memory, and they used to be one knob:

- **Byte governors** (`maxQueuedBytesGlobal` / `PerSession` / `PerStream`) —
  application-level accounting of bytes queued across the JS boundary. They
  drive backpressure, `E_QUEUE_FULL`, and the native datagram channel.
- **QUIC flow-control windows** (`streamReceiveWindow`, `receiveWindow`,
  `sendWindow`) — what the transport advertises to the peer. They decide how
  much data can be in flight, and therefore throughput on a path with any
  meaningful bandwidth-delay product.

Leave the window fields unset and each one is derived from a governor, exactly
as it always has been: `streamReceiveWindow` from `maxQueuedBytesPerStream`,
and both connection windows from `maxQueuedBytesPerSession` (raised, if needed,
to cover one stream window). Set them and only the transport moves — the
governors, backpressure and the datagram channel stay where you put them.
Native backend only.

**Budget them explicitly.** Per session, the advertised worst case is

```
receiveWindow + sendWindow + datagramChannelCapacity × maxDatagramSize
```

where `datagramChannelCapacity = ceil(maxQueuedBytesPerSession / maxDatagramSize)`
capped at 2048. `maxQueuedBytesGlobal` does **not** bound this — it is a
different accounting, so a 512 MiB global governor gives no protection at all
against the window ceiling.

| config | per session | × 2000 sessions | sessions that fit 8 GB |
|---|---|---|---|
| defaults (256 KiB / 2 MiB) | 6.00 MiB | 12.6 GB | 1365 |
| windows 8 MiB / 32 MiB, governors default | 66.0 MiB | 138 GB | 124 |
| governor route to the same windows (`maxQueuedBytesPerSession` 64 MiB) | 130.3 MiB | 273 GB | 62 |

Read that table as the reason `maxSessions` and the windows are one decision:
even the shipped defaults over-commit an 8 GB box at `maxSessions` 2000 by 1.5×.
Nothing is allocated up front — a window is a ceiling a peer must actually
drive you to, and a session that reads promptly never approaches it — but it is
the only bound the transport gives you, so pick `maxSessions` against the
window you configure rather than against the default.

**What widening buys.** Measured on the 4 vCPU rig over loopback, 4 sessions ×
4 concurrent uni streams (run 32193538952): 256 KiB → 16 MiB per-stream, a 64×
memory increase, moved delivered throughput 0.781 → 1.037 Gbps (+33%), with no
knee below 8 MiB. On loopback the bandwidth-delay product is far below even the
256 KiB default, so that curve is the *cost* of a window on this rig, not the
benefit on a real path: over a WAN, where BDP routinely exceeds 256 KiB, the
default window — not the CPU — is what caps a single stream. Widen when you
measure a stalled sender on a long path; do not widen speculatively.

## Known limitations and compatibility

- Client `connect()` surface: datagrams, bidi/uni streams, metrics, configurable limits
- Configured target matrix: macOS + Linux + Windows (arm64/x64 on macOS, x64 on Linux/Windows)
- Configured runtime matrix: Bun >= 1.3.14, Node, Deno
- Node-API addon portability applies across the configured runtime matrix

## Public internet deployment

- **UDP firewalling**: Allow inbound UDP on your WebTransport port (e.g. 443). Many cloud providers require explicit security-group rules for UDP.
- **Certificates**: Use a valid TLS cert (e.g. Let's Encrypt). SAN must include the hostname clients use. Self-signed works only for dev/testing.
- **Browser failure modes**: CORS does not apply to WebTransport. Common issues: wrong URL scheme (must be https://), cert mismatch, UDP blocked by network.

## Deployment notes
- Run the runtime process as a dedicated service user.
- Use systemd on Linux; ensure Restart=on-failure.
- Collect logs centrally; scrape metrics via exposed endpoint (if you add one) or poll metricsSnapshot.

## Multi-process binds (`reusePort`)

`createServer({ reusePort: true })` sets `SO_REUSEPORT` on the bind socket so
several server processes can listen on one port. It is **native-backend only**
(the WASM backend has its own options type and owns no socket) and **unix
only**: on a platform without `SO_REUSEPORT` the call throws
`E_UNSUPPORTED_ARGUMENT` rather than binding without it. It also requires an
explicit `port` — `port: 0` throws `E_INVALID_ARGUMENT`, since each instance
would get its own ephemeral port and share nothing.

**The flag alone is not a load-balancing answer.** Read these two before
turning it on:

- **4-tuple hashing breaks long-lived sessions.** Plain kernel steering picks a
  group member by hashing the packet's source/destination address and port. A
  QUIC connection survives a client address change by design (the connection ID
  identifies it, not the 4-tuple), but the kernel does not read connection IDs
  — after a NAT rebind or a client interface change the same connection hashes
  to a *different* process, which does not recognize it. The connection does not
  close: it **stalls until the idle timeout expires (60 s by default,
  `crates/native/src/limits.rs:47`)**, so what the application sees is a hang
  followed by a timeout, not a clean drop. See §3 of
  `docs/research/2026-08-21-bare-metal-capacity.md` for the verified mechanism.
  The same argument applies to plain ECMP.
- **Group membership changes re-hash the whole group.** Adding or removing a
  socket changes the hash distribution for every flow, not just new ones.
  Restarting one instance therefore re-steers surviving connections that belong
  to its *siblings*, so a routine rolling restart drops sessions fleet-wide.

What the flag is for:

- **eBPF-steered topologies.** An `SK_REUSEPORT` program attached to the group
  can pick the socket by reading the QUIC connection ID's server-ID bytes
  instead of the 4-tuple, which is rebind-stable. That requires the server to
  encode a server ID in the connection IDs it issues.
- **Benchmarks and load-generation rigs**, where sessions are short and
  distribution does not have to be stable.

Neither the rebind failure nor the restart re-hash has been measured on this
project's rigs; both are deductions from RFC 9000 §5.1/§9 and the kernel's
documented reuseport behavior. Distribution across the group is the kernel's,
not this library's: Linux hashes across members, BSD/macOS delivers to the last
binder.

The full argument, the supported deployment pattern, and the sizing figures
live in
[docs/research/2026-08-21-bare-metal-capacity.md](research/2026-08-21-bare-metal-capacity.md)
— sections 3 ("Unsupported: 4-tuple-hash balancers in front of long-lived
sessions") and 4 ("Four disclosures you must read before deploying any steered
pattern").

## QUIC-LB connection IDs (`quicLb`)

`reusePort` gives you a group of processes on one port; `quicLb` gives the
thing steering that group something rebind-stable to steer *by*. With

```ts
createServer({
  port: 4433,
  quicLb: { serverId: new Uint8Array([0x00, 0x07]), nonceLen: 8 },
  tls, onSession,
});
```

every connection ID this instance issues carries `00 07` in the clear, so an
`SK_REUSEPORT` eBPF program or an external L4 balancer can read the backend out
of the packet header instead of hashing the 4-tuple. That is what makes the
steering survive a client's NAT rebind: the connection ID is the connection's
own name and travels with it, while the 4-tuple does not.

**Native backend only** — the WASM backend has its own options type and issues
no connection IDs of its own. Absent, the option changes nothing: quinn's
opaque 8-octet connection IDs are the default.

### The layout

Written against **draft-ietf-quic-load-balancers-21**, the **keyless**
configuration of §5.3:

```text
first octet   3 config-rotation bits + 5 random bits    §3.1, §3.3
server ID     serverId.length octets, >= 1              §5.3
nonce         nonceLen octets, >= 4, random per CID     §5.4
```

`serverId.length + nonceLen` must be 19 or less, because QUIC v1 caps
connection IDs at 20 octets and the first one is spent on the first octet. The
keyed configuration is the same format with the plaintext block encrypted; it
is a later option, not a different scheme.

### `nonceLen` is required on purpose

Nothing in the connection ID encodes the nonce length or the server-ID length —
a balancer learns both from its own configuration. A default here would let the
server write one layout while the balancer decodes another, and the symptom
would be traffic landing on arbitrary backends, which reads as a flaky network
rather than as a misconfiguration. So `nonceLen` has no default and an absent
one throws `E_INVALID_ARGUMENT`. Every other bound is checked the same way, in
JS, before the addon is touched.

`configRotation` (0–6, default 0) labels which configuration generation issued
a connection ID, so a fleet can roll to new parameters while connections issued
under the old ones stay routable. `7` (0b111) is reserved for unroutable
connection IDs (§3.2) and is rejected.

### Cost 1: the topology is in cleartext

The draft states the tradeoff in its own words (§5.3): "failure to define a key
means that observers can determine the assigned server of any connection,
significantly increasing the linkability of QUIC address migration." Anyone on
the path can tell which backend serves a connection, count your fleet, and link
a connection across a migration that QUIC otherwise makes unlinkable. That is
the price of keyless routing; the keyed configuration is what buys it back, and
it is not built.

### Cost 2: bytes on every packet

A QUIC-LB connection ID is `1 + serverId.length + nonceLen` octets — **11** for
the example above, **6** at minimum, up to 20 — against quinn's **8**-octet
default. Once the client adopts a server-issued connection ID, that difference
is paid on the destination-CID field of **every short-header packet** in both
directions, for the life of the connection.

Put against this rig's measured egress, that is small but not free. G7's stream
cell moved **1.2498 Gbps** with byte-exact ledgers (the run's 79.1% host-CPU
maximum was measured on a *different* cell, B-1k — see the
[capacity doc](research/2026-08-21-bare-metal-capacity.md), §"Host-level
envelopes"); at the ~1,400-byte datagrams that path carries, three extra header
octets is roughly **0.2%** of the wire bytes, and G3's egress cell ran with GSO
and GRO active at 64 segments, so the added bytes ride the same syscalls rather
than costing new ones. It has **not been measured** — no gate has run with
`quicLb` on. Size a minimal `nonceLen` (4) and a minimal `serverId` if your
fleet is small and the bytes matter; note that a short nonce shrinks the
unlinkability budget §5.4 asks you to keep.

### Reading connection IDs on the balancer side

The package exports the decoders, pure and addon-free, so an eBPF loader or a
routing test can read a connection ID without opening a socket:

```ts
import {
  decodeQuicLbServerId,
  decodeQuicLbConfigRotation,
} from "@webtransport-bun/webtransport";

const serverId = decodeQuicLbServerId(cid, 2); // null if the CID is too short
const rotation = decodeQuicLbConfigRotation(cid); // 7 means unroutable (§3.2)
```

`serverIdLen` is yours to supply from configuration; it is never on the wire.

### What it does not do

The first flight is still unrouted by connection ID: the client picks its own
random destination CID for the Initial, so routing falls back to the 4-tuple
until the server's CID is adopted, and a rebind inside that window still breaks
the connection. See disclosure (b) in the capacity document. Rotation, Retry,
version negotiation, and the unroutable codepoint are all the balancer's
problem, not this option's.

A worked configuration — how `reusePort` + `quicLb` + an eBPF steering program
compose on one box, and how `quicLb` composes with an external L4 balancer
across machines — is in [quic-lb.md](quic-lb.md), with a reference
`SK_REUSEPORT` program (an example, not a shipped component) in
[examples/quic-lb/](../examples/quic-lb/README.md).

---

## Runbook: Rollback to known-good release

Use when a release introduces critical regressions (crashes, data corruption, security issues) and reverting code is not immediately feasible.

### Trigger conditions

- Critical bug or security issue in the current release discovered post-publish
- Production incidents traced to the latest release
- Decision by maintainers to revert users to a previous stable version

### Prerequisites

- GitHub CLI (`gh`) installed (for local drill) or access to run the `rollback` workflow
- Identify the known-good release tag (e.g. `v0.1.0`) from release history

### Option A: CI workflow (recommended)

1. Open **Actions → rollback** workflow.
2. Click **Run workflow**.
3. Enter the rollback target tag (e.g. `v0.1.0`).
4. Run the workflow.
5. On success: the job summary contains the exact pin command. Proceed to **Operator action** below.

### Option B: Local script

```bash
./scripts/rollback-drill.sh v0.1.0
```

Requires `gh` CLI authenticated. Verifies artifact checksums and prints the runbook.

### Operator action (after validation)

Instruct users to pin to the validated release:

```bash
bun add @webtransport-bun/webtransport@<VERSION>
npm i @webtransport-bun/webtransport@<VERSION>
pnpm add @webtransport-bun/webtransport@<VERSION>
yarn add @webtransport-bun/webtransport@<VERSION>
```

Example: for rollback target `v0.1.0`, users run:

```bash
bun add @webtransport-bun/webtransport@0.1.0
npm i @webtransport-bun/webtransport@0.1.0
pnpm add @webtransport-bun/webtransport@0.1.0
yarn add @webtransport-bun/webtransport@0.1.0
```

### Expected validation signals

- **Checksum verification passes**: `shasum -a 256 -c SHA256SUMS` exits 0
- **Assets present**: `webtransport-native.*.node` for linux-x64, darwin-arm64, darwin-x64, win32-x64-msvc
- **SHA256SUMS exists**: Required; releases before the combined checksum change may not have it (run a new release first if needed)

### Follow-up

- Open an issue to track the regression and fix
- Consider deprecating the bad release on npm: `npm deprecate @webtransport-bun/webtransport@<bad_version> "Critical regression; use <known_good_version>"`
- Cut a patch release once the fix is merged and tested
