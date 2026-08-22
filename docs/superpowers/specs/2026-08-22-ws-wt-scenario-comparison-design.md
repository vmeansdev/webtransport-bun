# WebSocket vs WebTransport Scenario Comparison Design

Date: 2026-08-22
Status: independent analysis and implementation design
Repository baseline: `d15658d3c1e0fce8cc7c0fd4b954f8d2fe51673a`
Required topology: Mac client/controller `10.99.0.1/en8` to Linux server
`10.99.0.2/eno1` over the direct physical cable

## Executive conclusion

The supplied analysis identifies the right product gap: the repository has no
WebSocket scenario harness and no source-bound, same-rig WT-vs-WS table. Its ten
proposed scenarios are useful. Its evidence table, however, overstates how many
WebTransport numbers are eligible for comparison and misclassifies several
campaign workloads.

No historical number is admissible as a paired baseline for this work. Nearly
all quoted campaign measurements were produced with co-resident generator,
server, and sink roles over loopback. The paced-broadcast successor did put
traffic on the direct cable, but it is not a current-HEAD G10 rerun and its
spread arm was `NO-VERDICT`. The new comparison therefore starts with an empty
measured table. It may display a valid WS row while the corresponding WT row is
typed `BLOCKED`, but it must never compute a delta until both arms share the
same source, scenario hash, topology, impairment, and evidence contract.

The recommended implementation is one transport-neutral scenario engine with
two thin adapters: Bun-native WebSocket and the existing native WebTransport
package. This is the only approach that makes the application workload,
payloads, pacing, topology, metrics, and evidence checks identical by
construction.

## Independent audit of the supplied analysis

### What the supplied analysis gets right

- There is no WebSocket implementation under the benchmark/load surfaces and
  no direct WT-vs-WS measurement in the repository.
- The ten scenarios cover the important workload families: fan-out, ingest,
  loss and head-of-line behavior, reconnect, scale memory, collaboration,
  streaming, handshake, bulk, and control latency under contention.
- Industry anecdotes or estimates cannot substitute for same-rig results.
- Loss injection, reconnect/0-RTT, and handshake measurements are especially
  valuable because they test structural differences instead of loopback
  throughput alone.
- The approved benchmark baseline is blocked, so current regression artifacts
  cannot be promoted into a comparison table.

### Corrections required before implementation

| Supplied claim | Independent finding | Consequence |
| --- | --- | --- |
| G11-X is ticker/request-reply over datagrams. | G11-X is reliable bidi-stream request/response: 256-byte requests and 1,024-byte responses. | It is an RPC/churn analogue, not datagram ticker evidence. |
| G9 supports the IoT/high-frequency-ingest row. | G9 is session churn with a 200-session base and 75/150/300/600 opens per second. | Do not reuse the G9 figure as ingest throughput. |
| G4/G8 fan-out figures are directly reusable. | Their receiver/generator roles were co-resident and their registrations exclude off-box capacity claims. G8 covered one narrowed cell, not its full matrix. | Historical values are context only and cannot populate a paired row. |
| G1 proves a comparable 10k session result. | The passing G1 arm was staggered and co-resident; synchronized arrival was not covered. | A fresh two-host connection ladder is required. |
| G5 is a 1.2505 Gbps datagram result. | G5 phase 1 was `NO-VERDICT`; G5b is the corrected paced reliable uni-stream bulk arm. | Keep G5/G5b and datagram/stream semantics distinct. |
| G3 is one clean passing gate. | Original G3 was invalid/incomplete; corrected G3b passed, still co-resident. | Name the corrected arm and do not promote it off-box. |
| G9 bare-metal churn is already clean comparison evidence. | Its visible terminal result lacks a current source/run/route restamp and inherits the campaign's co-resident default. | Re-run under the new evidence schema. |
| All existing WT numbers are loopback. | The paced-broadcast successor carried selected traffic over the cable, but it was not G10, was not current-HEAD, and its spread check was invalid. | Preserve it as historical context only; do not call it a paired baseline. |
| Bulk should compare WT streams plus datagrams with one WS transfer. | A reliable 100 MiB object maps fairly to one WT uni stream and one WS binary message stream. | Do not include a lossy WT datagram arm in the primary bulk comparison. |
| Industry WS estimates help fill missing cells. | They are unbound to runtime, source, host, workload, or topology. | The result table contains measurements or typed blockers only. |

