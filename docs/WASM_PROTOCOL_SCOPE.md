# WASM backend — protocol scope

What the wasm QUIC/H3/WebTransport backend implements, delegates, or omits.
Documented explicitly so consumers know the boundaries (the original audit
flagged these as undocumented).

## Implemented in this crate (hand-rolled)
- HTTP/3 framing: control stream, SETTINGS, Extended CONNECT, HEADERS
  (literal-only QPACK with the RFC 9204 static table + Huffman literals).
- WebTransport session establishment (Extended CONNECT → 200), datagrams
  (quarter-session-id framing), and uni/bidi streams.
- Frame-size bound: a single buffered H3 control/CONNECT/HEADERS frame is
  capped at `MAX_H3_FRAME_SIZE` (1 MiB); a peer advertising more is closed with
  H3_EXCESSIVE_LOAD (see `endpoint.rs`).
- CONNECT handshake timeout (`connect_deadline`, 10 s) so an unanswered
  handshake fails `ready` instead of hanging.
- Client certificate pinning via `serverCertificateHashes` (ECDSA P-256,
  ≤ 14-day validity — enforced in `verify.rs`).

## Delegated to quinn-proto (transport layer — fully supported, just not ours)
- Connection migration, key update, loss recovery, congestion control, ACKs,
  flow control, retry / stateless reset, and the QUIC idle timeout. These are
  handled by quinn-proto and inherit its correctness and defaults.

## Intentionally limited / absent (by design for this phase)
- **One WebTransport session per QUIC connection** (`WT_MAX_SESSIONS = 1`).
  A second CONNECT on the same connection is rejected.
- **No 0-RTT / early data.** Every session performs a full 1-RTT handshake.
- **No QPACK dynamic table.** Only the static table + Huffman literals are
  decoded; a dynamic-table reference is treated as unsupported.
- **No WebTransport-layer datagram-size or flow accounting** beyond quinn's
  transport limits and the H3 frame cap above. Application datagram size is
  bounded by the QUIC path MTU / quinn datagram limits.

## Server-in-browser constraint
The in-browser server path requires Direct Sockets in a Chromium Isolated Web
App; see `README.md` and `docs/COMPATIBILITY.md`. `/wasm` remains experimental
(0.x) until the facade converges with the native W3C surface — tracked in
`docs/WASM_1.0_PLAN.md`.
