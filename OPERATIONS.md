# OPERATIONS.md

## Running an in-process server (example)
Example usage (JS/TS):

- create server with TLS cert/key
- handle session: datagrams and streams

Operational requirements:
- UDP port must be reachable from the internet (firewall rules).
- Certificates must be valid for the hostname used by clients/browsers.

## Recommended defaults
- Keep maxSessions conservative initially (e.g., 200–500) until tested.
- Keep per-session queued bytes low (<= 2 MiB).
- Prefer backpressure over drops; enable drop policy only for datagrams if you accept loss.

## Enforced caps
- Datagram size: maxDatagramSize (must respect negotiated QUIC max)
- Stream opens: maxStreamsPerSessionBidi, maxStreamsPerSessionUni, maxStreamsGlobal

## Metrics to monitor
- sessionsActive, handshakesInFlight, streamsActive
- queuedBytesGlobal
- datagramsDropped
- backpressureTimeoutCount
- rateLimitedCount, limitExceededCount

## Idle timeout behavior

- `idleTimeoutMs` (default 60s): connection closed if no activity for this duration.
- Activity: any data sent or received (handshake, datagrams, stream data). QUIC keepalives may extend the window.
- When idle timeout fires: session closes with appropriate code; `closed` promise resolves.
- Slow-reader detection (planned): streams with sustained backpressure beyond backpressureTimeoutMs are reset.

## Troubleshooting
1) Browser cannot connect
- Verify UDP port open
- Verify cert valid (SAN matches hostname)
- Verify you are using https:// URL and WebTransport is enabled in the browser
2) Frequent disconnects
- Check idleTimeoutMs
- Check rate limiting thresholds
3) High memory
- queuedBytesGlobal near cap indicates slow consumers or too-large buffers
- reduce highWaterMark, reduce per-session/per-stream limits, scale out
4) Poor performance
- verify batching enabled
- reduce per-message overhead (larger chunk sizes, fewer crossings)

## Tuning guide

- **Low latency**: reduce maxQueuedBytesPerStream, use smaller datagrams, lower backpressureTimeoutMs
- **Throughput**: increase per-session limits, larger highWaterMark on streams
- **queuedBytesGlobal rising**: slow consumers or too many concurrent streams; reduce limits or scale out

## Known limitations and compatibility

- Client `connect()` not yet implemented
- macOS + Linux only (arm64, x64)
- Requires Bun >= 1.3.9
- Node-API: addon is built for Bun; Node compatibility not tested

## Public internet deployment

- **UDP firewalling**: Allow inbound UDP on your WebTransport port (e.g. 443). Many cloud providers require explicit security-group rules for UDP.
- **Certificates**: Use a valid TLS cert (e.g. Let's Encrypt). SAN must include the hostname clients use. Self-signed works only for dev/testing.
- **Browser failure modes**: CORS does not apply to WebTransport. Common issues: wrong URL scheme (must be https://), cert mismatch, UDP blocked by network.

## Deployment notes
- Run the Bun process as a dedicated service user.
- Use systemd on Linux; ensure Restart=on-failure.
- Collect logs centrally; scrape metrics via exposed endpoint (if you add one) or poll metricsSnapshot.
