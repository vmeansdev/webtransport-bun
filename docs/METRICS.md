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
| datagramsDropped | number | Inbound datagrams dropped at ingest (oversize, datagram rate-limit, or queued-bytes budget). Native identity: this equals the four reason fields below when those fields are present. |
| datagramsDroppedTooLarge | number? | Native ingest: datagram larger than `maxDatagramSize`. Omitted on WASM. |
| datagramsDroppedQueueSession | number? | Native ingest: per-session queued-bytes budget. Omitted on WASM. |
| datagramsSkippedQueueFull | number? | Native ingest: times the session task parked `receive_datagram` because remaining session slack could not fit `maxDatagramSize`. Park events, not datagrams. Not part of the drop-reason identity. Omitted on WASM. |
| datagramsDroppedQueueGlobal | number? | Native ingest: global queued-bytes budget. Omitted on WASM. |
| datagramsDroppedRateLimited | number? | Native ingest: per-IP datagram ingress rate limit. Also counted in `rateLimitedCount`. Omitted on WASM. |
| queuedBytesGlobal | number | Bytes queued globally |
| backpressureWaitCount | number | Times server session send waited on backpressure (incremented on timeout) |
| backpressureTimeoutCount | number | Times server session send_datagram timed out (E_BACKPRESSURE_TIMEOUT) |
| datagramMirrorCalls | number? | Native only: `server.sendDatagramMirror()` calls served. Never counted in `datagramSendsAsync` — the mirror hands JavaScript no promise, so it creates none of the host-loop exposure that counter names. Omitted on WASM. |
| datagramMirrorTargets | number? | Native only: targets those mirror calls **attempted** (an over-cap tail is reported, never attempted, and is not counted here). Delivery is per-session `datagramsOut`, which the mirror increments exactly as every other send path does, so a mirrored datagram is indistinguishable from a looped one there. Omitted on WASM. |
| datagramMirrorPacedCalls | number? | Native only: `server.sendDatagramMirrorPaced()` calls served. Its own meter rather than a share of `datagramMirrorCalls`, because the two envelopes report different things — delivery and admission to the egress pacer's schedule — and a counter that summed them would name neither. Omitted on WASM. |
| datagramMirrorPacedTargets | number? | Native only: targets those paced calls **offered to admission**. `offered − admitted` is the pacer's own `refusedTargets`; delivery stays per-session `datagramsOut`. Omitted on WASM. |
| mirrorReportsDropped | number? | Native only: deferred mirror reports lost to overflow of the fixed 4,096-entry ring `server.readMirrorReports()` drains — the visible cost of polling too slowly. Process-wide, like the pacer's schedule, so a second server in the process reads the same number. `drained + this` reconciles against the pacer's `deferredFailures`. Omitted on WASM. |
| rateLimitedCount | number | Sessions rejected by per-IP/per-prefix rate limit |
| limitExceededCount | number | Sessions rejected (maxSessions, maxHandshakesInFlight) |
| sniCertSelections | number | Handshakes served by hostname-specific SNI certificates |
| defaultCertSelections | number | Handshakes served by the default certificate |
| unknownSniRejectedCount | number | Handshakes rejected because SNI did not match a configured hostname |

## WASM governor snapshot (`governor_snapshot_json`)

In addition to the shared governor fields (`sessionsActive`, queued bytes, rate-limit counters), the wasm endpoint snapshot includes:

| Field | Type | Description |
|-------|------|-------------|
| wtSessionsActive | number | Live primary/extra WT sessions + client pending CONNECTs (excludes server unlatched admitted CONNECTs that still count toward admission occupied) |
| sessionClosedCount | number | Cumulative `SessionClosed` events (extra-session / timed-out CONNECT) |

Per-connection `has0Rtt` / `accepted0Rtt` remain on connection getters (not rolled into this snapshot).

## Latency histograms (P3.1)

Histograms are emitted as Prometheus `histogram` type (`_bucket`, `_count`, `_sum`). Buckets (seconds): 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, +Inf.

| Field | Description | SLO target (in-region) |
|-------|-------------|------------------------|
| handshakeLatency | Accept start to completion | p99 < 300ms |
| datagramEnqueueLatency | Server send_datagram() duration | p99 < 10ms |
| streamOpenLatency | createBidiStream / createUniStream duration | p99 < 20ms |

Use `histogram_quantile(0.99, rate(webtransport_handshake_latency_seconds_bucket[5m]))` for p99.

## Drop reasons (datagramsDropped)

Native snapshots expose four optional ingest-reason fields. When they are
present:

`datagramsDropped == datagramsDroppedTooLarge + datagramsDroppedQueueSession + datagramsDroppedQueueGlobal + datagramsDroppedRateLimited`

- **datagramsDroppedTooLarge**: datagram larger than `maxDatagramSize`
- **datagramsDroppedQueueSession**: per-session queued-bytes budget
- **datagramsDroppedQueueGlobal**: global queued-bytes budget
- **datagramsDroppedRateLimited**: per-IP datagram ingress rate limit (also counted in `rateLimitedCount`)

WASM omits the reason fields. Do not treat omitted-or-undefined reasons as
zero, and do not use mixed `rateLimitedCount` (handshakes + streams + datagrams)
to attribute datagram drops. Prometheus `datagrams_dropped` remains the sum.

`datagramsSkippedQueueFull` is a separate native counter of **park events**
(ingest did not call `receive_datagram` because remaining per-session slack
could not fit `maxDatagramSize`). It is not a fifth drop reason and is omitted
on WASM. Do not treat omit as zero.

Send-path queued-bytes waits time out as `E_BACKPRESSURE_TIMEOUT` and do **not**
increment `datagramsDropped`.

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
