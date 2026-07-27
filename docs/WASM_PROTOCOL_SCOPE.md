# WASM backend — protocol scope

What the wasm QUIC/H3/WebTransport backend implements, delegates, or still
owes for **coupled package 1.0.0**. Canonical release truth:
`docs/release-status.json`.

## Coupled 1.0 bar (product requirement)

Package GA is **coupled**: native and `/wasm` promote together. WASM 1.0
requires, in addition to evidence gates:

| Capability | 1.0 requirement | Claim id | Status |
|---|---|---|---|
| Dynamic QPACK | RFC 9204 dynamic table with hard caps | `wasm-dynamic-qpack` | foundation in progress (`crates/wasm/src/h3.rs`: bounded table, SETTINGS advertise, encoder-stream inserts, indexed decode; claim evidence still owed) |
| Multi-session | `SETTINGS_WT_MAX_SESSIONS > 1`, demux by session id | `wasm-multi-session` | foundation: default `WT_MAX_SESSIONS_DEFAULT=2` (hard cap 256); multi-CONNECT accept + datagram demux + over-cap `E_LIMIT_EXCEEDED`; JS facade session surfaces still pending |
| 0-RTT / early data | Session tickets + anti-replay | `wasm-0rtt` | foundation in progress (`ticket_store.rs` + rustls early-data wiring + loopback resume/reject tests; JS ticket persistence + claim evidence still owed) |
| Facade / API parity | W3C-shaped options + `E_*` parity with native | `wasm-facade-parity` | not yet implemented (target) |

These are **1.0 requirements**, not permanent product omissions. Until each
claim is `passed` with commit-bound evidence, the capability is unavailable
or incomplete.

## Implemented today (hand-rolled)

- HTTP/3 framing: control stream, SETTINGS, Extended CONNECT, HEADERS
  with bounded dynamic QPACK (default capacity 4096 / blocked streams 16;
  zero remains valid for compat). Encoder-stream inserts + indexed dynamic
  field lines are supported; full claim evidence is still outstanding.
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
  (0-RTT) foundation is wired here under `enable0Rtt` (`ticket_store.rs`);
  durable JS ticket persistence and claim evidence remain for `wasm-0rtt`.

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
