# Benchmark scripts

All of them run in-process against the native addon (`bun run build:native`
first). None of them is a latency gate; see `docs/BENCHMARK_BASELINES.md` for
how regressions are judged.

| Command | Script | What it reports |
|---|---|---|
| `bun run bench:handshake` | `handshake-latency.ts` | handshake p50/p95/p99 and close-latency p99 (JSON line); fails if any handshake fails |
| `bun run bench:stream` | `stream-throughput.ts` | bidi echo throughput in MB/s (JSON line) |
| `bun run bench:datagram` | `datagram-throughput.ts` | datagram throughput, loss ratio, event-loop delay, CPU user time, peak RSS |
| `bun run bench:baseline` | `baseline.ts` | the three above in one machine-readable summary |
| `bun run bench:regress` | `bench-regress.ts` (`bench-lib.ts`) | repeated runs with 95% confidence intervals, compared against `approved-baselines.json`; writes `.release-evidence/bench/bench-regress-artifact.json`. Fails while no baseline is approved |
| `bun run bench:h7-floor` | `datagram-delivery-floor.ts` | the JavaScript-side ceiling of batched datagram delivery (H7 evidence; `docs/TESTPLAN.md`) |
| `bun run bench:h7-e2e-probe` | `datagram-batch-e2e-probe.ts` | batched vs unbatched delivery through the real addon receive path |

`mirror-send/` holds the `sendDatagramMirror` fan-out benchmark, its design
notes and recorded runs (`mirror-send/RUNS.md`).
