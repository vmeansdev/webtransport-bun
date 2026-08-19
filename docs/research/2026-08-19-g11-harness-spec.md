# G11 harness build spec

Branch: `probe/g11-bidi-01`. Contract:
`docs/research/preregistrations/gate-g11-bidi.md` (registered first, amended
three times pre-dispatch). This document contains **no thresholds** — every one
lives in the registration and is computed by `tools/load/g11-plan.ts` and
`tools/load/g11-classify.ts`, both already written and under test. What is left
is wiring, and this spec exists so the wiring involves no design decisions.

Already on the branch and green:

| file | what it is | tests |
|---|---|---|
| `docs/research/preregistrations/gate-g11-bidi.md` | the contract, committed before any code | — |
| `tools/load/g11-plan.ts` | the scenario arithmetic as functions | 24 |
| `tools/load/g11-classify.ts` | every clause, every falsifier, every roll-up | 47 |
| `tools/load/g11-frame.ts` | the on-stream frame, the deframer, the anchored wall clock | 14 |

Still to build: three processes and one workflow mode.

---

## 1. `crates/reference/src/tunnel_client.rs` → binary `tunnel-client`

The reference generator for Arm T and Arm X. Speaks `wtransport` directly, has
no addon (Amendment 3), and is therefore the cheap generator that keeps the
server's capacity number as untaxed by co-residence as an on-box run allows.

Flags (all required except where noted):

```
--url <https://127.0.0.1:PORT>
--arm tunnel|exchange
--sessions N
--duration-secs S
--connect-stagger-ms M        total ramp, sessions spread evenly across it (K2)
--frame-bytes B               1402 for tunnel, 120 for exchange
--target-bytes-per-sec R      per direction per session; tunnel arm only
--exchanges-per-sec E         exchange arm only
--run-id ID --host NAME       stamped into the summary so V-G2 can refuse it
```

**Frame layout is `tools/load/g11-frame.ts`'s, byte for byte** — u16 total
length, u8 version = 1, u8 class, u32 session, u32 sequence, u64 wall-clock
nanoseconds, all little-endian, filler to length. The Rust stamp is
`SystemTime::now().duration_since(UNIX_EPOCH).as_nanos() as u64`; the JS side
anchors its own clock at a millisecond tick edge (`createWallClock`). A unit
test in the crate must encode a frame and assert the same bytes the TS test
pins, or the two ends can drift silently.

Tunnel arm, per session: connect at its staggered offset, `open_bi()`, then two
tasks on that stream —

- **writer**: cumulative-deadline pacer, verbatim in shape from
  `run_bulk_stream_worker` (`load_client.rs:910`): after the *n*-th frame sleep
  until `written / rate` measured from step start. It cannot overshoot, its
  error does not accumulate, and a flow-control block is absorbed rather than
  repaid — the three properties ticket 27 established and clause C1/V-P rely on.
- **reader**: read into a 4 KiB buffer, deframe, and for each frame record
  `now_ns - frame.send_wall_ns` into a histogram, plus a **negative counter**
  (V-N reads it; on a single host a negative sample is an instrument fault, not
  a number).

At the end of the step: `finish()` the send half, then drain the recv half until
EOF or a fixed grace, then close. Report per session: bytes written, frames
written, bytes read, frames read, and the per-session totals **as a vector**,
because clause C5 is per-session and an aggregate cannot answer it.

Exchange arm, per session: a cumulative-deadline loop at `--exchanges-per-sec`;
each iteration `open_bi()`, write one request frame, `finish()` the send half,
read one response frame, record the RTT client-side, count completion. The
client's own open count is reported and is **never** the accept rate — V-A
compares it against the server's own count and invalidates a mismatch.

Summary on stdout as one JSON object, hand-built in the style of
`load_summary_json` (the crate has no serde). It must carry: per-session vectors
for both directions, the latency histograms (fixed sub-buckets, p99 computed by
the reader not the writer), negative counters, `runId`, `host`, the scheduler-lag
histogram of the client's own loop (this is the V-G floor), and the driving
session count.

## 2. `tools/load/g11-client.ts` — the addon client driver

Arms J and D only. Same frame codec, same pacer shape, but built on
`packages/webtransport`'s client so that a **client-opened** bidi handle exists —
the read-ahead bridge path Amendment 2 is about, and the only place the
chunk-batch diagnostics counter can observe a client end.

