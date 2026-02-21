# SECURITY.md

## Threat model
Public internet UDP service exposed on a port (commonly 443). Likely threats:
- Handshake floods (CPU exhaustion)
- Session floods (memory exhaustion)
- Stream-open floods (state explosion)
- Slow-read / never-read (buffer bloat)
- Datagram bursts (event loop / JS callback storms)
- Malformed / adversarial traffic triggering panics

## Security principles
1. Safe defaults
- TLS verification enabled by default for client.
- `insecureSkipVerify` requires explicit `tls.insecureSkipVerify: true`; emits warning log when used. Dev only — never use in production.
2. Bounded resources
- All buffering is bounded and accounted for.
- There is always a cap that prevents unbounded memory growth.
3. Graceful shedding
- When overloaded, reject new handshakes/sessions/streams first.
- If a client is abusive, close that client before impacting others.

## Required controls (must ship enabled by default)
1. Timeouts
- handshakeTimeoutMs (default 10s)
- idleTimeoutMs (default 60s)
- backpressureTimeoutMs (default 5s)
2. Limits
- maxSessions, maxHandshakesInFlight
- max streams per session and global
- maxQueuedBytes global/per-session/per-stream
- maxDatagramSize cap
3. Rate limits per peer IP
- RateLimitOptions (handshakesPerSec, streamsPerSec, datagramsPerSec) configurable via createServer; per-IP token buckets and per-subnet limits planned
4. Panic containment
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
