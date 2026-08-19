# Load & Soak Tests

## Purpose
Verify that the WebTransport server handles sustained load without:
- Memory leaks (bounded buffers must hold)
- Task leaks (all Tokio tasks join on shutdown)
- Performance degradation over time

## Tests

### Short load test (CI)
- Duration: 20 seconds
- Concurrent sessions: 20 (staggered)
- Datagrams: 50/s, streams: 2/s per session
- **Pass criteria**: no errors, server RSS within 2× initial (when measurable)

### Local soak diagnostic (`soak.ts`)
- Duration: 30 minutes
- Concurrent sessions: 500
- Datagrams: 500/s, streams: 5/s
- **Pass criteria**: no errors
- **Status**: legacy local diagnostic. It emits no hash-chained artifact, binds
  to no candidate commit, and no gate consumes its result. Use it to reproduce a
  local regression; hosted campaigns run through `soak-addon.ts` instead.

## Running

From repo root:

```bash
# Short load test (starts reference server, runs load-client)
bun run test:load

# Legacy local soak diagnostic (release build, 30 min)
bun run test:soak

# Addon soak (P2.2): 2min default, or 1h/2h/24h/72h
SOAK_DURATION=120 bun run test:soak-addon
bun run test:soak-addon:1h    # 1h, trend gate + artifacts
bun run test:soak-addon:24h   # 24h (local)
bun run test:soak-addon:72h   # 72h (local)
```

Or directly:

```bash
bun tools/load/load.ts
bun tools/load/soak.ts
SOAK_DURATION=3600 bun tools/load/soak-addon.ts
```

**P2.2 long soak**: For the hosted 1h, 2h, 24h, and 72h modes, use the GitHub
Actions `soak-long` workflow (workflow_dispatch). Writes
`tools/load/soak-artifacts-seg-*.json` and `.csv`; trend-based leak gate when
duration >= 3600s (RSS, FD, sessionTasks, streamTasks).

## H7 hosted closure lane

The 2-hour hosted mode is the only path that produces H7 batched-delivery
evidence. Dispatch `soak-long` from the immutable tag
`refs/tags/h7-batch-delivery-<candidate-sha>` with duration_hours=2,
runner_type=self-hosted, runner_mode=dedicated, segment_index=1,
segment_count=1, datagram_batch=64, rss_ceiling_mb=1750,
committed_abort_mb=2200, and heap_debug=0. `scripts/validate-soak-inputs.sh`
pins that tuple and refuses anything else dispatched from an H7 tag. The run's
display title is `soak-long-<campaign_seed>`; locate it by that title plus the
candidate SHA and download its artifacts by the immutable run ID.

The load is fixed rather than derived from the runner: runner_profile=h7-fixed-large,
sessions=500, datagrams_per_sec=500, streams_per_sec=5. The runner must provide
at least 5 CPUs and 8 GiB of memory; an under-capacity runner
fails closed rather than downscaling, since a smaller load would answer a
question nobody asked. The
dispatched ceiling may only tighten the harness default `max(1024, sessions * 3.5)`,
which is exactly 1750 at 500 sessions.

Accept the campaign with the fail-closed verifier, not the workflow's green
check:

```bash
bun tools/load/soak-addon.ts verify-h7-hosted \
  .release-evidence/soak-aggregate-2h.json \
  soak-artifacts-seg-01-of-01.json \
  --sha <candidate-sha> --batch 64 --rss-ceil-mb 1750 \
  --duration-seconds 7200 --seed <campaign_seed> \
  --continuity-token <token> \
  --workflow-ref refs/tags/h7-batch-delivery-<candidate-sha>
```

This lane supplements the release soak policy in `docs/RELEASE_CHECKLIST.md`; it
does not replace the 24h/72h release soak.

## Components

- **load-client** — Rust binary in `crates/reference` that connects to a WebTransport server and generates datagram + stream load. Built with `cargo build -p reference --bins`.
- **load.ts** — Orchestrates reference server + load-client, checks RSS growth.
- **soak.ts** — Same, with 30 min duration and 500 sessions (release build). Legacy local diagnostic; hosted campaigns use `soak-addon.ts`.

## Latency axis

`bench-latency.ts` measures *when* a datagram arrives, which every other tool
here ignores. It runs one arm per process — the datagram batch knob is read once
at import, so it cannot be varied inside a process — and the arms are merged and
judged by `latency-classify.ts`. Method, classifier buckets and STOP conditions
are pre-registered in `docs/research/preregistrations/latency.md`; the classifier
is a transcription of that document, not a place to decide anything.

Reusable pieces, kept separate on purpose so another axis can reverse the
direction of measurement without touching the driver:

- `latency-clock.ts` — `CLOCK_MONOTONIC` from Bun via `bun:ffi`, the same
  counter `crates/reference/src/latency_probe.rs` reads from Rust. Shared epoch,
  so a one-way number across the two processes is real.
