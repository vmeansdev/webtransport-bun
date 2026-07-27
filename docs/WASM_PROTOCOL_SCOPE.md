# WASM backend — protocol scope

What the wasm QUIC/H3/WebTransport backend implements, delegates, or still
owes for **coupled package 1.0.0**. Canonical release truth:
`docs/release-status.json`.

## Coupled 1.0 bar (product requirement)

Package GA is **coupled**: native and `/wasm` promote together. WASM 1.0
requires, in addition to evidence gates:

| Capability | 1.0 requirement | Claim id | Status |
|---|---|---|---|
| Dynamic QPACK | RFC 9204 dynamic table with hard caps | `wasm-dynamic-qpack` | **passed** on candidate: opt-in `qpackMaxTableCapacity` / `enableDynamicQpack` (default 0); peer decoder ICI/section-ack applied to encoder KRC; indexed outbound CONNECT/status when capacity > 0 |
| Multi-session | `SETTINGS_WT_MAX_SESSIONS > 1`, demux by session id | `wasm-multi-session` | **passed** on candidate: WtEvent `session_id` demux, session-scoped APIs, JS `(conn,sessionId)` map, `openSession`, SessionClosed vs ConnectionClosed; primary CONNECT close tears down QUIC |
| 0-RTT / early data | Session tickets + anti-replay | `wasm-0rtt` | **passed** on candidate for process-local Rust ticket store + `has0Rtt`/`accepted0Rtt` when `enable0Rtt: true` (default false); JS `TicketStoreHost` is **not** bridged to rustls yet (export-only / future durable host) |
| Facade / API parity | W3C-shaped options + `E_*` parity with native | `wasm-facade-parity` | still **pending**: foundation/options only; product-complete parity smoke incomplete |

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
- Frame-size bound: a single buffered H3 control/CONNECT/HEADERS frame is
  capped at `MAX_H3_FRAME_SIZE` (1 MiB); a peer advertising more is closed with
  H3_EXCESSIVE_LOAD (see `endpoint.rs`).
- CONNECT handshake timeout (`connect_deadline`, 10 s) so an unanswered
  handshake fails `ready` instead of hanging.
- Client certificate pinning via `serverCertificateHashes` (ECDSA P-256,
  ≤ 14-day validity — enforced in `verify.rs`).

## Delegated to quinn-proto (transport layer)

- Connection migration, key update, loss recovery, congestion control, ACKs,
  flow control, retry / stateless reset, and the QUIC idle timeout. These are
  handled by quinn-proto and inherit its correctness and defaults. Early data
  (0-RTT) is wired here under `enable0Rtt` (`ticket_store.rs`);
  `wasm-0rtt` is claim-passed for the Rust process-local store path — durable
  JS `TicketStoreHost`→rustls bridging remains unfinished.

## Still out of 1.0 scope (non-goals)

- **No WebTransport-layer datagram-size or flow accounting** beyond quinn's
  transport limits and the H3 frame cap above. Application datagram size is
  bounded by the QUIC path MTU / quinn datagram limits.
- Porting `wtransport` into wasm32 (Tokio / native UDP).
- Browser server outside Chromium Isolated Web App + Direct Sockets.
- Treating `scale-10k-multisource` as a GA blocker (`gaRequired: false`).

## Server-in-browser constraint

The in-browser server path requires Direct Sockets in a Chromium Isolated Web
App; see `README.md` and `docs/COMPATIBILITY.md`. `/wasm` remains a
**candidate** surface until coupled promote succeeds — tracked in
`docs/WASM_1.0_PLAN.md` and `docs/release-status.json`.
