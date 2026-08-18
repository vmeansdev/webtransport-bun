# AGENTS.md

## Project goal
Build a production-ready WebTransport implementation with Bun **v1.3.14+** as the primary runtime (plus Node and Deno via Node-API) on **macOS + Linux + Windows**, implemented as a **Node-API (napi-rs) native addon** powered by **wtransport (Rust)**. Must support:
- In-process **server** support (mandatory)
- In-process **client** support
- **Datagrams** (message-based) with Promise backpressure
- **Streams** (uni + bidi) exposed as **Node streams** (Readable/Writable/Duplex) with standard backpressure semantics
- Browser-shaped client facade parity with the W3C WebTransport draft as a target; any remaining gaps must be explicitly documented in docs/PARITY_MATRIX.md.

## Non-goals
- Transparent reverse proxying
- QUIC implementation from scratch (use wtransport)

## Supported targets
- Bun: **>= 1.3.14** (primary target)
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
- streamReceiveWindow / receiveWindow / sendWindow: unset (QUIC windows, native
  only; derived from maxQueuedBytesPerStream and maxQueuedBytesPerSession unless
  set — see docs/OPERATIONS.md "Flow-control windows" for the memory math)

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

## Learned User Preferences
- Prefer `bunx` over `npx` for running package binaries.
- Keep one scoped logical change per commit; do not commit planning/instruction files (`INSTRUCTIONS_CURRENT_PHASE.md`, `Task.md`, `PRODUCTION_PLAN.md`, `PARITY_PLAN.md`, `POOLING_PLAN.md`, and similar plan markdown) unless explicitly asked.
- When told to continue until all phases or subphases are done, keep going without pausing for per-step confirmation; partial completion is not enough.
- Prefer project markdown docs under `docs/` rather than the repo root.
- Prefer local Chrome on this machine for browser/IWA verification when available rather than assuming Chromium/Playwright is missing.
- When diagnosing a local-verifiable gate (IWA/interop/harness), build and run the proof yourself instead of only explaining missing artifacts or blockers.
- Rust native code must have its own unit-test coverage, separate from TypeScript tests, during development.
- After scoped native/coverage refactors, run an auto-review pass and report before continuing related work.
- For release-gap closure, prefer hybrid evidence re-runs: re-prove what can run locally and demote claims that cannot be honestly re-stamped (no theater or copied evidence).
- Target production-grade 1.0 for both native and WASM; WASM 1.0 requires protocol expansion (multi-session, 0-RTT, dynamic QPACK) plus facade/API parity with native, not evidence-hardening alone.
- When implementing an attached plan, do not edit the plan file itself; execute the plan as specified.

## Learned Workspace Facts
- Active 1.0 production work is on branch `feat/wasm-1.0` in the worktree at `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/feat-wasm-1.0` (not `release/1.0-hardening`).
- Phase execution is driven by `INSTRUCTIONS_CURRENT_PHASE.md` → infer/update `Task.md`, then execute until all phases are done.
- Published package entrypoints target compiled JS and `.d.ts` under `dist/` with native addon binaries under `prebuilds/`.
- Invalid client `caPem` must map to stable `E_TLS` (not `E_INTERNAL`).
- When GitHub Actions are unavailable due to limits, continue local 1.0 hardening without waiting on CI.
- Keep floored Rust logic modules (`session.rs`, `server.rs`) free of NAPI Env wrappers; put bindings in `*_napi.rs` / `server_spawn.rs` so llvm-cov floors stay honest.
- Native llvm-cov floors (90% line / 90% function / 80% branch) apply to floored logic modules only; NAPI binding modules and `server_spawn` are intentionally outside those floors.
- WASM (`crates/wasm/`) is a separate engine from native: sans-IO `quinn-proto` + hand-rolled H3/WT with JS-owned UDP I/O; native is napi + `wtransport` + Tokio.
- Browser WASM networking for 1.0 is constrained to Chromium IWA + Direct Sockets; general browser-server outside that path is out of scope.
- IWA Direct Sockets proofs need generated/signed web-bundle assets (`origin.txt`, `.wbn`/`.swbn`; typically gitignored) before `tools/interop/run-iwa.mjs`; packaged artifacts often live under `.release-evidence/iwa/`.
- WASM soft facade gaps (pooling, `waitUntilAvailable`, real `getStats`/CC, sendOrder/sendGroup, live TLS/SNI, metrics/log, `WasmServerSession`) are largely closed on the candidate; ticket hosts use IndexedDB in IWA and memory/file on Bun; remaining non-parity is product/API (async `/wasm` vs native sync root, session shape, IWA-only browser host, Bun still prefers native).
- WASM IWA plug-and-play server is async `createServer` / `createIwaServer` from the `/wasm` entrypoint over Direct Sockets; distinct from the root native sync `createServer`.

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
