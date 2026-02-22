# Benchmark baselines (Phase 2)

Record results here for regression tracking. Run `bun run bench:datagram` and `bun run bench:baseline` (if added) and update.

## Datagram throughput
- **Tool**: `tools/bench/datagram-throughput.ts`
- **Config**: 4 sessions, 10s, 1000 dgram/s
- **Baseline**: (record: `sent=`, `elapsed=`, `throughput= dgram/s`)

## Handshake latency (planned)
- p50, p95, p99

## Stream throughput (planned)
- MB/s, CPU per connection
