# WebSocket vs WebTransport Scenario Comparison Execution Plan

> **For agentic workers:** execute with
> `superpowers:subagent-driven-development`. Use test-driven development for
> each implementation task, spec review before code-quality review, and
> verification before completion. Do not run a new network integration test on
> loopback.

**Goal:** Implement all ten canonical comparison scenarios once, drive them
through Bun-native WebSocket and existing native WebTransport adapters, and
produce source-bound Mac↔Linux measurements plus honest WT-vs-WS deltas.

**Architecture:** A transport-neutral driver owns workload semantics, payloads,
pacing, sequence ledgers, deadlines, metrics, and evidence. Thin WS and WT
adapters own transport mechanics. A Mac controller stages the exact candidate
on the Linux bench host, starts the Linux server, verifies direct-cable routing,
applies/restores Linux egress netem where required, runs balanced protocol arms,
and emits a fail-closed report.

**Tech stack:** Bun 1.3.14 native WebSocket APIs, webtransport-bun native addon,
TypeScript, Bun test, Node streams, Bun subprocess APIs, SSH/SCP, OpenSSL, Linux
`ip`/`tc`/`ss`, macOS `route`/`ifconfig`, JSON and Markdown evidence.

**Design source:**
`docs/superpowers/specs/2026-08-22-ws-wt-scenario-comparison-design.md`

**Starting source:** `d15658d3c1e0fce8cc7c0fd4b954f8d2fe51673a`

Status: **APPROVAL CANDIDATE — IMPLEMENTATION FORBIDDEN.** Begin Task 1 only
after an architect and a critic independently return unconditional `APPROVED`
for this exact file path, SHA-256 digest, worktree path, and HEAD. Any plan edit
or pre-execution HEAD change invalidates both approvals and requires both
reviews again. Approval records stay outside this file.

---

## RALPLAN-DR decision record

### Principles

1. **Validity before completeness.** A typed missing cell is better than an
   attractive but incompatible delta.
2. **One physical comparison path.** Every new network integration and every
   measured scenario uses Mac `10.99.0.1/en8` ↔ Linux
   `10.99.0.2/eno1`; no loopback fallback exists.
3. **Application-equivalent workloads.** Compare the same application outcome,
   payload, schedule, and connection mapping while allowing transports to
   expose their real semantics.
4. **Admission is not delivery.** Attempted, queued, observed, acknowledged,
   delivered, stale, and missing are separate counters.
5. **Evidence is data, not prose.** Every numeric row binds to source, run,
   topology, scenario, impairment, and raw artifact hashes.
6. **Bounded and reversible.** Every wait, queue, process, SSH command, and
   cleanup has a deadline. Netem and remote processes are restored/terminated
   fail-closed.

### Decision drivers

1. Apples-to-apples confidence across ten different workload shapes.
2. The user-required Mac↔Linux direct-cable topology.
3. Reuse of existing WebTransport behavior without product changes.
4. Native Bun WebSocket fidelity without new dependencies.
5. Enough raw evidence to distinguish sender, JS, server, kernel, and link
   ceilings.
6. A reusable harness rather than ten one-off scripts.

### Options

#### Option A — ten independent WS scripts plus existing WT reports

- Benefit: quickest route to isolated WS numbers.
- Cost: duplicated workload logic; historical WT rows differ in source,
  topology, payloads, semantics, and impairment.
- Decision: rejected because no resulting delta is defensible.

#### Option B — shared scenario engine with WS and WT adapters

- Benefit: equivalence dimensions are centralized and hashed; one correction
  fixes both arms; fresh paired measurements are possible.
- Cost: greater up-front implementation and orchestration work.
- Decision: selected.

#### Option C — protocol-specific harnesses plus a post-hoc normalizer

- Benefit: permits aggressive per-transport tuning.
- Cost: a normalizer cannot recover unrecorded scheduling, queueing, topology,
  or semantic differences; optimization risks benchmarking different apps.
- Decision: rejected for canonical rows. Transport-specific diagnostics may be
  separate, non-comparable appendices.

### ADR

**Decision:** Version one shared scenario registry and wire ledger under
`tools/compare/`; implement Bun-native WS and existing-native WT adapters; run
Linux-server/Mac-client arms through one orchestrator; reject incompatible
artifacts before computing deltas.

