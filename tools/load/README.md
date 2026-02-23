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

### Soak test (nightly)
- Duration: 30 minutes
- Concurrent sessions: 500
- Datagrams: 500/s, streams: 5/s
- **Pass criteria**: no errors

## Running

From repo root:

```bash
# Short load test (starts reference server, runs load-client)
bun run test:load

# Soak test (release build, 30 min)
bun run test:soak

# Addon soak (P2.2): 2min default, or 1h/24h/72h
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

**P2.2 long soak**: For 24h/72h, use GitHub Actions `soak-long` workflow (workflow_dispatch). Writes `tools/load/soak-artifacts.json` and `.csv`; trend-based leak gate when duration >= 3600s (RSS, FD, sessionTasks, streamTasks).

## Components

- **load-client** — Rust binary in `crates/reference` that connects to a WebTransport server and generates datagram + stream load. Built with `cargo build -p reference --bins`.
- **load.ts** — Orchestrates reference server + load-client, checks RSS growth.
- **soak.ts** — Same, with 30 min duration and 500 sessions (release build).

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