Supporting repository evidence includes:

- `docs/research/2026-08-21-bare-metal-capacity.md`: co-resident campaign
  caveat, route-parser failure, direct-cable identity, and paced-broadcast
  successor disclosures.
- `tools/load/bench-bandwidth.ts`: explicitly single-host CPU/network
  accounting and loopback target.
- `tools/load/distributed-scale.ts`: reusable bounded-process and peer-identity
  patterns, but loopback remains possible under its current defaults.
- `tools/bench/{handshake-latency,stream-throughput,datagram-throughput}.ts`:
  current loopback-only benchmark producers.
- `docs/PARITY_MATRIX.md` and `packages/webtransport/test/native-0rtt.test.ts`:
  current native 0-RTT shape and its opt-in/replay-safety constraints.

## Current eligibility by requested scenario

`Partial` means a workload primitive exists, not that an admissible result or
an exact current harness exists.

| Scenario | Current WS harness | Current WT primitive/harness | Admissible paired number today |
| --- | --- | --- | --- |
| 1. Chat fan-out | Missing | Partial: compose-collab and historical G4/G8 shapes | None |
| 2. Ticker ingest + 1:100 fan-out | Missing | Partial: stream/datagram and paced-mirror primitives | None |
| 3. Game tick under loss | Missing | Partial: datagrams and historical G2/G3 shapes; no netem campaign | None |
| 4. Reconnect/0-RTT storm | Missing | Partial: native 0-RTT plus loopback churn tests | None |
| 5. Memory-per-connection ladder | Missing | Partial: loopback scale/RSS tools | None |
| 6. CRDT edit sync | Missing | Missing: compose-collab is cursor/snapshot demo, not CRDT | None |
| 7. AI token stream | Missing | Missing | None |
| 8. Handshake matrix | Missing | Partial: loopback handshake benchmark | None |
| 9. Bulk one-way | Missing | Partial: small echo and historical bulk shapes | None |
| 10. Tail latency under cross-traffic | Missing | Partial: historical G2/G11 concepts | None |

## Comparison contract

### Compare application outcomes, not unlike transport counters

The scenario driver owns the application workload. The adapters own only
transport mechanics. A common event ledger records:

- offered by the scheduler;
- accepted into the adapter;
- locally queued;
- observed by the Linux server;
- acknowledged when the scenario defines an acknowledgement;
- uniquely delivered;
- duplicate, reordered, stale, expired, refused, or timed out.

WT mirror `sent`/`admitted` and Bun WebSocket `send()` are admission signals,
not delivery. Neither may be compared directly with receiver counts.

Reliable scenarios require exact byte-for-byte completion. Latest-state/game
scenarios report both delivery and freshness. WebSocket remains reliable and
ordered in the primary arm; an explicitly labeled `ws-lossy-overlay` may drop
expired updates at the receiver to separate TCP head-of-line behavior from an
application freshness policy. It never replaces the raw WS arm.

### Fixed equivalence dimensions

Both arms use the same:

- exact Git candidate and source archive digest;
- Linux server and Mac client/controller;
- direct-cable addresses, route, interface, and MTU;
- generated certificate, trust identity, TLS mode, and SNI;
- compression setting (`off` for all primary arms);
- application payload length and payload hash;
- logical connection/session mapping (one WS connection per WT session);
- offered schedule, seed, burst policy, warmup, duration, and deadlines;
- impairment profile and direction;
- process roles and telemetry capture;
- randomized/interleaved arm order.

Transport-specific setup bytes, framing overhead, connection establishment,
and protocol behavior remain part of the measured cost. No proxy, CDN, load
balancer, pooling, WebSocket compression, insecure certificate bypass, or
loopback address is allowed.

### Canonical capacity and admission profile

The v1 registry embeds and hashes one explicit `capacityProfile`; no adapter
may inherit its runtime defaults. The profile is submitted through public
native WT server options and an equivalent WS admission/queue layer with the
same algorithm, counters, and rejection semantics:

