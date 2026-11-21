# Metrics reference

All metrics are exposed via `server.metricsSnapshot()` and `session.metricsSnapshot()`.

## Prometheus export

Use `metricsToPrometheus(snapshot, labels?)` to produce Prometheus exposition format. See `docs/OPERATIONS.md` for scrape setup.

It emits exactly these series (prefix `webtransport_`, overridable with
`WEBTRANSPORT_METRICS_PREFIX`; `labels` such as `{ serverId }` are added to
every series). Snapshot fields not listed here are available from
`metricsSnapshot()` only.

| Series | Type | Meaning |
|---|---|---|
| `webtransport_sessions_active` | gauge | Current open sessions |
| `webtransport_handshakes_in_flight` | gauge | Handshakes in progress |
| `webtransport_streams_active` | gauge | Active streams |
| `webtransport_session_tasks_active` | gauge | Internal session tasks |
| `webtransport_stream_tasks_active` | gauge | Internal stream tasks |
| `webtransport_queued_bytes_global` | gauge | Queued receive bytes plus queued stream-send bytes, server-wide (see `queuedBytesGlobal`) |
| `webtransport_datagrams_in` | counter | Datagrams received |
| `webtransport_datagrams_out` | counter | Datagrams sent |
| `webtransport_datagrams_dropped` | counter | Datagrams dropped (sum of the drop causes below) |
| `webtransport_backpressure_wait_total` | counter | Datagram sends that found the byte budget full, counted per failed reservation attempt |
| `webtransport_backpressure_timeout_total` | counter | Times the backpressure timeout fired |
| `webtransport_rate_limited_total` | counter | Handshakes, stream opens and incoming datagrams refused by a per-IP rate limit |
| `webtransport_limit_exceeded_total` | counter | Sessions rejected by limits |
| `webtransport_tls_sni_cert_selections_total` | counter | Handshakes served by a hostname-specific SNI cert |
| `webtransport_tls_default_cert_selections_total` | counter | Handshakes served by the default certificate |
| `webtransport_tls_unknown_sni_rejected_total` | counter | Handshakes rejected because SNI matched no configured hostname |
| `webtransport_handshake_latency_seconds` | histogram | Handshake latency |
| `webtransport_datagram_enqueue_latency_seconds` | histogram | Datagram enqueue latency |
| `webtransport_stream_open_latency_seconds` | histogram | Stream open latency |

## Server metrics

