# TESTPLAN.md

## Required suites and pass criteria (P0-G)

### Unit tests
- `bun test packages/` — must pass
- Packages: webtransport (server, client, lifecycle, session-accept)

### Load / harness
- `bun run test:load-addon` — addon server, load-client, no panics, FD stable, leak checks
- `bun run test:overload-addon` — shedding (limitExceededCount > 0, sessionsActive ≤ max+2)
- `bun run test:soak-addon` — SOAK_DURATION env, task gauges and queued bytes return to baseline

### Interop
- `cd tools/interop && bun run playwright test` — Chromium WebTransport echo (datagram, streams)
- Currently runs against reference server; P0-E requires addon server

### Rust quality gates
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `cargo test --workspace`

### Pass criteria
- All unit tests pass
- load-addon, overload-addon pass
- No panics in load-client stderr
- Interop passes (datagram + stream echo)