| Field | Canonical value |
| --- | ---: |
| `maxSessions` | 12,000 |
| `maxHandshakesInFlight` | 512 |
| `maxStreamsPerSessionBidi` | 8 |
| `maxStreamsPerSessionUni` | 8 |
| `maxStreamsGlobal` | 24,000 |
| `maxDatagramSize` | 1,200 bytes |
| `maxQueuedBytesGlobal` | 512 MiB |
| `maxQueuedBytesPerSession` | 2 MiB |
| `maxQueuedBytesPerStream` | 256 KiB |
| `backpressureTimeoutMs` | 5,000 |
| `handshakeTimeoutMs` | 10,000 |
| `idleTimeoutMs` | 60,000 |
| `handshakesPerSec` / `handshakesBurst` / `handshakesBurstPerPrefix` | 20,000 / 20,000 / 20,000 per observed Mac source |
| `streamsPerSec` / `streamsBurst` | 20,000 / 20,000 per observed Mac source |
| `datagramsPerSec` / `datagramsBurst` | 20,000 / 20,000 per observed Mac source |

The 12,000-session ceiling covers the largest 10,000-subscriber/client cell
plus publishers, control roles, and explicit headroom. Ordinary fanout and
connection-scale setup opens at 500 connections/s with at most 200 connects in
flight; lifecycle scenarios instead use their frozen 100-client barriers. The
setup schedule is also part of the scenario hash. Capacity and rate-limit
counters are emitted by both adapters. Hitting a frozen transport/admission
limit is a valid numeric `MISS`, never an excuse to alter the profile or rerun
one protocol with looser settings. Each adapter records the exact canonically
serialized profile it submits and its SHA-256. Fake-backed adapter tests prove
those exact values reach the public constructor/options seam, while the source
archive and platform-binary hashes bind the implementation that performs the
submission. WT's public metrics surface does not expose a runtime applied-config
snapshot, so the evidence never claims one; limit/rate counters are behavioral
corroboration only. A comparator rejects a missing or unequal registry profile,
submitted-profile bytes/hash, or admission-counter schema.

### Clock contract

No metric subtracts a Linux wall-clock timestamp from a Mac wall-clock
timestamp. End-to-end latency uses a Mac-local monotonic send/receive interval
for workloads whose publisher and receiver live in the Mac driver. Server-side
service intervals use Linux monotonic time. One-way latency is omitted unless
clock offset and uncertainty are independently recorded.

## Required topology and promotion gate

Every network scenario uses:

```text
Mac controller/client                 Linux server
darwin-arm64                          linux-x86_64
10.99.0.1 / en8        cable          10.99.0.2 / eno1
       scenario traffic  <=========>  Bun WS or native WT server
       SSH control may use Tailscale, but measurement traffic may not
```

The verifier rejects:

- `localhost`, loopback, unspecified, or Unix-socket endpoints;
- the same host identity for client and server;
- a Mac route not using `en8` with source `10.99.0.1`;
- a Linux route not using `eno1` with source `10.99.0.2`;
- a Linux server that does not observe the expected Mac peer;
- absent/mismatched impairment state;
- absent Linux host/process/NIC sidecars;
- absent Mac FD/ephemeral-port capacity proof or an effective child limit
  below 65,536 for a connection-scale role;
- a dirty or source-unbound candidate;
- a scenario-network smoke run on loopback.

Pure unit tests may run locally without opening a socket. Every new integration
or measurement test uses the Linux machine. Existing unrelated package tests
remain verification only and can never become comparison evidence.

## Scenario registry v1

All durations below are measured intervals after a bounded warmup. Pilot runs
are non-promotable. Long cells use one warmup plus five measured repetitions;
short handshake cells use three warmups plus fifteen measured repetitions.
Run order is seeded and balanced across protocols.

