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
| backpressureWaitCount | number | Times senders waited on backpressure |
| backpressureTimeoutCount | number | Times backpressure timeout fired (E_BACKPRESSURE_TIMEOUT) |
| rateLimitedCount | number | Sessions rejected by per-IP/per-prefix rate limit |
| limitExceededCount | number | Sessions rejected (maxSessions, maxHandshakesInFlight) |

## Drop reasons (datagramsDropped)

The single `datagramsDropped` counter aggregates:

- **Oversize**: Datagram > maxDatagramSize
- **Budget**: Global or per-session queued-bytes budget exceeded
- **Rate limit**: Per-IP datagram rate exceeded (future)

For finer-grained attribution, monitor `rateLimitedCount` and `limitExceededCount` alongside `datagramsDropped`.

## Structured logs

Use the `log` option with correlation fields:

```ts
createServer({
  port: 4433,
  tls: { certPem, keyPem },
  onSession: (s) => { ... },
  log: (event) => {
    console.log(JSON.stringify({
      ...event,
      sessionId: event.sessionId,
      peerIp: event.peerIp,
      peerPort: event.peerPort,
    }));
  },
});
```

Security default:
- Native log payloads are **redacted by default** (`msg`, `sessionId`, `peerIp`, `peerPort` may be sanitized/omitted).

## Debug mode

Set `debug: true` and provide a log hook that emits all levels. This opts in to detailed
native diagnostics (including panic payload details) for local debugging:

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