**Consequences:** Historical WT figures are not imported. The first campaign
must freshly execute both protocols. WS raw reliability remains visible in
game/loss scenarios; an application-level lossy overlay is an additional
labeled WS arm, never a replacement. Reliable bulk uses a WT uni stream, not
datagrams. Pure unit tests need no network, and all new network tests use the
Linux machine.

**Rejected alternatives:** duplicated scripts and post-hoc normalization, for
the reasons above.

**Revisit trigger:** only a versioned v2 scenario registry or a proven inability
of the existing WT public surface to express a canonical application outcome.
Such a change requires a fresh plan review and cannot be hidden in an adapter.

## Scope boundaries

### In scope

- All ten v1 scenarios and all listed canonical cells.
- Bun-native TLS WebSocket server/client adapter.
- Existing native WebTransport server/client adapter.
- Shared wire envelope, pacing, ledgers, histograms, telemetry, evidence,
  verifier, comparator, CLI, and Markdown report.
- Mac controller and Linux server roles, source staging, TLS provisioning,
  topology proof, sidecars, bench locking, and safe Linux egress netem.
- Fresh execution of every WS and WT arm. A product shortfall is recorded as a
  measured `MISS`; only an external prerequisite may produce `BLOCKED`.

### Out of scope

- Changes to WebTransport product semantics or native Rust implementation.
- Third-party WebSocket, CRDT, histogram, or orchestration dependencies.
- Browser/CDN/proxy reach benchmarking.
- One-way cross-host latency without separately proven clock uncertainty.
- Host-wide kernel/sysctl or hard-limit tuning. A run-scoped child may raise its
  own soft `nofile` limit to the preregistered 65,536 when the recorded hard
  limit permits it; no persistent setting is changed.
- Network impairment on the Tailscale SSH control path or on macOS.

## Hard invariants

- Linux is the server for every scenario and protocol arm.
- Measurement endpoints are exactly `10.99.0.1` and `10.99.0.2` on `en8` and
  `eno1`. SSH may use `home-ubuntu`, but scenario bytes may not use Tailscale.
- One WebSocket connection maps to one WebTransport session.
- Primary WS arms disable per-message compression and pooling.
- Both adapters apply the exact hashed v1 capacity profile: 12,000 sessions,
  512 handshakes in flight, 8 bidi and 8 uni streams/session, 24,000 global
  streams, 1,200-byte datagrams, 512 MiB/2 MiB/256 KiB queue budgets,
  5 s backpressure, 10 s handshake, 60 s idle deadlines, and per-source
  handshake/stream/datagram token buckets of 20,000/s with 20,000 burst
  (`handshakesBurstPerPrefix=20,000`). WT receives these explicit native
  options; WS implements the same admission/queue policy. Runtime defaults are
  forbidden and a limit hit remains a measured `MISS`.
- Both transports use one Linux-generated P-256 CA and its shared CA-signed
  leaf with SAN `IP:10.99.0.2,DNS:wt-compare.local`, trusted by the Mac client;
  private keys never leave Linux and insecure verification is forbidden. The WS
  client must use Bun 1.3.14's installed
  `WebSocketOptions.tls` with `ca`, `serverName`, and
  `rejectUnauthorized: true`; a compile/runtime capability probe gates runs.
- New unit tests are socket-free. New integration and campaign tests never use
  `localhost`, `127.0.0.0/8`, `::1`, or same-host server/client processes.
- Every iterator, socket wait, drain, subprocess, SSH command, warmup, run,
  shutdown, and cleanup is bounded.
- No comparison delta exists unless both artifacts pass compatibility checks.
- `evidenceStatus` (`PASS|FAIL|BLOCKED`) is separate from
  `scenarioVerdict` (`PASS|MISS|NO_VERDICT`). A valid performance miss retains
  its numbers.
- Generated evidence is untracked under
  `.release-evidence/transport-comparison/<candidate>/<campaign-id>/`.
- Every connection-scale server/client role must prove an effective soft
  `nofile` limit of at least 65,536. Planning-session diagnostics observed
  Linux soft/hard 1,024/524,288, Mac shell soft/hard
  1,048,575/unlimited, `kern.maxfilesperproc=245,760`, and Mac ephemeral ports
  49,152–65,535. These are non-promotable feasibility notes; Task 12 must
  recollect and bind them at the exact candidate. The Linux launcher raises
  only its child soft limit before `exec` when the fresh hard limit permits it.
  Mac child limits and port occupancy are recorded; a 10,000-client arm
  requires at least 12,500 free ports on source `10.99.0.1` (5,000 requires
  6,250). No persistent limit/range is changed.