| ID | Fixed workload | Primary metrics |
| --- | --- | --- |
| `chat-fanout` | 10 publisher connections, 1,000/5,000/10,000 subscriber connections, each publisher emits one 128-byte reliable message/s for 30 s. | offered and unique delivered msg/s, delivery ratio, Mac-local p50/p95/p99 publish-to-receive, server CPU/RSS, queue peaks |
| `ticker-fanout` | One publisher, 100 subscribers, 100-byte reliable records at 10k/50k/100k records/s for 10 s; every input is broadcast 1:100. | offered/accepted/delivered records and bytes/s, completeness, p50/p95/p99, sender/server/client ceilings; overload is a measured outcome, not silently downscaled |
| `game-tick-loss` | One publisher and 100 receivers, 64-byte latest-state ticks at 20/60 Hz for 30 s; Linux-server egress netem matrix 1/2.5/5% loss × 20/40 ms delay. | latest-state age p50/p95/p99, stale/expired/unique/missing counts, delivery ratio, control p99; raw WS, optional WS lossy overlay, WT datagram arms |
| `reconnect-storm` | 100 clients × 10 reconnect cycles, concurrency 100, 32-byte idempotent first message and acknowledgement; cold and resumed arms. Each cold cycle uses a fresh child process/cache. Each warm repetition uses a fresh cohort of 100 one-client worker processes; every worker primes its own process-local state before ten sequential measured reconnects. | connect-start to first usable ack p50/p95/p99, sessions/s, failures, WT `has0Rtt`/`accepted0Rtt`/confirmation counts |
| `connection-memory` | 1,000/5,000/10,000 concurrent idle connections held 30 s, same TLS and limits, no pooling. | Linux charged/RSS delta and bytes/connection, Mac RSS, FDs/sockets, establishment time, cleanup recovery |
| `crdt-sync` | 100 clients, deterministic 96-byte actor/clock/key/value operations at 1,000 ops/s aggregate for 60 s, periodic canonical snapshots; persistent reliable channel. | applied unique ops/s, convergence hash/completeness, Mac-local merge latency p50/p95/p99, bytes and CPU |
| `ai-token-stream` | 100 sessions, server-to-client chunks of 32/64/128/256 bytes at 50 chunks/s/session for 30 s; bounded client work queue and a 500 ms processing pause every 5 s. | inter-chunk gap p50/p95/p99, source-schedule miss, queue peak, backpressure duration/timeouts, completeness |
| `handshake-matrix` | 100 connections per cell; cold=one fresh Mac child process/cache per sample, warm=a fresh 100-process one-client cohort whose members each prime once before one measured connection; direct physical baseline and Linux egress `delay 40ms`. | ready and first-usable p50/p95/p99, sessions/s, failure/timeout rate, WT resumption truth counters |
| `bulk-one-way` | Exactly 100 MiB Linux-to-Mac in 64 KiB application chunks; one WS connection versus one WT uni stream; physical baseline and Linux egress `delay 40ms loss 1%`. | application Mbps, completion time, exact digest, CPU/RSS, queue/backpressure, retransmission/kernel counters |
| `tail-under-cross-traffic` | One logical session/connection; 64-byte acknowledged control message at 1 Hz for 180 s while Linux sends 64 KiB reliable bulk chunks paced at 700 Mbps. WS multiplexes on one ordered socket; WT uses distinct reliable streams in one session. | control p50/p95/p99 and ≤4 ms classifier, bulk achieved Mbps, queue/stall time, CPU/RSS |

These parameters are versioned and hashed. CLI overrides create a distinct
scenario hash and cannot populate the canonical v1 table.

### Canonical cells, roles, and directions

The registry contains exactly **35 primary workload cells** per transport and
12 additional `ws-lossy-overlay` game cells: 35 WS primary arms, 35 WT primary
arms, and 12 labeled overlay arms, for 82 canonical arm definitions before
warmups/repetitions.

