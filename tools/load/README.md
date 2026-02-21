# Load & Soak Tests

## Purpose
Verify that the webtransport-bun server handles sustained load without:
- Memory leaks (bounded buffers must hold)
- Task leaks (all Tokio tasks join on shutdown)
- Performance degradation over time

## Planned tests

### Short load test (CI)
- Duration: 30 seconds
- Concurrent sessions: 100
- Datagrams: 1000/s per session
- Stream opens: 10/s per session
- **Pass criteria**: no errors, RSS stays within 2× initial

### Soak test (nightly)
- Duration: 30 minutes
- Concurrent sessions: 500
- Mixed datagram + stream workload
- **Pass criteria**: no errors, no memory growth beyond 1.5× steady state

## Running

```bash
# Short load test
bun run tools/load/load.ts --duration=30 --sessions=100

# Soak test
bun run tools/load/soak.ts --duration=1800 --sessions=500
```

> Scripts will be added once the server implementation is functional.