- The registry must contain exactly 35 primary workload cells, producing 35 WS
  primary arms and 35 WT primary arms, plus 12 explicitly labeled WS lossy-game
  overlay arms. Roles, directions, eight-worker Mac sharding for ordinary
  multi-client workloads, the explicit connection-lifecycle process cohorts,
  and the 82-arm total are hashed and verified.

## Scenario classifiers and run policy

The exact v1 configurations are frozen in the design spec. The code registry
serializes them canonically and hashes them. Overrides create diagnostic,
non-canonical rows.

- Short cells: 3 warmups, 15 measured repetitions.
- Long/scale cells: 1 warmup, 5 measured repetitions.
- Each repetition contains enough event samples for its percentiles; run-level
  summaries use sample standard deviation and Student-t 95% confidence
  intervals.
- The seeded arm order is balanced (`WS,WT,WT,WS` blocks with a seeded starting
  arm), and the order is recorded.
- No outlier is removed. Warmup data is stored but excluded from measurement.
- A target rate that is not achieved is a measured `MISS`, not a silently
  reduced offer.
- Tail control passes only when p99 ≤4 ms and at least 99% of scheduled control
  messages receive a valid acknowledgement; otherwise it is `MISS`.
- Reliable scenarios require exact payload/count/digest completion unless their
  capacity classifier explicitly treats overload as the result.
- Latest-state scenarios classify freshness and staleness separately from raw
  delivery.
- WT 0-RTT claims require observed `has0Rtt`, `accepted0Rtt`, and handshake
  confirmation counters; configuration flags alone are not evidence.

## Pre-mortem

| Failure mode | Early signal | Prevention / recovery |
| --- | --- | --- |
| The driver, not the transport, becomes the ceiling. | Mac event-loop delay, scheduler misses, or client CPU saturates before Linux/server/NIC. | Separate process roles, open-loop schedule ledger, achieved-rate counter, pilot capacity check, and classify inconclusive rather than attributing. |
| A run silently uses Tailscale or loopback. | Route/source/interface or server peer differs from the contract. | Preserve raw route output and fail before warmup; verifier repeats the check from artifacts. |
| Netem remains active after interruption. | Post-cleanup qdisc differs from preflight `fq` or controller heartbeat expires. | A Linux supervisor holds `flock`, owns the run PGID, watches a lease, kills/restores on expiry, and emits cleanup proof; the controller independently verifies recovery before any next cell. |
| WS admission is reported as delivery. | Sent count exceeds receiver ledger or server status `-1` is resent. | Separate ledger states; tests freeze Bun send-status semantics and artifact formulas. |
| Historical or mismatched WT data enters a delta. | Source/scenario/host/impairment hashes differ. | Comparator negative controls and typed blocked rows; never accept manual numeric inputs. |
| TLS setup distorts or weakens the comparison. | Different cert/SNI, insecure mode, compression, or cached state. | Generate once on Linux, reuse exact files, record fingerprint/settings, explicit cold/warm process policy. |
| Connection scale exceeds host limits before transport limits. | Preflight FD/port/sysctl capacity below required headroom or child soft limit not 65,536. | Raise only the child soft limit within the recorded hard cap; otherwise record `BLOCKED`. Close and prove recovery before the next arm. |
| Remote processes or output pipes leak. | PID remains, pending socket count nonzero, or SSH drain times out. | Run-scoped PID files, process-group ownership, bounded drains, exact PID validation, and cleanup gate before next arm. |
| TCP loss plus large frames causes a false app comparison. | WS queue/backpressure and WT stream settings differ from manifest. | Same application chunks and offered schedule, explicit queue metrics, same netem profile, no hidden compression/pooling. |
| Long campaign drifts thermally or by background load. | Host sidecars cross preregistered load/thermal bounds or paired blocks trend. | Preflight quiet window, interleaved arms, per-repetition sidecars, retain but mark contaminated blocks `NO_VERDICT`. |

---

## Task 1: Freeze types, canonicalization, and the scenario registry

**Files**

- Create: `tools/compare/types.ts`
- Create: `tools/compare/canonical.ts`
- Create: `tools/compare/scenario-registry.ts`
- Create: `tools/compare/scenario-registry.test.ts`

**Steps**

