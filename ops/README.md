# WebTransport production alerts and runbooks

`prometheus-alerts.yml` is an operator-owned starting point, not a claim that
the package runs an HTTP metrics server. Applications must scrape the text from
`metricsToPrometheus(server.metricsSnapshot())` themselves.

The `metric_owner` label is deliberate:

- `webtransport` metrics are emitted by the package's
  `metricsToPrometheus()` converter.
- `application` metrics must be recorded by the service around connect, close,
  server lifecycle, and UDP socket ownership. The native exporter does **not**
  currently emit handshake-failure, close-latency, or socket-count metrics.
- `host` metrics must come from the deployment's process/runtime collector.
  The native exporter does **not** emit RSS or event-loop-lag metrics.

Tune thresholds to the deployed queue budget and measured baseline. The sample
queue threshold is 80% of the default 512 MiB global budget. Validate changes
with `promtool check rules ops/prometheus-alerts.yml` before rollout.

<a id="queue-pressure"></a>
## Queue pressure

Compare `webtransport_queued_bytes_global` with the configured
`maxQueuedBytesGlobal`, then inspect active sessions/streams and slow consumers.
Shed new work before increasing a budget. Page if pressure is accompanied by
timeouts; otherwise reduce per-session/per-stream caps or scale horizontally.

<a id="backpressure-timeouts"></a>
## Backpressure timeouts

Correlate `webtransport_backpressure_timeout_total` with queue pressure and
downstream latency. Identify peers that are not draining, confirm the configured
timeout is intentional, and preserve bounded failure instead of disabling the
deadline.

<a id="rate-limiting"></a>
## Rate limiting

Check source distribution, authentication edge logs, and
`webtransport_limit_exceeded_total`. A broad increase can be legitimate demand
or abuse. Scale only after confirming per-peer isolation; do not raise default
token buckets during an active attack.

<a id="handshake-health"></a>
## Handshake failures and latency

The package exports handshake latency but not total attempts/failures. The host
service must count each connect/accept attempt and terminal failure using
`webtransport_service_handshake_attempts_total` and
`webtransport_service_handshake_failures_total`. Inspect TLS/SNI diagnostics,
certificate validity, UDP reachability, CPU, RTT, and rate limiting. Roll back a
certificate rotation if failures begin at its deployment boundary.

<a id="close-latency"></a>
## Close latency

Instrument elapsed time around the public close/drain operation as the
application-owned Prometheus histogram
`webtransport_service_close_latency_seconds`. When p99 rises, inspect remaining
session/stream tasks and queue bytes, capture stable error codes, and treat a
deadline breach as failed cleanup rather than successful close.

<a id="task-leakage"></a>
## Task leakage

After sessions reach zero, `webtransport_session_tasks_active` and
`webtransport_stream_tasks_active` must also drain. Capture a metrics snapshot,
active handles, and shutdown logs. Reproduce under a bounded close test before
restarting; recurring nonzero tasks are a release-blocking lifecycle defect.

<a id="socket-leakage"></a>
## Socket leakage

The package does not export socket counts. The application must track owned
server UDP sockets as `webtransport_service_udp_sockets_open` and its expected
steady-state count as `webtransport_service_servers_expected`. Confirm listener
ownership, repeated start/close behavior, and OS handle counts. Restart only as
containment; retain evidence for lifecycle diagnosis.

<a id="rss-trend"></a>
## RSS trend

Collect `process_resident_memory_bytes` with the host's process exporter. The
sample rule detects a sustained slope, not a one-time allocation peak. Compare
RSS with queue bytes, session/stream counts, workload phase, and post-close
baseline. Run the exact soak workload long enough to distinguish caching from
unbounded growth.

<a id="event-loop-lag"></a>
## Event-loop lag

The application/runtime collector must publish
`webtransport_host_event_loop_lag_seconds`; it is not emitted by the native
metrics snapshot. Correlate lag with callback volume, CPU saturation, garbage
collection, and queue growth. Preserve callback batching and shed load before
raising deadlines.
