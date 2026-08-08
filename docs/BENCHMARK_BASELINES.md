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
- **Status today**: `blocked`
- **Reason**: the 2026-07-22 local baseline attempt (`bun run build:native && bun run bench:baseline`) failed because the local native build path resolved to `rustc 1.85.0`, while the current dependency graph requires `rustc 1.88+`.
- **Rule**: do not populate thresholds by hand. Only promote this file to
  `status: "approved"` from a successful release-candidate capture on the exact
  machine/runtime you want to gate.
- **Provenance contract**: an approved file must declare
  `candidateRelationship: "exact"` and the full candidate Git SHA, machine
  identity, Bun version, and Rust version. `bench:regress` rejects stale SHAs,
  another machine, or runtime drift before accepting the comparison. Set
  `BENCH_MACHINE_IDENTITY` to a stable runner identity when the host name is not
  the intended machine contract.

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