1. Write failing tests for all ten IDs, all 35 primary cells, the 35+35 primary
   transport arms, 12 WS overlay arms, exact role/direction/eight-worker shard
   assignments for ordinary workloads, the fresh-process cold and 100-process
   warm connection-lifecycle cohorts, exact frozen parameters, the complete
   capacity/admission profile and 500/s setup ramp with 200 connects in flight,
   stable key ordering, SHA-256 scenario hashes, override non-canonical
   marking, and invalid/unknown fields.
2. Run `bun test tools/compare/scenario-registry.test.ts`; confirm RED because
   the modules do not exist or expectations fail.
3. Implement minimal discriminated types, canonical JSON serialization, and
   the frozen registry. Keep environment parsing out of these pure modules.
4. Re-run the focused test and `bunx tsc --noEmit`.
5. Commit one scoped change using Lore trailers.

**Commit intent:** `Freeze comparison scenarios so both transports run one workload`

## Task 2: Build the wire envelope, bounded queues, pacing, and statistics

**Files**

- Create: `tools/compare/wire.ts`
- Create: `tools/compare/bounded-queue.ts`
- Create: `tools/compare/pacer.ts`
- Create: `tools/compare/stats.ts`
- Create: `tools/compare/driver-core.test.ts`

**Steps**

1. Write failing property/table tests for binary encode/decode, byte-view
   offsets, sequence/run/session identity, expiry, malformed input, queue byte
   caps, high/low watermarks, fake-clock open-loop pacing, warmup reset,
   percentile ordering, finite samples, and Student-t CI summaries.
2. Run the focused test and retain the RED output.
3. Implement the smallest pure core. Use existing deadline/statistical patterns
   where behavior matches; do not add a package.
4. Re-run focused tests, bounded-wait checker, and typecheck.
5. Commit.

**Commit intent:** `Add a shared message ledger so transport counters stay comparable`

## Task 3: Add the fail-closed run artifact and comparator

**Files**

- Create: `tools/compare/evidence.ts`
- Create: `tools/compare/verify-artifact.ts`
- Create: `tools/compare/compare.ts`
- Create: `tools/compare/evidence.test.ts`
- Create: `tools/compare/fixtures/valid-ws-run.json`
- Create: `tools/compare/fixtures/valid-wt-run.json`

**Steps**

1. Write failing tests for valid compatible inputs and every mandatory negative
   control: source/digest/run mutation, artifact-byte mutation, loopback,
   missing Linux, same host, wrong interface/address, missing peer proof,
   scenario/payload/TLS/compression/impairment mismatch, missing or unequal
   capacity-profile hash/normalized submitted values/admission counters,
   missing Mac FD/port
   proof, smoke input, invalid units/samples/percentiles, and stale WT beside
   valid WS.
2. Assert stable rejection reasons and that no delta/ranking is computed for an
   incompatible or missing arm.
3. Run the focused test and preserve RED.
4. Implement schema validation, artifact hashing, compatibility checks,
   `evidenceStatus`, `scenarioVerdict`, and delta calculation.
5. Re-run focused tests, typecheck, and `git diff --check`; commit.

**Commit intent:** `Reject incompatible evidence so stale numbers cannot become deltas`

## Task 4: Implement the Bun-native WebSocket adapter

**Files**

- Create: `tools/compare/adapters/transport.ts`
- Create: `tools/compare/adapters/ws.ts`
- Create: `tools/compare/adapters/ws.test.ts`

**Steps**

1. Build fakes around the adapter seam and write failing tests for exact
   binary/text payloads, bounded receive queues, client bufferedAmount
   high/low-water waits, timeout, server send status `0/-1/positive`, drain,
   close/error races, explicit compression-off/canonical capacity limits,
   matching session/handshake/token-bucket admission and counters, custom-CA TLS
   options/SNI/rejection, role-aware server accept, virtual uni/bidi channel
   creation/acceptance over one socket, direction, and cleanup.
2. Run the focused test and confirm RED.
3. Implement Linux `Bun.serve` and Mac global `WebSocket` roles behind the
   interface. Use the installed Bun 1.3.14 `WebSocketOptions.tls` surface; do
   not open a real local socket in unit tests.
4. Assert attempted/queued/server-observed/acknowledged/delivered metrics remain
   separate. Never resend a `-1` server result.
5. Re-run the focused test, typecheck, and bounded-wait checker; commit.

**Commit intent:** `Add Bun-native WebSocket transport so scenarios need no third-party stack`