| Scenario | Cell enumeration | Mac roles | Linux role | Application direction and WT mapping |
| --- | --- | --- | --- | --- |
| `chat-fanout` | subscriber count `1000|5000|10000` (3) | 10 publishers plus subscriber workers | reliable relay/server | Mac publishers → Linux → Mac subscribers; persistent bidi publisher channels and persistent server-opened uni subscriber channels |
| `ticker-fanout` | ingress rate `10000|50000|100000` (3) | one publisher plus 100 subscribers | reliable relay/server | Mac publisher → Linux → Mac subscribers; the same persistent reliable channel mapping as chat |
| `game-tick-loss` | tick `20|60` × loss `1|2.5|5` × delay `20|40` (12) | one publisher plus 100 receivers | datagram/message relay and impairment endpoint | Mac publisher → Linux → Mac receivers; WT datagrams, raw reliable WS messages, plus labeled WS receiver-expiry overlay |
| `reconnect-storm` | `cold-full|warm-after-prime` (2) | 100 reconnecting clients; fresh child per cold cycle, or fresh 100-process one-client cohort per warm repetition | stable-lifetime server/acknowledger | Mac request → Linux ack; WT full handshake control or verified 0-RTT, WS full/warm TLS WebSocket handshake; process/cache policy is identical by arm across protocols |
| `connection-memory` | live set `1000|5000|10000` (3) | idle clients | accepting server | Mac establishes/holds sessions; one WS connection per WT session |
| `crdt-sync` | canonical operation profile (1) | 100 actors/receivers | reliable relay/snapshot authority | Mac actors → Linux → Mac peers; persistent reliable framed channels, with merge/apply on Mac |
| `ai-token-stream` | chunk bytes `32|64|128|256` (4) | 100 receivers with bounded work queues | token source/server | Linux → Mac; WS messages versus server-opened persistent WT uni streams |
| `handshake-matrix` | path `physical|delay40` × state `cold|warm-after-prime` (4) | connection initiators and first-message timers; fresh child per cold sample, or fresh 100-process one-client cohort per warm repetition | stable server/acknowledger | Mac connect/request → Linux ack; each warm worker primes once before its measured connection, verified WT 0-RTT in WT warm cells; WS TLS resumption is not claimed because Bun exposes no acceptance signal |
| `bulk-one-way` | path `physical|delay40-loss1` (2) | one sink | bulk source/server | Linux → Mac; one WS binary-message stream versus one server-opened WT uni stream |
| `tail-under-cross-traffic` | canonical 700 Mbps profile (1) | one sink plus control initiator | bulk source and control acknowledger | bulk Linux → Mac; control Mac → Linux → Mac; one WS socket versus separate WT uni bulk and bidi control streams in one session |

Multi-client Mac roles are deterministically sharded across eight worker
processes (a separate publisher/control process where listed), with the same
shard assignment for WS and WT. Connection-lifecycle arms are the explicit
exception: cold reconnect cycles and cold handshake samples use a fresh child
process/cache, while each warm repetition starts a fresh cohort of 100
one-client processes. Each warm worker primes only its own process-local state;
process creation and priming complete before the measured barrier and are not
included in connection latency. The same arm-specific process topology is used
for WS and WT. Worker count, role, direction, shard membership, cohort identity,
and expected cell/arm counts are part of the scenario hash and artifact. A Mac
with fewer than eight available logical CPUs blocks the canonical campaign
rather than changing the apparatus.

## Adapter design

```ts
type DeliveryKind = "datagram" | "reliable-message";

interface TransportAdapter {
  readonly kind: "ws" | "wt";
  startServer(config: ServerConfig): Promise<ServerHandle>;
  connect(config: ClientConfig): Promise<Session>;
}

interface ServerHandle {
  acceptSession(deadlineMs: number): Promise<Session>;
  stop(deadlineMs: number): Promise<void>;
  snapshot(): TransportMetrics;
}

interface Session {
  sendMessage(
    kind: DeliveryKind,
    message: WireMessage,
    deadlineMs: number,
  ): Promise<SendObservation>;
  receiveMessage(kind: DeliveryKind, deadlineMs: number): Promise<WireMessage>;
  openUni(deadlineMs: number): Promise<SendChannel>;
  acceptUni(deadlineMs: number): Promise<ReceiveChannel>;
  openBidi(deadlineMs: number): Promise<BidiChannel>;
  acceptBidi(deadlineMs: number): Promise<BidiChannel>;
  close(deadlineMs: number): Promise<void>;
  snapshot(): TransportMetrics;
}

interface SendChannel {
  write(bytes: Uint8Array, deadlineMs: number): Promise<SendObservation>;
  end(deadlineMs: number): Promise<void>;
}

interface ReceiveChannel {
  read(deadlineMs: number): Promise<Uint8Array | null>;
  cancel(deadlineMs: number): Promise<void>;
}

interface BidiChannel extends SendChannel, ReceiveChannel {}
```

On WT these lifecycle methods map to real datagrams and uni/bidi streams. On WS
they map to framed virtual channel IDs over the single connection, so a
scenario can request the same role/direction while TCP retains its actual
single ordered byte-stream behavior. Server-side accept/create and
client-side accept/create are explicit; no optional method or direction
inference is permitted.

The shared driver owns pacing, workload state, sequence/expiry metadata,
acknowledgements, histograms, warmup barriers, bounded waits, and shutdown.

