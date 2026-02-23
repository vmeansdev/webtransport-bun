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

See docs/METRICS.md for full metrics reference and structured log format.

## Prometheus / OTel export

Use `metricsToPrometheus(snapshot)` to convert `server.metricsSnapshot()` to Prometheus text format. Wire to an HTTP endpoint:

```ts
import { createServer, metricsToPrometheus } from "@webtransport-bun/webtransport";

const server = createServer({ ... });

// Expose /metrics for Prometheus scrape
Bun.serve({
  port: 9090,
  fetch(req) {
    if (new URL(req.url).pathname === "/metrics") {
      const text = metricsToPrometheus(server.metricsSnapshot(), { server_id: "main" });
      return new Response(text, {
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});
```

**Cardinality**: Metrics are per-server; add labels sparingly (e.g. `server_id`). Avoid per-session labels to prevent high cardinality.

**Scrape config**: Point Prometheus at `http://host:9090/metrics`. Recommended `scrape_interval`: 15s.

## Idle timeout behavior

- `idleTimeoutMs` (default 60s): connection closed if no activity for this duration.
- Activity: any data sent or received (handshake, datagrams, stream data). QUIC keepalives may extend the window.
- When idle timeout fires: session closes with appropriate code; `closed` promise resolves.
- Slow-reader detection: streams where the peer does not drain within backpressureTimeoutMs are reset (backpressureTimeoutCount incremented).

## Runbook: queued bytes climb
When `queuedBytesGlobal` rises and stays high:
- **Cause**: Slow consumers (clients not reading), too many concurrent streams, or bursty senders.
- **Check**: `streamsActive`, `datagramsIn` vs `datagramsOut` (backlog), `backpressureTimeoutCount`.
- **Actions**:
  - Reduce `maxQueuedBytesPerStream` or `maxQueuedBytesPerSession` to shed slow readers sooner.
  - Lower `maxStreamsPerSessionBidi`/`Uni` to limit per-session concurrency.
  - Enable debug logging to identify high-queue sessions.
- **Scale**: Add server instances and load-balance; reduce per-instance `maxSessions`.

## Runbook: tuning limits safely
- **Start conservative**: `maxSessions` 200–500, `maxQueuedBytesPerStream` 256 KiB.
- **Increase gradually**: After soak/load tests, bump by ~20% and re-run tests.
- **Monitor**: Track `limitExceededCount`, `rateLimitedCount`, `backpressureTimeoutCount` after changes.
- **Avoid**: Setting `maxQueuedBytesGlobal` > 512 MiB without load testing; unbounded growth risks OOM.

## RSS trend analysis

`bun run test:load-addon` writes RSS samples to `tools/load/rss-trend.json` and `rss-trend.csv` (override with `RSS_TREND_OUT`). Format: `ts_ms,rss_mb,sessions,streams`.

**Acceptable growth heuristics** (short load, ~15–30s):
- RSS should plateau or decline after load ends; sustained growth suggests a leak.
- Typical baseline: 50–150 MiB depending on platform. Post-load should return within ~2× baseline.
- If final RSS > 3× initial, triage: run with longer duration, check `sessionTasksActive`/`streamTasksActive` drain.

**Triage steps**:
1. Compare first vs last sample: `rss_mb` delta. If >100 MiB growth over 15s with 4 sessions, investigate.
2. Check `queuedBytesGlobal` in metrics—high queue can inflate RSS.
3. Run `bun run test:soak-addon` with `SOAK_DURATION=300`; if RSS grows linearly, suspect leak.

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

- Client `connect()` fully supported: datagrams, bidi/uni streams, metrics, configurable limits
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