## Task 5: Implement the existing-native WebTransport adapter

**Files**

- Create: `tools/compare/adapters/wt.ts`
- Create: `tools/compare/adapters/wt.test.ts`

**Steps**

1. Write failing fake-backed tests for client connect and server accept,
   session mapping, explicit datagram/reliable-message selection, both-side
   uni/bidi create/accept lifecycle, server-opened AI/bulk uni channels, Node
   stream backpressure, close/reset/timeout mapping, and 0-RTT truth-counter
   propagation. Assert every canonical capacity/rate-limit value is serialized
   canonically and passed explicitly to the public native server options seam;
   record those submitted bytes and their hash in artifacts. WT metrics expose
   behavioral counters but no runtime applied-config echo, so do not fabricate
   or label one.
2. Run RED.
3. Implement only with public root package APIs. Do not modify package/native
   product code. If a canonical workload cannot be expressed, stop this task
   and escalate to the leader rather than inventing a hidden semantic change.
4. Re-run focused tests, existing public-surface tests relevant to used APIs,
   typecheck, and bounded-wait checker; commit.

**Commit intent:** `Adapt existing WebTransport primitives so paired runs share one driver`

## Task 6: Implement topology, TLS, remote lifecycle, and netem controls

**Files**

- Create: `tools/compare/topology.ts`
- Create: `tools/compare/tls.ts`
- Create: `tools/compare/remote.ts`
- Create: `tools/compare/remote-supervisor.ts`
- Create: `tools/compare/netem.ts`
- Create: `tools/compare/host-sidecar.ts`
- Create: `tools/compare/orchestration.test.ts`
- Create: `tools/compare/fixtures/{mac-route,linux-route,linux-qdisc}.txt`

**Steps**

1. Write failing fixture tests for macOS `route -n get`, Linux
   `ip route get`, address/interface/MTU, raw-output preservation, expected peer,
   Bun/OS/arch checks, Mac/Linux soft/hard FD parsing, effective child-limit
   verification, Mac ephemeral-range and occupied-port headroom calculation,
   stale/malformed PID/PGID refusal, command deadlines,
   custom-CA WebSocket option capability, TLS SAN and fingerprint identity,
   qdisc precondition, install verification, lease heartbeat/expiry, `flock`
   ownership, controller-loss recovery, and exact `fq` restoration.
2. Include regression input for the historical route parser failure where
   `dev eno1 src 10.99.0.2` was reported as unknown.
3. Run RED, then implement bounded Bun subprocess/SSH helpers and a Linux
   supervisor that owns the exact server PGID while holding
   `/tmp/bench.lock`. Keep command arguments structured; no broad shell cleanup
   or `pkill`.
4. Generate the cert/key once in the Linux run directory. Return only the
   public cert/fingerprint to Mac and use strict CA/SNI verification.
5. Netem mutates only Linux `eno1`, only while the supervisor holds `flock`, and
   only when the original root qdisc is the expected `fq`. A controller
   heartbeat lease causes the supervisor to kill the owned PGID, restore `fq`,
   write cleanup status, and unlock on expiry. Lack of preconditions is
   `BLOCKED`; post-execution restoration failure is `FAIL/NO_VERDICT` and halts
   the campaign.
6. Re-run focused tests/typecheck/static checks; commit.

**Commit intent:** `Enforce the physical Linux path so loopback evidence fails closed`

## Task 7: Implement fan-out, ticker, game-loss, and tail workloads

**Files**

- Create: `tools/compare/scenarios/fanout.ts`
- Create: `tools/compare/scenarios/ticker.ts`
- Create: `tools/compare/scenarios/game.ts`
- Create: `tools/compare/scenarios/tail.ts`
- Create: `tools/compare/scenarios/message-scenarios.test.ts`

**Steps**

1. Write failing pure-driver tests for publisher/subscriber barriers, exact fan
   counts, 1:100 expansion, open-loop offered rates, per-receiver unique
   ledgers, raw WS reliability, labeled WS expiry overlay, WT datagram expiry,
   latest-state age, reliable control acknowledgements, and cross-traffic
   isolation.
2. Test overload accounting: 100k×100 remains the offered workload even when
   delivery misses; no adaptive downshift is permitted.
3. Run RED, implement minimal scenario state machines, then run GREEN.
4. Run typecheck and bounded-wait checks; commit.

**Commit intent:** `Add realtime fanout scenarios so freshness and delivery are measurable`