The WS adapter uses only Bun 1.3.14 native APIs:

- `Bun.serve({ websocket, tls })` on Linux;
- global `WebSocket` on Mac with Bun 1.3.14's installed
  `Bun.WebSocketOptions.tls` (`ca`, `serverName`, and
  `rejectUnauthorized: true`); this capability is asserted by a preflight
  compile/runtime probe before any campaign arm;
- binary messages and `perMessageDeflate: false`;
- explicit `backpressureLimit`, `closeOnBackpressureLimit`, idle timeout,
  payload cap, and client high/low watermarks;
- server `send()` status plus `drain`, and client `bufferedAmount` polling;
- a bounded receive queue and deterministic close/error mapping.

Server send status `-1` means queued and must not be resent; `0` is recorded as
a refusal/drop and fails reliable cells. Client `bufferedAmount` is local queue
state, not delivery.

The WT adapter uses existing native APIs only. It maps reliable scenarios to
long-lived uni/bidi streams, latest-state scenarios to datagrams, connection
scale to sessions, and reconnect cells to the existing opt-in 0-RTT surface.
No WebTransport product behavior is added or changed by this project.

WT warm/resumed cells keep one Linux server process alive with
`enable0Rtt: true`, `allowEarlySession: true`, one stable certificate/SNI, and
a fresh cohort of 100 one-client Mac worker processes per repetition. This is
required because the native ticket store is process-local, keyed by TLS
identity/SNI, and retains at most eight tickets for one server identity; a
single shared process therefore cannot make a 100-client wave eligible. Before
the measured barrier, every worker opens and closes its own prime connection
and waits boundedly for usable process-local state. Reconnect workers then
perform ten sequential measured cycles, synchronized as 100-client waves;
handshake workers perform one measured connection. Each resumed connection
consumes process-local state and a confirmed handshake replenishes the next.
The run records `has0Rtt`, `accepted0Rtt`, and `handshakeConfirmed` for every
cycle. The first 32-byte message is idempotent and keyed by
run/client/cycle, and the Linux dedup ledger makes replay harmless. Any cycle
lacking the required observed resumption signals is a measured `MISS`, never
assumed from configuration. Cold cells use fresh Mac child processes with no
ticket import for every measured connection. WS uses the identical cold/warm
process and barrier topology, but receives no synthetic 0-RTT label. Vault
export/import is not used in any canonical cell.

## Evidence and report contract

Each run writes raw client, server, topology, impairment, and cleanup artifacts.
The merged comparison artifact includes:

- schema version, comparison/run IDs, status and `promotable`;
- full candidate SHA, clean-tree proof, source archive SHA-256, executable and
  toolchain identities;
- scenario ID, canonical config, scenario hash, seed, repetition and arm order;
- capacity-profile ID/hash, every requested limit/rate, exact normalized
  submitted-profile bytes/hash, admission counters, connection ramp, and
  Mac/Linux FD/port capacity proofs; no field is labeled a runtime-applied WT
  echo;
- distinct Mac/Linux host IDs, OS/arch/CPU/Bun, process roles;
- route/interface/address/MTU and server-observed peer proof;
- TLS/SNI/certificate fingerprint and compression mode;
- requested and observed qdisc impairment before/after plus restoration proof;
- raw samples, histograms, counters, telemetry, and artifact byte digests;
- typed evidence status `PASS`, `FAIL`, or `BLOCKED` per arm and comparison,
  plus a separate scenario verdict `PASS`, `MISS`, or `NO_VERDICT`.

`evidenceStatus: PASS` means the run and its evidence are valid; it does not
mean the transport met a performance target. A valid capacity shortfall is a
measured numeric result with `scenarioVerdict: MISS`. `FAIL` means the harness
or evidence contract failed, while `BLOCKED` means the arm could not execute
because a required external prerequisite was absent.

Valid WS data remains visible when WT is missing, but the WT cell reads, for
example, `BLOCKED: WT_ARM_NOT_MEASURED`, and the delta reads `not computed`.
Zero and bare `null` never stand in for missing evidence.

Mandatory negative controls mutate source SHA, artifact bytes, run ID, scenario
hash, payload, topology, route, host identity, Linux participation, impairment,
TLS identity, units, samples, and promotability. Every mutation must be rejected
with a stable reason.

