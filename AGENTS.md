# AGENTS.md

## Project goal
Build a production-ready WebTransport implementation with Bun **v1.3.9+** as the primary runtime (plus Node and Deno via Node-API) on **macOS + Linux + Windows**, implemented as a **Node-API (napi-rs) native addon** powered by **wtransport (Rust)**. Must support:
- In-process **server** support (mandatory)
- In-process **client** support
- **Datagrams** (message-based) with Promise backpressure
- **Streams** (uni + bidi) exposed as **Node streams** (Readable/Writable/Duplex) with standard backpressure semantics
- Browser-shaped client facade parity with the W3C WebTransport draft as a target; any remaining gaps must be explicitly documented in docs/PARITY_MATRIX.md.

## Non-goals
- Transparent reverse proxying
- QUIC implementation from scratch (use wtransport)

## Supported targets
- Bun: **>= 1.3.9** (primary target)
- Node: supported (Node-API compatible runtime)
- Deno: supported (npm + Node-API addon support)
- OS: macOS, Linux, Windows
- Architectures: define in CI (minimum: macOS arm64, linux x64, windows x64)

## Definition of Done (hard gates)
### Feature gates
1. Server:
   - listen on UDP
   - accept sessions
   - receive/send datagrams
   - accept/create uni + bidi streams
   - reset/stopSending with codes
2. Client:
   - connect to server
   - datagrams send/recv
   - uni + bidi streams send/recv

### Production gates
1. Bounded memory (no unbounded buffering)
   - global and per-session budgets enforced
   - backpressure first, then timeouts, then connection shedding
2. Deterministic shutdown
   - no task leaks, no socket leaks, no pending promises stuck forever
3. Abuse resistance enabled by default
   - per-IP rate limits for handshakes, streams, datagrams
   - caps on sessions, streams, queued bytes
4. Interop gate
   - Chromium WebTransport client can connect and exchange datagrams + streams reliably in tests
5. Packaging gate
   - prebuilt binaries for supported targets
   - `bun add` works
   - `bun test` passes on supported targets

## Authoritative docs
- API contract: docs/SPEC.md
- W3C parity status matrix: docs/PARITY_MATRIX.md
- W3C parity execution plan: docs/PARITY_MATRIX.md (Priority Execution Order / Remaining Work)
- Implementation design: docs/ARCHITECTURE.md
- Security defaults: SECURITY.md
- Verification: docs/TESTPLAN.md
- Operations: docs/OPERATIONS.md
- CI/release: docs/CI.md
- Contribution rules: CONTRIBUTING.md

## Implementation constraints (must follow)
1. Node streams for stream surfaces (Readable/Writable/Duplex).
2. Promise-based datagram sending with bounded in-flight/backpressure.
3. Two dedicated Tokio runtimes (server + client), each single-threaded and owned by the addon; cross-runtime communication must stay bounded and deterministic.
4. Bounded queues for all JS↔Rust crossings; all buffers counted against budgets.
5. JS callback delivery must be rate-limited/batched to prevent per-packet callback storms.
6. W3C client-facade divergences MUST be explicit in `docs/PARITY_MATRIX.md`; no silent no-op behavior for declared options.
7. Any divergence-to-implementation work must preserve stable `E_*` diagnostics and add parity + interop tests.
8. Test determinism rule: tests MUST NOT use unbounded waits on async iterators/streams (`await iter.next()`, open-ended `for await`) without a timeout guard. Use bounded helpers (`Promise.race` with `Bun.sleep(...)`) or polling-with-deadline so each wait has an explicit upper bound and cannot hang CI.

## Default limits (v1)
These are default values; they must be configurable via server/client options.
- maxSessions: 2000
- maxHandshakesInFlight: 200
- maxStreamsPerSessionBidi: 200
- maxStreamsPerSessionUni: 200
- maxStreamsGlobal: 50000
- maxDatagramSize: 1200 (cap; must also respect negotiated max)
- maxQueuedBytesGlobal: 512 MiB
- maxQueuedBytesPerSession: 2 MiB
- maxQueuedBytesPerStream: 256 KiB
- backpressureTimeoutMs: 5000
- handshakeTimeoutMs: 10000
- idleTimeoutMs: 60000

Per-IP token buckets (defaults)
- handshakes: 20/s burst 40
- stream opens: 200/s burst 400
- datagrams ingress: 2000/s burst 5000

## Stable error codes (minimum)
- E_TLS
- E_HANDSHAKE_TIMEOUT
- E_SESSION_CLOSED
- E_SESSION_IDLE_TIMEOUT
- E_STREAM_RESET
- E_STOP_SENDING
- E_QUEUE_FULL
- E_BACKPRESSURE_TIMEOUT
- E_LIMIT_EXCEEDED
- E_RATE_LIMITED
- E_INTERNAL

## Commit discipline
- Each logical change must be **one scoped commit**.
- Commit message format: **Verb + What + Why** (e.g. `Add error codes for stable programmatic handling`).
- Do not bundle unrelated changes in a single commit.