## Task 8: Implement reconnect, handshake, and connection-memory workloads

**Files**

- Create: `tools/compare/scenarios/connections.ts`
- Create: `tools/compare/scenarios/connections.test.ts`

**Steps**

1. Write failing tests for 100×10 cycle accounting, concurrency barriers,
   connect-to-first-ack timing, a fresh child/cache for every cold connection,
   and a fresh 100-process one-client cohort for every warm repetition. Freeze
   per-worker priming before the measured barrier, ten sequential reconnects
   per warm worker in synchronized 100-client waves, one measured handshake
   per warm worker, identical WS/WT process topology, explicit WT ticket
   priming/resumption counters, the native eight-ticket-per-identity limit,
   stable server/cert/SNI, `enable0Rtt` on both endpoints,
   `allowEarlySession`, idempotent run/client/cycle dedup, ticket replenishment
   across ten cycles, 1k/5k/10k exact live-set barriers, 65,536 effective child
   `nofile`, hold interval, per-connection memory formulas, and cleanup recovery.
2. Ensure WS never receives a synthetic `0-RTT` label and WT configuration
   without observed resumption is `MISS`/`NO_VERDICT` as preregistered.
3. Run RED, implement, run GREEN, typecheck, bounded-wait check; commit.

**Commit intent:** `Add connection lifecycle scenarios so handshake and memory costs are paired`

## Task 9: Implement CRDT, AI-token, and bulk workloads

**Files**

- Create: `tools/compare/scenarios/crdt.ts`
- Create: `tools/compare/scenarios/ai-token.ts`
- Create: `tools/compare/scenarios/bulk.ts`
- Create: `tools/compare/scenarios/stream-scenarios.test.ts`

**Steps**

1. Write failing tests for deterministic actor/clock operation encoding,
   duplicate/out-of-order tolerant convergence, canonical snapshot hashes,
   token chunk ladders, scheduled pauses, bounded client work queue,
   inter-chunk gaps, exactly 100 MiB, 64 KiB chunking including final-boundary
   logic, and end-to-end digest verification.
2. Keep the CRDT synthetic and label it `Yjs-style`; do not add Yjs.
3. Map reliable outcomes to one persistent WS channel and persistent WT
   streams. Bulk primary WT arm is one uni stream only.
4. Run RED, implement, run GREEN, typecheck, bounded-wait check; commit.

**Commit intent:** `Add reliable application scenarios so stream behavior has direct controls`

## Task 10: Add role CLIs, campaign orchestration, and reports

**Files**

- Create: `tools/compare/server.ts`
- Create: `tools/compare/client.ts`
- Create: `tools/compare/run-campaign.ts`
- Create: `tools/compare/render-report.ts`
- Create: `tools/compare/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/TESTPLAN.md`
- Create: `docs/TRANSPORT_COMPARISON.md`

**Steps**

1. Write failing tests for strict CLI parsing, unknown arguments, scenario/cell
   selection, ready handshake, source/campaign/run identity, canonical versus
   diagnostic output, output paths, signal handling, server pending-session
   drain, sidecar merge, Markdown escaping, typed blocked cells, and delta
   suppression.
2. Run RED.
3. Implement `compare:server`, `compare:client`, `compare:run`,
   `compare:verify`, and `compare:report` scripts. Defaults must be canonical;
   no default may point at loopback.
4. Document exact two-host usage, safety, artifact layout, metric meanings,
   scenario registry, and the independent corrections to historical evidence.
5. Run focused tests, typecheck, bounded-wait/static checks, and CLI `--help`;
   commit.

**Commit intent:** `Expose one comparison campaign so every result retains its provenance`

## Task 11: Local verification and independent code review

**Files:** no intended source changes unless fixing findings.

**Steps**

1. Run all `tools/compare/**/*.test.ts`, `bun run typecheck`,
   `bun scripts/check-bounded-waits.ts`, formatting/lint/static gates used by
   `scripts/test_ci_local.sh`, and `git diff --check`.
2. Do not run a new loopback network smoke. Use fakes/pure tests only here.
3. Preserve the initial-checkout evidence for the two known package TLS
   failures as pre-existing exceptions; do not re-run those loopback network
   tests. The new strict TLS behavior is verified only by the Mac↔Linux probes
   in Tasks 12–13.
