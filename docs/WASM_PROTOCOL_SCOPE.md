# WASM backend — protocol scope

What the wasm QUIC/H3/WebTransport backend implements, delegates, or still
owes for **coupled package 1.0.0**. Canonical release truth:
`docs/release-status.json`.

## Coupled 1.0 bar (product requirement)

Package GA is **coupled**: native and `/wasm` promote together. WASM 1.0
requires, in addition to evidence gates:

| Capability | 1.0 requirement | Claim id | Status |
|---|---|---|---|
| Dynamic QPACK | RFC 9204 dynamic table with hard caps | `wasm-dynamic-qpack` | **passed** on candidate: opt-in `qpackMaxTableCapacity` / `enableDynamicQpack` (default 0); peer decoder ICI/section-ack applied to encoder KRC; indexed outbound CONNECT/status when capacity > 0. **Native parity:** the native backend now implements the same RFC 9204 dynamic-table decode + decoder stream (Section-Ack / ICI / Stream-Cancellation) + peer-sized encoder machinery via the wtransport fork, opt-in through the same `qpackMaxTableCapacity` / `enableDynamicQpack` options — dynamic QPACK is no longer wasm-only. **Deliberate divergence:** native always advertises `SETTINGS_QPACK_BLOCKED_STREAMS = 0` (whereas the wasm `enableDynamicQpack` preset uses 16), so native never emits a dynamic-table *reference* on the single CONNECT exchange — it populates and acknowledges the table but encodes the CONNECT literally. See `docs/PARITY_MATRIX.md` |
| Multi-session | `SETTINGS_WT_MAX_SESSIONS > 1`, demux by session id | `wasm-multi-session` | **passed** on candidate: WtEvent `session_id` demux, session-scoped APIs, JS `(conn,sessionId)` map, `openSession`, SessionClosed vs ConnectionClosed; primary CONNECT close tears down QUIC |
| 0-RTT / early data | Session tickets + anti-replay | `wasm-0rtt` | **passed** on candidate for process-local Rust ticket store + `has0Rtt`/`accepted0Rtt` when `enable0Rtt: true` (default false); JS `TicketStoreHost` hydrate/dump bridges opaque process-local vault blobs (pinned-client resume without `shareProcess0RttTicketStore`); durable IndexedDB serialization remains out of scope. **Native parity:** the native backend now implements the same session-object shape (`enable0Rtt`, `has0Rtt`/`accepted0Rtt`/`handshakeConfirmed`, opaque `exportTicketVault`/`importTicketVault`) via the wtransport fork — 0-RTT is no longer wasm-only. See `docs/PARITY_MATRIX.md` and `docs/FORK_MAINTENANCE.md` |
| Facade / API parity | W3C-shaped options + `E_*` parity with native | `wasm-facade-parity` | **pending** — the earlier **passed** stamp rested on a session-map smoke and was demoted once the server session converged. All 9 `parity-*.test.ts` now run on both backends through `webtransport-bun/portable` (native 67/0; wasm 64 pass/3 skip/0 fail), but a `passed` stamp needs evidence bound to `candidate.commit`. Implemented: `allowPooling` endpoint pool, `waitUntilAvailable` with timeout, quinn-backed `getStats`, congestion factories (Cubic/BBR/NewReno), sendGroup/sendOrder scheduler, auto ticket dump + Memory/File/IndexedDB hosts, metricsSnapshot, live TLS/SNI resolver, log/debug hooks, and a `WasmServerSession` that mirrors native `ServerSession` (`id`/`peer`/`incomingDatagrams()`/incoming stream `ReadableStream`s/`getStats()`) |

These are **1.0 requirements**, not permanent product omissions. Treat
`docs/release-status.json` as canonical for claim pass/fail.

## Implemented today (hand-rolled)

- HTTP/3 framing: control stream, SETTINGS, Extended CONNECT, HEADERS.
  Chromium-facing default advertises QPACK capacity **0** / blocked streams
  **0** (literal-only). Opt-in dynamic table emits decoder-stream ICI /
  section-acks, applies peer ICI/section-acks to encoder Known Received Count,
  and indexes outbound CONNECT/status when capacity > 0 (`wasm-dynamic-qpack`
  passed on candidate with commit-bound evidence).
- WebTransport session establishment (Extended CONNECT → 200), datagrams
  (quarter-session-id framing), and uni/bidi streams.
