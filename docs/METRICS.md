# Metrics reference

All metrics are exposed via `server.metricsSnapshot()` and `session.metricsSnapshot()`.

## Prometheus export

Use `metricsToPrometheus(snapshot, labels?)` to produce Prometheus exposition format. See `docs/OPERATIONS.md` for scrape setup.

## Server metrics

| Field | Type | Description |
|-------|------|-------------|
| sessionsActive | number | Current open sessions |
| handshakesInFlight | number | Handshakes in progress |
| streamsActive | number | Active streams (bidi + uni) |
| sessionTasksActive | number | Internal session tasks |
| streamTasksActive | number | Internal stream tasks |
| datagramsIn | number | Datagrams received |
| datagramsOut | number | Datagrams sent |
| datagramsDropped | number | Datagrams dropped (oversize, rate limit, or budget) |
| queuedBytesGlobal | number | Bytes queued globally |
| backpressureWaitCount | number | Times server session send waited on backpressure (incremented on timeout) |
| backpressureTimeoutCount | number | Times server session send_datagram timed out (E_BACKPRESSURE_TIMEOUT) |
| rateLimitedCount | number | Sessions rejected by per-IP/per-prefix rate limit |
| limitExceededCount | number | Sessions rejected (maxSessions, maxHandshakesInFlight) |

## Latency histograms (P3.1)

Histograms are emitted as Prometheus `histogram` type (`_bucket`, `_count`, `_sum`). Buckets (seconds): 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, +Inf.

| Field | Description | SLO target (in-region) |
|-------|-------------|------------------------|
| handshakeLatency | Accept start to completion | p99 < 300ms |
| datagramEnqueueLatency | Server send_datagram() duration | p99 < 10ms |
| streamOpenLatency | createBidiStream / createUniStream duration | p99 < 20ms |

Use `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m]))` for p99.

## Drop reasons (datagramsDropped)

The single `datagramsDropped` counter aggregates:

- **Oversize**: Datagram > maxDatagramSize
- **Budget**: Global or per-session queued-bytes budget exceeded
- **Rate limit**: Per-IP datagram rate exceeded (future)

For finer-grained attribution, monitor `rateLimitedCount` and `limitExceededCount` alongside `datagramsDropped`.

## Structured logs

Use the `log` option for structured events:

```ts
createServer({
  port: 4433,
  tls: { certPem, keyPem },
  onSession: (s) => { ... },
  log: (event) => {
    console.log(JSON.stringify({
      ...event,
      ts: Date.now(),
    }));
  },
});
```

Security default:
- Native log payloads are **redacted by default** (`msg` may be sanitized/omitted).
- Sensitive identifiers (`sessionId`, `peerIp`, `peerPort`) are omitted by default and in debug mode.

## Debug mode

Set `debug: true` and provide a log hook that emits all levels. This opts in to richer
native diagnostics for local debugging, while keeping sensitive identifiers redacted:

```ts
createServer({
  debug: true,
  log: (e) => {
    if (e.level === 'debug' || e.level === 'error') {
      console.error(JSON.stringify(e));
    }
  },
  ...
});
```

No rebuild required; enable at runtime.