4. Dispatch a fresh spec-compliance reviewer against the design and this plan.
5. If compliant, dispatch a fresh code-quality reviewer. Fix all findings with
   TDD and re-run both reviews. Commit each behavioral fix separately.
6. Confirm clean status and exact HEAD. Create one source archive and SHA-256
   only after reviews are green. The later Mac and Linux roles must both launch
   from extractions of these exact bytes, never from the development worktree
   or a pre-existing remote checkout.

## Task 12: Stage and preflight the exact candidate on both hosts

**Files:** generated evidence only.

**Steps**

1. Confirm local clean tree, full HEAD, source archive digest, Bun 1.3.14,
   direct Mac route/source/interface, quiet-host thresholds, and no competing
   campaign. Record Mac soft/hard `RLIMIT_NOFILE`,
   `kern.maxfilesperproc`, `kern.maxfiles`, the configured ephemeral range,
   and occupied ports for source `10.99.0.1`. Verify each staged child sees an
   effective limit of at least 65,536 and that the 5k/10k arms have 25% port
   headroom (6,250/12,500 free); otherwise emit `BLOCKED` without persistent
   tuning.
2. Extract the exact archive into a unique ignored Mac run directory; create a
   unique non-destructive Linux run directory, transfer the same archive, and
   verify SHA-256 on both hosts. Acquire Linux `/tmp/bench.lock` through the
   remote supervisor.
3. Record Linux hostname/OS/arch/CPU/Bun/Rust/OpenSSL, soft/hard `nofile`, ephemeral
   port range, route/address/MTU/qdisc, process inventory, load/governor, NIC and
   protocol counters. Raise only the run-scoped child soft `nofile` to 65,536
   before `exec` when the recorded hard limit permits it; verify the effective
   value and do not change persistent host settings.
4. Install from the frozen lockfile and build the platform-native addon in both
   staged directories. Hash the JS role entrypoints and Darwin/Linux addon
   binaries; record Bun/Rust/toolchain paths. A download/build failure is
   recovered in scope; if it remains external, emit `BLOCKED` with logs.
5. Generate the shared SAN certificate on Linux. Compile and run a Bun
   WebSocket custom-CA capability probe using
   `tls:{ca,serverName:"wt-compare.local",rejectUnauthorized:true}`. Start each
   server role on `10.99.0.2`, run a Mac→Linux strict-TLS non-measured probe for
   WS and WT from the staged Mac directory, verify Linux sees peer
   `10.99.0.1`, then shut down and prove no remaining sessions/sockets/processes.
6. Run `bun test tools/compare/*.test.ts tools/compare/scenarios/*.test.ts` on
   Linux as a pure test gate. No Linux-local loopback scenario is run.

## Task 13: Run the bounded two-host integration matrix

**Files:** generated evidence only.

**Steps**

1. Execute one short diagnostic cell per workload family over the direct cable
   for both adapters: reliable message, latest-state datagram, lifecycle, and
   reliable stream.
2. Exercise strict TLS rejection, wrong peer/interface rejection, server crash,
   SSH interruption, controller heartbeat expiry, client deadline, and cleanup.
   Prove the independent remote supervisor kills only the owned PGID, restores
   `fq`, writes cleanup status, and releases `flock`. Negative controls must be
   non-promotable and may not disturb the bench host afterward.
3. Exercise one netem diagnostic profile, verify counters, restore `fq`, and
   compare pre/post qdisc exactly.
4. Run the artifact verifier on every diagnostic. Fix code defects through TDD
   and repeat until all valid diagnostics pass and all negative controls fail
   for the expected reason.
5. Dispatch spec and code-quality reviewers for any fixes; commit scoped changes
   and restage the new exact HEAD before campaign measurement.

## Task 14: Execute the interleaved canonical WS/WT campaign

**Files:** generated evidence only.

**Steps**

1. Freeze campaign ID, final candidate/source digests, scenario-registry hash,
   seed, host identities, and balanced arm order.
2. For each of the 35 primary workload cells, run WS and WT inside the frozen
   balanced `WS,WT,WT,WS` block order before advancing to another cell. This
   interleaving is mandatory; do not run one transport's campaign first. Run
   the 12 labeled WS lossy-game overlays adjacent to their matching game blocks.
   The Linux server is active in every arm. No arm may fall back to loopback or
   a local server.
3. Before and after each cell, capture host/process/NIC/qdisc sidecars and
   cleanup proof. Abort subsequent cells on route drift, qdisc restoration
   failure, stale processes, or source mismatch.
