# Benchmark baselines

Task 14 replaces the old single-threshold benchmark gate with an approved
measured-baseline artifact. `bun run bench:regress` now:

- warms up and repeats the handshake, stream, and datagram benchmarks;
- records sample means plus Student-t 95% confidence intervals;
- compares those intervals against `tools/bench/approved-baselines.json`;
- writes the observed run under `.release-evidence/bench/bench-regress-artifact.json`;
- fails explicitly when no approved measured baseline exists or any required
  sample is missing, non-finite, or outside its semantic domain.

## Approved baseline artifact

- **Path**: `tools/bench/approved-baselines.json`
- **Current status**: read the canonical file; `blocked` means no governed hosted
  measurement has been promoted, while `approved` must satisfy every contract
  below.
- **Rule**: do not populate thresholds by hand. Only promote this file to
  `status: "approved"` through `bun run bench:capture` from a successful
  release-candidate capture on the exact machine/runtime you want to gate.
- **Capture contract**: the command requires a clean worktree plus explicit
  `BENCH_MACHINE_IDENTITY` and `BENCH_BASELINE_APPROVER` bindings, runs the fixed
  3-warmup/15-round design, writes an immutable capture JSON, hashes its exact
  bytes, and atomically derives `approved-baselines.json` from those samples.
  It never invents or accepts hand-written metric thresholds.
- **Hosted approval**: checked-in release baselines come only from the manually
  dispatched `bench-baseline-capture.yml` workflow. The workflow authenticates
  the approver input against `github.actor`, checks out full history, and uses
  stable machine identity `github-actions-ubuntu-latest-x64`. Local captures are
  diagnostic and cannot approve the hosted release runner's baseline.

## Candidate binding

An external baseline file measured at the exact candidate SHA may use
`candidateRelationship: "exact"`. A baseline checked into this repository must
live in an evidence-only child commit, so it uses
`candidateRelationship: "ancestry"`: `baseline.commit` is the capture JSON's
measured source SHA, and the comparator requires that SHA to occur on the
candidate's actual first-parent chain no more than eight commits behind it.
A commit that is merely reachable through a merged side branch is rejected.
Any source or workflow edit after capture invalidates the evidence and requires
a fresh hosted capture.

Both relationships also bind the machine identity, Bun version, Rust version,
toolchain hash, capture path, and SHA-256 of the capture bytes. `bench:regress`
rejects source, runner, runtime, toolchain, or artifact drift before comparing
measurements.

## Captured metrics

- `handshake-p50-ms`
- `handshake-p95-ms`
- `handshake-p99-ms`
- `close-latency-p99-ms`
- `stream-throughput-mbps`
- `datagram-throughput-dgrams-per-sec`
- `datagram-loss-ratio`
- `event-loop-delay-p99-ms`
- `cpu-user-ms`
- `peak-rss-mib`

Handshake latency and close-latency come from the native in-process handshake
benchmark. Datagram throughput, loss ratio, event-loop delay, CPU user time,
and peak RSS come from the in-process datagram benchmark so the gate records
real observed values instead of fabricated placeholders. Each metric stores
repeated samples and an approved confidence interval so the gate can reject
statistically significant regressions instead of single-run noise.
Loss ratios must be within `[0, 1]`; throughput, CPU, and RSS must be positive;
latencies must be non-negative; and handshake percentiles must remain ordered.
These checks happen before JSON serialization so `NaN` cannot silently become
`null` evidence.