- `latency-stamp.ts` — the 36-byte payload header (intended send, actual send,
  sequence, and the server's echo send instant) both ends agree on. Version-1
  28-byte stamps still decode, with no echo instant.
- `latency-histogram.ts` — log-linear histogram, bucketing identical to the Rust
  side so client and server percentiles are the same arithmetic.

The load client grows three flags for this: `--latency-stamp`, `--arrival
uniform|tick` and `--tick-hz`. All three are off by default and no existing
caller's arrival shape changes.

Reading the output: rungs are labelled by the **effective** rate the generator
produced, not the requested one — the tick arm rounds its per-tick burst, so a
requested 100/s/session at 64 Hz is really 128. The requested rate rides along on
every row. Each step is snapshotted *after* its drain grace, so the datagrams
that queued longest are in it, and the console line and the artifact come from
that one snapshot.

In CI: `bench-bandwidth` with `latency_probe=true`.

### Interleaved H7 A/B

The ladder above runs each arm as one long process, which gives one paired
observation per rate and no dispersion at all. `latency-ab-conduct.ts` runs the
same two arms as **86 short alternating processes in one dispatch** — 4 rungs
(10k/15k/20k/25k aggregate) × 10 pairs × 2 arms, plus 3 floor pairs at 1,000/s —
so the two arms of a comparison are ~64 s apart instead of half an hour apart and
there are ten replicates to put an interval on.

- `latency-ab-schedule.ts` — the dispatch order, as a pure tested function. It is
  a registered rule: pairs are adjacent, and odd/even replicates alternate which
  arm leads (ABBA) so residual drift cancels rather than favouring one arm.
- `latency-ab-classify.ts` — medians with distribution-free order-statistic
  intervals, the pinned floor rule, the generator-honesty precondition at 15k, and
  the registered ingest-vs-egress cross-check.

The cross-check is why the stamp grew a field. The server writes its own echo
send instant into the payload, which splits the client's round trip into
`ingest + turnaround + egress` — three legs that sum to it exactly, per datagram.
The H7 batch wait lives in `ingest` and nowhere else, so the `batch0` arm
subtracts it with the egress leg held fixed. That is the whole isolation, and it
needs no second harness.

Pre-registered in `docs/research/preregistrations/latency-ab.md`, which fixes the
rungs, the replicate count, the order, the floor rule, the honesty conditions, the
interval estimator and the four readings the cross-check is allowed to produce —
all before the run.

In CI: `bench-bandwidth` with `latency_ab=true`. Locally, `LATENCY_AB_LIMIT=n`
runs the first *n* cells as a smoke; local numbers are never results.

### Off-box RTT dispatch (G2's conversion)

The A/B could not evaluate G2's 15,000/s rung: a generator sharing four vCPU with
the server failed the registered schedule-lag check in every cell. The fix is a
rig change, not a knob — the generator moves to a sibling VM, and the gated
quantity becomes one the move leaves intact.

`latency-rtt-conduct.ts` runs 22 short cells over ssh; `bench-latency.ts` gains
an off-box mode (`LATENCY_OFFBOX_SSH`, `LATENCY_OFFBOX_URL_HOST`) that dials the
LAN address instead of loopback.

- `latency-rtt-schedule.ts` — the 22 cells and their order, as a pure tested
  function. Cell 0 is an off-box floor arm and doubles as the reachability
  pre-flight: no sessions there aborts the dispatch.
- `latency-rtt-classify.ts` — the verdict. Off-box integrity marks, the
  censoring correction that stops loss from buying a better tail, kernel-drop
  loss attribution, the loadgen's own floor, and the registered decision table.

Two things the off-box mode does *not* do, on purpose: it records **no**
cross-host interval (the two ends read different `CLOCK_MONOTONIC` counters, so
ingest, egress and upstream-plus-turnaround ship empty and the classifier asserts
they are), and it never subtracts a floor — the only correction defined moves the
figure up.

Pre-registered in `docs/research/preregistrations/gate-g2-offbox-rtt.md`.
Power-on and host-RAM runbook: `docs/research/runbooks/2026-08-19-offbox-loadgen.md`.
In CI: `bench-bandwidth` with `latency_rtt=true`.

## Production gates (10.2)

The load harness enforces:
- **No panics** — hard gate: any panic in load-client stderr fails the test.
- **No errors** — load-client must report zero session/datagram/stream errors.
- **No hangs** — global timeout; load-client join bounded.
- **Bounded memory** — server RSS growth must stay within 2× initial (short load) or 1.5× (soak).

Run from repo root so `CARGO_TARGET_DIR` and paths resolve correctly.

## Known limitations

The load-client uses wtransport; under heavy concurrent connect/close, wtransport may panic with
"QUIC connection is still alive on close-cast". If load tests fail with this, try fewer sessions
or lower rates. The interop tests (Chromium ↔ reference server) remain the primary validation.