- **Session capsules on the CONNECT stream** (`capsule.rs`), encode and decode,
  with the bounded partial-frame accumulation the rest of the H3 parser uses so
  a capsule split across DATA frames still parses:
  - `WT_CLOSE_SESSION` — a session close now reaches the peer as a capsule
    carrying the application code and reason, instead of a QUIC
    `CONNECTION_CLOSE` that told a browser only that the connection vanished.
    The QUIC connection is left up for sibling sessions
    (`endpoint_tests.rs::primary_session_close_conveys_code_and_reason_over_capsule`).
    A capsule write is gated on the session being established, so nothing is
    written before the 2xx (§3.2).
  - `WT_DRAIN_SESSION` — received drains resolve `draining` without ending the
    session (`endpoint_tests.rs::drain_capsule_notifies_the_peer_without_closing_the_session`).
  - `WT_BUFFERED_STREAM_REJECTED` for streams that never associate with a
    session (`endpoint_tests.rs::unassociated_wt_stream_is_rejected_with_buffered_stream_rejected`).
- WebTransport application error codes are mapped onto the reserved QUIC range
  and back per draft §4.4 (`wt_error.rs`), for QUIC **stream** codes only — the
  close capsule carries the raw 32-bit code. Proven against real Chromium in
  `tools/interop/tests-wasm/wasm-server.spec.ts`.
- **`GOAWAY` is a deliberate non-goal on wasm.** The wasm backend signals a
  session drain only; the wasm h3 module has no control-stream `GOAWAY` handling,
  so there is no connection-level GOAWAY send path. (Native does send it, via
  `ServerSession.goAway()` — see `docs/PARITY_MATRIX.md`; that stays native-only.)
- Frame-size bound: a single buffered H3 control/CONNECT/HEADERS frame is
  capped at `MAX_H3_FRAME_SIZE` (1 MiB); a peer advertising more is closed with
  H3_EXCESSIVE_LOAD (see `endpoint.rs`).
- CONNECT handshake timeout (`connect_deadline`, 10 s) so an unanswered
  handshake fails `ready` instead of hanging.
- Client certificate pinning via `serverCertificateHashes` (ECDSA P-256,
  ≤ 14-day validity — enforced in `verify.rs`). This is the default and the
  only path with end-to-end proof.
- Client CA-root trust via `caPem` (user-supplied roots) is **implemented and
  end-to-end verified**. `wasm-ca-trust.test.ts` runs a server holding a
  CA-issued leaf against a client trusting only that CA over the in-memory
  relay: the handshake completes and stream data echoes. A client handed a
  different CA's PEM is refused with `E_TLS: handshake failed with TLS alert
  48` (unknown_ca). The same chain is proven at the QUIC layer natively in
  `spike_tests::loopback_handshake_over_ca_root_trust`. Test chains come from
  `cert::generate_ca_signed`, gated behind `dev-insecure` exactly like the
  accept-any client verifier, so no shipped artifact can mint a CA.

## Delegated to quinn-proto (transport layer)

- Connection migration, key update, loss recovery, congestion control, ACKs,
  flow control, retry / stateless reset, and the QUIC idle timeout. These are
  handled by quinn-proto and inherit its correctness and defaults. Early data
  (0-RTT) is wired here under `enable0Rtt` (`ticket_store.rs`);
  `wasm-0rtt` is claim-passed for the Rust process-local store path and the
  JS `TicketStoreHost` hydrate/dump bridge (opaque in-process vault blobs).
  Durable IndexedDB / cross-reload ticket serialization is available via
  `IndexedDBTicketStoreHost`; Bun/Node file durability via `FileTicketStoreHost`.
  Tickets auto-dump on manager close when a store is configured.

## Still out of 1.0 scope (non-goals)

- **No WebTransport-layer datagram-size or flow accounting** beyond quinn's
  transport limits and the H3 frame cap above. Application datagram size is
  bounded by the QUIC path MTU / quinn datagram limits.
- Porting `wtransport` into wasm32 (Tokio / native UDP).
- Browser server outside Chromium Isolated Web App + Direct Sockets.

## Server-in-browser constraint

The in-browser server path requires Direct Sockets in a Chromium Isolated Web
App; see `README.md` and `docs/COMPATIBILITY.md`. On that path,
`await createServer(...)` / `createIwaServer` from
`@webtransport-bun/webtransport/wasm` is the plug-and-play entry (auto-loads
`wasm-dist/web`, binds UDP, returns `WasmWebTransportServer` with live
`certHashBase64`). It is not the root native sync `createServer`. `/wasm`
remains a **candidate** surface until coupled promote succeeds — tracked in
`docs/WASM_1.0_PLAN.md` and `docs/release-status.json`.
