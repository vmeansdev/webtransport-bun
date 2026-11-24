# SECURITY.md

## Threat model
Public internet UDP service exposed on a port (commonly 443). Likely threats:
- Handshake floods / connection churn (CPU exhaustion)
- Session floods (memory exhaustion)
- Stream-open floods (state explosion)
- Slow-read / never-read (buffer bloat)
- Datagram bursts (event loop / JS callback storms)
- Malformed / adversarial traffic triggering panics

Canonical release truth: `docs/release-status.json`. This document defines the security controls that feed that manifest.

## Security principles
1. Safe defaults
- TLS verification enabled by default for client.
- `insecureSkipVerify` requires explicit `tls.insecureSkipVerify: true`; emits warning log when used. Dev only — never use in production.
- Native diagnostics are redacted by default (log payload/message/session metadata and panic details).
  `createServer({ debug: true, ... })` turns redaction off: log events then carry the full
  message plus `sessionId`, `peerIp` and `peerPort`. Use it only in trusted dev/debug
  environments, and treat its logs as containing client IP addresses.
2. Bounded resources
- All buffering is bounded and accounted for.
- There is always a cap that prevents unbounded memory growth.
3. Graceful shedding
- When overloaded, reject new handshakes/sessions/streams first.
- If a client is abusive, close that client before impacting others.

## Required controls (must ship enabled by default)
1. Timeouts
- handshakeTimeoutMs (default 10s): one budget per incoming connection, from
  its first Initial packet to the answer to its CONNECT request (QUIC + TLS +
  CONNECT together). A handshake that runs out is dropped, gives back its
  `maxHandshakesInFlight` slot and is counted in `limitExceededCount`.
- idleTimeoutMs (default 60s)
- backpressureTimeoutMs (default 5s)
2. Limits
- maxSessions, maxHandshakesInFlight
- max streams per session and global
- maxQueuedBytes global/per-session/per-stream
- maxDatagramSize cap
3. Rate limits per peer IP and per prefix
- RateLimitOptions: per-IP handshakesBurst, per-prefix handshakesBurstPerPrefix (/24 IPv4, /64 IPv6). Both also cap the sessions open at once from that IP or prefix (defaults 40 and 100)
- Over-rate traffic is refused, not punished: a handshake is refused, a stream open is reset, and a datagram over the ingress rate is dropped and counted in `rateLimitedCount` and `datagramsDropped`. The session survives, on both the native and wasm engines.
- The handshake token bucket and the per-IP / per-prefix session caps are
  charged once the QUIC and TLS handshake has finished and the CONNECT
  request has been read, and a refused peer gets HTTP 429 (`E_RATE_LIMITED`).
  They are not charged earlier on purpose: the server sends no QUIC Retry, so
  the source address of an Initial is unvalidated and spoofable, and charging
  it would let anyone drain a victim's budget.
4. Connection churn protection
- maxHandshakesInFlight (default 200) caps handshakes in progress, counted
  from the first Initial packet, before any cryptographic work. Overflow is
  refused with QUIC CONNECTION_REFUSED.
- handshakeTimeoutMs bounds how long each of those slots can be held. This
  pair, not the per-IP buckets, is what bounds pre-handshake work: a source
  that sends Initials and never finishes (one packet each is enough) can keep
  the cap occupied, but each packet holds a slot for at most
  handshakeTimeoutMs. Lower handshakeTimeoutMs to shrink that window.
- Per-IP and per-prefix limits prevent single-source exhaustion of sessions
5. Panic containment
- Rust panics must be caught at task boundaries where possible
- convert to E_INTERNAL and close affected session/server

## Recommended operational guidance
- Run behind a UDP-capable firewall with explicit allow rules.
- Monitor:
  - rateLimitedCount
  - limitExceededCount
  - datagramsDropped
  - queuedBytesGlobal
  - backpressureTimeoutCount
- If queuedBytesGlobal approaches cap:
  - decrease per-session limits
  - decrease stream highWaterMarks
  - enable datagram drop policy (optional)
  - scale horizontally

## Dependency policy
- Pin wtransport + transitive QUIC/H3 dependencies (see Cargo.lock).
- Monthly dependency update cadence; security patches applied promptly.
- Respond to CVEs quickly; publish security advisories if needed.

## Security reporting
- Report vulnerabilities via GitHub Security Advisories or a dedicated contact (see CONTRIBUTING).

## CI scan triage and suppressions
- CodeQL and Trivy findings are triaged in PRs; `CRITICAL`/`HIGH` are blocking by default.
- **P3.2**: Release workflow runs security gates (cargo audit, Trivy fs + lib, CodeQL) before build; release is blocked on any CRITICAL/HIGH finding.
- Any suppression must include:
  - clear justification,
  - scope (exact package/path/CVE),
  - expiration/revisit date.