Modes:

- `arm=J`: 50 sessions, one bidi stream each, symmetric pacing, exactly Arm T's
  shape with the addon in place of the reference client. Reports
  `streamBatchDiagnosticsSnapshot()` — that snapshot **is** `crossings.client`.
- `arm=D`: 4 sessions, one bidi stream each. `--slow-reader client|server` and
  `--backlog-fraction f`. On `client`, the driver withholds `read()` for
  `consumptionDelayMsForBacklog(backlogTargetBytes(f))` (already in
  `g11-plan.ts`), then drains fully, and repeats — while its writer keeps pacing
  on the same handle and **times every `write()`**. That write-latency
  distribution is `downstreamWriteP99Ms`. On `server`, the driver reads promptly
  and the server withholds instead.

Both modes must call `resetStreamBatchDiagnostics()` at drive start so the
counter's window is the drive window and not the process lifetime.

## 3. `tools/load/bench-g11.ts` — the conductor and server

Reuses `bench-stream.ts`'s machinery rather than restating it: `readHostCpu` /
`hostCpuPct`, `readPidCpuTicks`, `serverRssMb`, `readUdpStats` / `udpDelta`,
`readServerSocketStats`, `settleCounters`, and the artifact/CSV emission. Those
are the instruments G5b's stamp was read through and a second copy of them would
be a second place for them to drift.

Server configuration is §3 of the registration, verbatim — including
`maxStreamsPerSessionBidi` left at the shipped 200, which V-X2 is about, and the
two limiter values, which V-L is about.

Per accepted session:

- take `session.incomingBidirectionalStreams`' reader;
- per accepted bidi stream, start a **reader** (deframe, stamp, per-session
  counters, negative counter) and an **independently paced writer** whose
  virtual clock is offset by `emitterOffsetMs(index, sessions)` — G6's
  spreading lesson on this gate's egress side, so 100 sessions do not fire one
  100-frame impulse per tick;
- for Arm X, answer each request with one response frame and FIN, counting
  accepts **at the server**, with `peakConcurrentBidiPerSession` tracked;
- for Arm D `--slow-reader server`, withhold `read()` on the same schedule the
  client driver uses.

Between drive and counter read: `settleCounters()`. A step that hits
`SETTLE_MAX_MS` is `drain-unsettled`, which is V-D, which is INVALID — not a
number with a caveat.

Artifact: one JSON per cell carrying exactly the `TunnelCellFacts` /
`ExchangeCellFacts` / `CouplingCellFacts` shapes the classifier consumes, plus
the raw fields those were computed from, plus `runId`, candidate SHA, staging
base SHA, and the full environment snapshot (§3). The conductor then calls
`rollUpTunnelGate`, `rollUpExchangeArm` and `readCouplingArm` and prints their
output — it does not compute a verdict of its own.

`crossings.client` is `null` on every Arm T and Arm X cell and a real snapshot
on Arm J and Arm D. The conductor must not substitute a zero.

## 4. Workflow

`.github/workflows/bench-bandwidth.yml`, `mode=g11-bidi`, inputs for
populations, windows, arms and the knob — **no thresholds as inputs**, following
G6's rule. Roughly: `g11_arms`, `g11_ladder`, `g11_step_seconds`,
`g11_repeats`, `g11_exchange_ladder`.

## 5. What must be true before dispatch

1. Ticket 23 landed on staging and the candidate composed onto it (§11, K14).
   The gate cell is knob-off, so the RESET-swallow defect touches only the
   disclosure cell — that is a reason to sequence, not to relax.
2. Base drift checked per §11 against the four source regions named there.
3. A local smoke of every arm, labelled a wiring check and not a result (K16):
   the ledger must close exactly (frames written = frames received, both
   directions), zero negative samples, the settle barrier must quiesce, and
   Arm D's `D-00` control must produce a non-zero write-latency p99 or
   `readCouplingArm` returns INDETERMINATE by design.
4. `bun test tools/load/g11-*.test.ts`, `cargo test -p reference`,
   `cargo clippy -p reference --all-targets`, `bun run typecheck`, and
   `bunx biome check` on every new file, all clean.
5. One dispatch. A miss on a valid run is final (spec §Rerun policy).