| Field | Type | Description |
|-------|------|-------------|
| nowMs | number | Wall-clock time the snapshot was taken, in milliseconds since the Unix epoch. Use it to turn two snapshots' counter deltas into rates. |
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
| queuedBytesGlobal | number | Server-wide sum of two separately capped counters: queued receive bytes (datagrams in both directions, up to `maxQueuedBytesGlobal`, plus stream receives, up to half of it) and queued stream-send bytes (up to half of it). It can therefore read at most 1.5 × `maxQueuedBytesGlobal`, and a workload that exhausts only the stream-receive budget reads 50%. See `docs/OPERATIONS.md`, "Alert rules". |
| backpressureWaitCount | number | Datagram sends that found the session or global byte budget full: incremented on every failed reservation attempt, so one send that waits and retries counts several times, and the attempt that then times out counts here too |
| backpressureTimeoutCount | number | Times server session send_datagram timed out (E_BACKPRESSURE_TIMEOUT) |
| datagramMirrorCalls | number? | Native only: `server.sendDatagramMirror()` calls served. Never counted in `datagramSendsAsync` — the mirror hands JavaScript no promise, so it creates none of the host-loop exposure that counter names. Omitted on WASM. |
| datagramMirrorTargets | number? | Native only: targets those mirror calls **attempted** (an over-cap tail is reported, never attempted, and is not counted here). Delivery is per-session `datagramsOut`, which the mirror increments exactly as every other send path does, so a mirrored datagram is indistinguishable from a looped one there. Omitted on WASM. |
| datagramMirrorPacedCalls | number? | Native only: `server.sendDatagramMirrorPaced()` calls served. Its own meter rather than a share of `datagramMirrorCalls`, because the two envelopes report different things — delivery and admission to the egress pacer's schedule — and a counter that summed them would name neither. Omitted on WASM. |
| datagramMirrorPacedTargets | number? | Native only: targets those paced calls **offered to admission**. `offered − admitted` is the pacer's own `refusedTargets`; delivery stays per-session `datagramsOut`. Omitted on WASM. |
| mirrorReportsDropped | number? | Native only: deferred mirror reports lost to overflow of the fixed 4,096-entry ring `server.readMirrorReports()` drains — the visible cost of polling too slowly. Process-wide, like the pacer's schedule, so a second server in the process reads the same number. `drained + this` reconciles against the pacer's `deferredFailures`. Omitted on WASM. |
| datagramSendsAsync | number? | Native only: datagram sends that fell back to the parking Node-API call. Each one hands JavaScript a promise backed by a ThreadsafeFunction, a reference on the host event loop, so this meters exposure to that class. It is not a latency signal. Omitted on WASM. |
| sessionsClosedByIdle | number? | Native only: sessions the QUIC idle timeout ended (peer went away). Omitted on WASM. |
| sessionsClosedByReap | number? | Native only: sessions this server ended itself while shutting down. Omitted on WASM. |
| sessionsClosedOther | number? | Native only: every other way a session ended (peer close, transport error). Omitted on WASM. |
| nativeAsyncOpsPending | number? | Native only: unsettled Node-API async operations this server still owns. Non-zero after `close()` resolves means the addon still holds the host event loop open. Omitted on WASM. |
| sinksActive | number? | **Experimental.** Native only, process-wide: stream sinks (`openReadSink`) currently running in this process, on client and server streams alike. Returns to 0 once every sink has ended; a sink leak gauge. Omitted on WASM. |
| sinkDroppedRecords | number? | **Experimental.** Native only, process-wide and cumulative: records dropped by sinks in `overflow: "drop-newest"` mode. Each sink also discloses its drops in-band as `drops` records. Omitted on WASM. |
| nativeSessionRegistryEntries, nativeTrackedTasks, nativeRateLimitEntries, nativeBidiHandlesLive, nativeUniSendHandlesLive, nativeUniRecvHandlesLive | number? | Native only: live sizes of the addon's registries and handle tables. Use them as leak gauges: after load stops they should return to their idle values. Omitted on WASM. |
| rateLimitedCount | number | Refusals by any per-IP rate limit: handshakes (token bucket and per-IP/per-prefix burst), stream opens, and incoming datagrams dropped by the datagram ingress bucket (also in `datagramsDroppedRateLimited`) |
| limitExceededCount | number | Sessions rejected (maxSessions, maxHandshakesInFlight) |
| sniCertSelections | number | Handshakes served by hostname-specific SNI certificates |
| defaultCertSelections | number | Handshakes served by the default certificate |
| unknownSniRejectedCount | number | Handshakes rejected because SNI did not match a configured hostname |

## Session metrics

`session.metricsSnapshot()` on a server or client session returns a
`SessionMetricsSnapshot`:

| Field | Type | Description |
|-------|------|-------------|
| datagramsIn | number | Datagrams this session received |
| datagramsOut | number | Datagrams this session sent |
| streamsActive | number | Open streams (bidi + uni) on this session |
| queuedBytes | number | Server session: this session's queued receive bytes plus queued stream-send bytes, the per-session counterpart of `queuedBytesGlobal` (so it can exceed `maxQueuedBytesPerSession` the same way). Client session: the queued bytes charged to its datagram budget. |

The session counters are cumulative for the session's lifetime and reset with
it; they are not labelled per session in `metricsToPrometheus()` (that would
be unbounded cardinality).

## Internal counters (not public)

The native addon also counts things that only a measurement campaign can
interpret. Before 1.0 some of them sat on `MetricsSnapshot`; they are **not**
part of the public snapshot. The public `metricsSnapshot()` strips them at
runtime, and `metricsToPrometheus()` never emitted them. Harnesses read them
through the unstable `__TESTING__.serverInternals(server).metricsSnapshot()`
(see `docs/SPEC.md`, "Semver rules"). No compatibility promise applies:

- `datagramReflect*` (14 fields): the internal datagram reflector.
- `udpSendBatch*` (8 fields): the unsupported
  `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH` path; all zero while it is off.
- `datagramPumpsSpawned`, `datagramPumpsLive`: the wtransport fork's
  per-connection datagram pump tasks.
- `quicSessions`, `quicUdpDatagramsReceived`, `quicUdpDatagramsSent`,
  `quicDatagramFramesReceived`, `quicDatagramFramesSent`, `quicPacketsSent`,
  `quicPacketsLost`: quinn counters summed over live connections. They are a
  boundary sample for loss attribution, not lifetime totals.

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
- Sensitive identifiers (`sessionId`, `peerIp`, `peerPort`) are omitted by default.
  Debug mode (`debug: true`) includes them.

## Debug mode

Set `debug: true` and provide a log hook that emits all levels. This turns native
redaction off for local debugging: messages are logged in full and events carry
`sessionId`, `peerIp` and `peerPort`. Don't enable it where logs leave a trusted
environment:

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