- Suppressions should be minimal and temporary; broad/global ignores are not allowed.
- When a finding is accepted temporarily, track it in an issue with owner + target fix release.

## Environment variables affecting security diagnostics
- `WEBTRANSPORT_LOG_EXPECTED_CHANNEL_CLOSES=1`: enables logging of expected (non-error) channel close events. Useful for debugging teardown ordering, but may produce noisy logs in production. Does not affect security enforcement.
- `WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN=1`: suppresses the warning log emitted when `insecureSkipVerify` is used. Should only be set in CI/test environments.
- `WEBTRANSPORT_SUPPRESS_LOG_CALLBACK_WARN=1`: suppresses the `log callback failed` warning printed when your `log` callback throws. Does not affect security enforcement.
These variables control diagnostic verbosity only; they do not bypass rate limits, TLS verification, or resource caps.

## Native 0-RTT / early data (anti-replay)

Off by default on both sides. A server opts in with `createServer({ enable0Rtt: true })`
and a client with `connect(url, { enable0Rtt: true })` (incompatible with
`allowPooling`). A resuming client's CONNECT can then arrive as TLS early data, which an
attacker who captured it can replay.

- **Session delivery is deferred by default.** A 0-RTT session reaches `onSession` only
  once the handshake is confirmed and the request is no longer replayable.
  `allowEarlySession: true` delivers it earlier; set it only when everything `onSession`
  does before `session.handshakeConfirmed` is true is strictly idempotent, and gate side
  effects on that flag.
- **Visibility.** Sessions report `has0Rtt` (early data was used), `accepted0Rtt` and
  `handshakeConfirmed`.
- **Tickets are per process.** Resumption state lives in memory; a restart or a request
  landing on another instance falls back to a full handshake. `exportTicketVault` /
  `importTicketVault` move tickets between client identities inside one process only.

## WASM 0-RTT / early data (anti-replay)

Opt-in via endpoint option `enable0Rtt` (default **false**). When enabled, the
wasm stack configures rustls/quinn-proto for TLS 1.3 early data:

- **Server:** `max_early_data_size = u32::MAX` (QUIC requirement) with a
  **stateful** session store (`InMemoryTicketStore`). Stateless ticketing is
  intentionally not used; rustls only accepts early data on the stateful path.
- **Client:** `enable_early_data = true` with the same style of ticket store so
  a later connect can offer 0-RTT when a ticket is present.

### What is protected
- **Ticket single-use (server):** presenting a stateful session ticket consumes
  it (`StoresServerSessions::take`). A naive replay of the same ticket against
  this process should fail resumption / early-data acceptance once the ticket
  is spent.
- **Transport-parameter / ALPN consistency:** quinn/rustls reject 0-RTT when
  resumed parameters are incompatible (covered by unit tests); the handshake
  falls back to 1-RTT.

### What is not protected
- **Application-data replay:** 0-RTT stream/datagram payloads can still be
  replayed by an on-path attacker to the original server within the ticket
  lifetime. Treat early application data as **at-most-once / replay-tolerant**
  only (same rule as HTTP early data). Do not put non-idempotent WT session
  setup or mutating RPCs solely in 0-RTT.
- **Cross-process / multi-instance anti-replay:** the in-memory store is
  per-endpoint process. Shared anti-replay across horizontally scaled wasm
  hosts (or durable JS-backed stores) is **not** implemented yet; a future JS
  ticket-store bridge must supply coordinated single-use semantics if required.
- **Disabled by default:** with `enable0Rtt: false`, early data is not offered
  or accepted even if residual tickets exist in a shared store.
- **CONNECT / app policy:** wait for 1-RTT (post-handshake) before non-idempotent
  WebTransport CONNECT or application RPCs unless an explicit, documented
  exception allows early data. Export `has0Rtt` / `accepted0Rtt` so hosts can
  gate sends. In-process anti-replay uses the Rust `InMemoryTicketStore::take`
  path. JS `TicketStoreHost` participates on the **hydrate/dump** path around
  connect/close (opaque process-local vault blobs keyed by server name); it is
  not on the rustls hot path. Durable IndexedDB / cross-process ticket
  serialization remains out of scope. Do not reuse a taken ticket.

## Known limitations
### Private key memory zeroing
Private key PEM strings are parsed into `PrivateKeyDer` and stored in standard Rust heap allocations which are not zeroed on deallocation. In a process crash (core dump, swap file), key material could theoretically be recoverable from process memory. This is consistent with most non-HSM TLS libraries. For deployments requiring HSM-level key protection, use external key management with TLS termination at a trusted proxy.