## Remote execution and impairment safety

The Mac controller archives the exact clean candidate once. It extracts that
same archive into unique Mac and Linux run directories, verifies the digest on
both hosts, installs with the frozen lockfile, builds the platform-native addon
on each host, and launches every role from those staged directories. Artifacts
hash the Mac and Linux JS entrypoints plus native addon binaries. It acquires
`/tmp/bench.lock` before starting a server. Linux creates a run-scoped P-256 CA
and a CA-signed leaf whose SAN is `IP:10.99.0.2,DNS:wt-compare.local`; both
protocol servers reuse that exact leaf/key. The private CA/leaf keys remain on
Linux; only the public CA, leaf, and fingerprint return to Mac.

SSH commands and stdout/stderr drains have deadlines. Cleanup targets only
validated run-scoped PIDs/process groups. Broad `pkill` is forbidden.

A planning-session diagnostic observed Linux soft/hard `nofile` limits of
1,024/524,288, Mac shell soft/hard limits of 1,048,575/unlimited,
`kern.maxfilesperproc=245,760`, a Mac ephemeral range of 49,152–65,535
(16,384 ports), and Linux root qdisc `fq`. These values are feasibility notes,
not promotable evidence and not prerequisites asserted from the plan: Task 12
must recollect and bind all of them at the exact candidate HEAD before any
network run. Every Linux connection-scale role raises only its own child soft
limit to 65,536 before `exec` when the freshly observed hard cap permits it;
it never mutates host-wide limits or kernel settings. Every Mac
connection-scale child records its effective `RLIMIT_NOFILE`; the freshly
observed effective per-process/kernel ceiling must be at least 65,536. Before
every 5,000- or 10,000-client arm, the controller records the configured range
and all currently occupied ports for source `10.99.0.1`, and requires at least
12,500 conservative free ephemeral ports before the 10,000-client arm (the
maximum live set plus 25% headroom; proportionally 6,250 at 5,000). Failure of
an FD, port, or initial-`fq` gate makes the affected cell `BLOCKED`; the harness
does not change persistent host limits, ranges, aliases, or the prerequisite
record to force a pass.

Netem is applied only to Linux `eno1`, after raw route proof and a non-measured
probe. A remote supervisor holds `flock` on `/tmp/bench.lock`, owns the exact
server process group, snapshots the original qdisc, and watches a controller
heartbeat lease. Lease expiry kills only that group, restores `fq`, writes a
cleanup artifact, and releases the lock, so controller/SSH loss does not rely
on the controller's `finally`. The controller also performs normal bounded
shutdown and an independent recovery/status command before the next run.

Missing passwordless privilege or a pre-execution qdisc mismatch makes an
affected cell `BLOCKED`. A failed post-execution restoration is
`evidenceStatus: FAIL`, `scenarioVerdict: NO_VERDICT`, stops the campaign, and
prohibits promotion; it may not fall back to an unimpaired result.

## Alternatives considered

### A. Ten independent WebSocket scripts

Fastest first edit, but workload logic, timing, and metrics would drift from WT.
Every future correction would need twenty implementations. Rejected.

### B. Shared scenario engine with WS and WT adapters

Selected. It centralizes application semantics and evidence while preserving
transport-specific behavior. It requires more initial structure but yields a
defensible paired table and reusable scenarios.

### C. WS-only runs compared with historical WT reports

Would produce numbers quickly, but violates source, topology, workload, and
impairment equivalence. It would turn stale/co-resident measurements into false
deltas. Rejected. Historical WT figures may appear only in a separately labeled
context appendix.

## Completion definition

The project is complete when:

1. all ten canonical scenarios and both adapters exist;
2. all pure unit, schema, negative-control, and parser tests pass;
3. every new network integration and measurement run uses the Mac↔Linux cable;
4. the final candidate is clean and source-bound on both hosts;
5. every canonical WebSocket cell has a measured numeric result or an honest
   externally caused `BLOCKED` artifact after all in-scope recovery paths are
   exhausted;
6. paired WT rows are measured under the identical scenario when feasible, and
   absent rows remain typed blockers with no computed delta;
7. qdisc and remote processes are proven restored/terminated;
8. the generated Markdown/JSON report cites exact raw artifact digests and
   makes no winner claim unsupported by compatible paired evidence.