4. Preserve numeric results for valid misses. For an external blocker, exhaust
   safe in-scope recovery, then emit a typed `BLOCKED` artifact with raw logs.
5. Verify every raw WS, WT, overlay, and paired-block artifact before
   proceeding. Preserve valid WS data even if its adjacent WT arm becomes
   externally blocked, but compute no delta for that pair.

## Task 15: Validate compatibility, run negative controls, and render results

**Files:** generated evidence only.

**Steps**

1. Assert that all 35 WS and all 35 WT primary arms were attempted inside their
   paired blocks, that all 12 WS overlays are present, and that source archive,
   scenario hash, certificate, topology, impairment, seed, capacity-profile
   hash and exact normalized submitted values/hash, admission-counter schema,
   Mac/Linux FD/port proof,
   roles/directions/shards, and block order match.
2. Assert actual WT primitive/resumption state in each artifact. Do not infer
   it from configuration.
3. Preserve product failures/capacity misses as valid measured outcomes when
   the harness/evidence passes. Only external pre-execution non-execution is
   `BLOCKED`; restoration/evidence failure is `FAIL/NO_VERDICT`.
4. Run all compatibility negative controls against copies of the final
   artifacts; originals remain immutable.
5. Generate JSON and Markdown tables. Compute absolute/relative deltas only for
   compatible measured pairs and include confidence intervals plus raw run
   references. Use no historical figure in the canonical table.

## Task 16: Final verification, adversarial review, and handoff

**Files:** generated report and any explicitly required documentation fixes.

**Steps**

1. Re-run pure/unit/static/typecheck gates at final HEAD on Mac and pure tests on
   Linux. Re-run focused network probes over the cable if campaign fixes changed
   adapter/orchestrator behavior.
2. Run `compare:verify` over the complete campaign and every negative control.
3. Verify clean source, exact candidate/source digests, all ten scenario IDs,
   expected cell counts, both transport attempts, raw artifact hashes, qdisc
   restoration, zero retained remote processes, and released bench lock.
4. Dispatch a fresh comprehensive code review and a separate evidence verifier.
   Fix all findings, restage, and rerun affected measurements whenever source
   changes. A code change invalidates measurements from the prior HEAD.
5. Run the verification-before-completion checklist. Mark the durable goal
   complete only when no required work remains.
6. Hand off changed files, scoped commits, exact commands/results, the final
   comparison table, evidence paths/digests, known pre-existing TLS baseline
   failures, and honest remaining risks/blockers.

---

## Required review cadence during execution

For Tasks 1–10, use one fresh Luna-max implementer at a time because the tasks
share the scenario contract. After each implementation:

1. a fresh Luna-max spec reviewer checks only compliance with this plan/design;
2. after spec approval, a fresh code-quality reviewer checks correctness,
   boundedness, security, maintainability, and tests;
3. the implementer fixes findings, reviewers re-check, and only then does the
   leader start the next task.

Independent read-only verification/research lanes may run in parallel. Agents
must know they share the worktree, own only their assigned files/task, preserve
others' edits, and never rewrite the plan.

## Completion gates

- [ ] Exact plan digest and starting HEAD received unconditional architect and
      critic `APPROVED`.
- [ ] Durable goal created only after that approval.
- [ ] Ten frozen scenario definitions and both adapters implemented.
- [ ] Both adapters record the identical hashed capacity/admission profile and
      exact normalized submission, and compatibility checks reject every
      registry/submission mismatch without claiming a WT runtime applied echo.
- [ ] No new dependency and no WebTransport product-code change.
- [ ] All pure/unit/negative-control/static/typecheck gates pass.
- [ ] All new network integration and campaign traffic used the Linux server
      over `10.99.0.1/en8` ↔ `10.99.0.2/eno1`.
- [ ] Mac and Linux effective child FD limits and Mac ephemeral-port headroom
      passed for every applicable connection-scale arm.
- [ ] Every WS and WT canonical cell was attempted and has valid numeric
      evidence or a typed external `BLOCKED` artifact.
- [ ] Deltas exist only for compatible measured pairs.
- [ ] Final candidate/source, topology, TLS, impairment, raw artifacts, and
      reports are digest-bound.
- [ ] Linux qdisc restored, remote processes gone, sockets drained, and bench
      lock released.
- [ ] Fresh code/evidence reviewers approve final HEAD; any post-measurement
      source change triggered affected reruns.
