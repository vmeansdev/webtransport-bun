# Benchmark baselines (Phase 2)

Record results here for regression tracking. Run `bun run bench:baseline` and update.

## Handshake latency
- **Tool**: `tools/bench/handshake-latency.ts`
- **Config**: 50 connects (BENCH_HANDSHAKES)
- **Baseline**: p50, p95, p99 (ms)

## Stream throughput
- **Tool**: `tools/bench/stream-throughput.ts`
- **Config**: 20 streams × 16 × 64KB (BENCH_STREAMS)
- **Baseline**: MB/s

## Datagram throughput
- **Tool**: `tools/bench/datagram-throughput.ts`
- **Config**: 4 sessions, 10s, 1000 dgram/s
- **Baseline**: sent, elapsed, throughput (dgram/s)
