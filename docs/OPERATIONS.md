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

## Dashboards (P3.1)

Recommended panels for Grafana (or equivalent):

| Panel | Query | Unit |
|-------|-------|------|
| Sessions active | `webtransport_sessions_active` | short |
| Handshake p99 | `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m]))` | s |
| Datagram enqueue p99 | `histogram_quantile(0.99, rate(webtransport_datagram_enqueue_latency_seconds_bucket[5m]))` | s |
| Stream open p99 | `histogram_quantile(0.99, rate(webtransport_stream_open_latency_seconds_bucket[5m]))` | s |
| Queued bytes | `webtransport_queued_bytes_global` | bytes |
| Backpressure timeouts | `rate(webtransport_backpressure_timeout_total[5m])` | 1/s |
| Rate limited | `rate(webtransport_rate_limited_total[5m])` | 1/s |
| Limit exceeded | `rate(webtransport_limit_exceeded_total[5m])` | 1/s |

## Alert rules and paging thresholds

Configure Prometheus alerts. Severity: **page** for Sev-2, **ticket** for Sev-3.

| Alert | Condition | Severity | Runbook |
|-------|-----------|----------|---------|
| WebTransportHandshakeP99High | `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m])) > 0.3` | page | Handshake latency |
| WebTransportDatagramEnqueueP99High | `histogram_quantile(0.99, rate(webtransport_datagram_enqueue_latency_seconds_bucket[5m])) > 0.01` | page | Datagram enqueue |
| WebTransportStreamOpenP99High | `histogram_quantile(0.99, rate(webtransport_stream_open_latency_seconds_bucket[5m])) > 0.02` | page | Stream open latency |
| WebTransportQueuedBytesHigh | `webtransport_queued_bytes_global > 0.8 * maxQueuedBytesGlobal` | ticket | Queued bytes climb |
| WebTransportBackpressureTimeouts | `rate(webtransport_backpressure_timeout_total[5m]) > 1` | ticket | Backpressure timeouts |
| WebTransportRateLimited | `rate(webtransport_rate_limited_total[5m]) > 10` | ticket | Rate limited |
| WebTransportLimitExceeded | `rate(webtransport_limit_exceeded_total[5m]) > 5` | ticket | Limit exceeded |

Replace `0.8 * maxQueuedBytesGlobal` with your configured value (e.g. `419430400` for 400 MiB of 512 MiB).

## Idle timeout behavior

- `idleTimeoutMs` (default 60s): connection closed if no activity for this duration.
- Activity: any data sent or received (handshake, datagrams, stream data). QUIC keepalives may extend the window.
- When idle timeout fires: session closes with appropriate code; `closed` promise resolves.
- Slow-reader detection: streams where the peer does not drain within backpressureTimeoutMs are reset (backpressureTimeoutCount incremented).

## Runbook: handshake p99 high

When `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m])) > 0.3`:
- **Cause**: TLS/QUIC handshake slow; CPU saturation; network RTT spike; certificate validation.
- **Check**: `handshakesInFlight`, CPU, network latency to clients.
- **Actions**: Scale out; reduce `maxHandshakesInFlight` to shed load; verify cert chain not oversized.

## Runbook: datagram enqueue p99 high

When datagram enqueue p99 > 10ms:
- **Cause**: QUIC send buffer full; backpressure from slow consumers; CPU contention.
- **Check**: `queuedBytesGlobal`, `backpressureTimeoutCount`, `streamsActive`.
- **Actions**: Reduce `maxQueuedBytesPerStream`; lower `backpressureTimeoutMs`; scale out.

## Runbook: stream open p99 high

When stream open p99 > 20ms:
- **Cause**: QUIC flow control; rate limits; global stream cap saturation.
- **Check**: `streamsActive`, `limitExceededCount`, `rateLimitedCount`.
- **Actions**: Increase `maxStreamsPerSessionBidi`/`Uni` if within capacity; verify rate limits not too strict.

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

## Diagnostics modes

- **Default (recommended for production):** native diagnostics are redacted/minimal.
- **Debug mode:** set `createServer({ debug: true, ... })` to enable richer native diagnostics.
  Sensitive identifiers remain redacted; use only in trusted environments.

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

---

## Runbook: Rollback to known-good release

Use when a release introduces critical regressions (crashes, data corruption, security issues) and reverting code is not immediately feasible.

### Trigger conditions

- Critical bug or security issue in the current release discovered post-publish
- Production incidents traced to the latest release
- Decision by maintainers to revert users to a previous stable version

### Prerequisites

- GitHub CLI (`gh`) installed (for local drill) or access to run the `rollback` workflow
- Identify the known-good release tag (e.g. `v0.1.0`) from release history

### Option A: CI workflow (recommended)

1. Open **Actions → rollback** workflow.
2. Click **Run workflow**.
3. Enter the rollback target tag (e.g. `v0.1.0`).
4. Run the workflow.
5. On success: the job summary contains the exact pin command. Proceed to **Operator action** below.

### Option B: Local script

```bash
./scripts/rollback-drill.sh v0.1.0
```

Requires `gh` CLI authenticated. Verifies artifact checksums and prints the runbook.

### Operator action (after validation)

Instruct users to pin to the validated release:

```bash
bun add @webtransport-bun/webtransport@<VERSION>
```

Example: for rollback target `v0.1.0`, users run:

```bash
bun add @webtransport-bun/webtransport@0.1.0
```

### Expected validation signals

- **Checksum verification passes**: `shasum -a 256 -c SHA256SUMS` exits 0
- **Assets present**: `webtransport-native.*.node` for linux-x64, darwin-arm64, darwin-x64
- **SHA256SUMS exists**: Required; releases before the combined checksum change may not have it (run a new release first if needed)

### Follow-up

- Open an issue to track the regression and fix
- Consider deprecating the bad release on npm: `npm deprecate @webtransport-bun/webtransport@<bad_version> "Critical regression; use <known_good_version>"`
- Cut a patch release once the fix is merged and tested
