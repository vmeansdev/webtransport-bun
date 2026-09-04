use napi_derive::napi;

/// Latency histogram snapshot for Prometheus export (P3.1).
#[napi(object)]
pub struct HistogramSnapshot {
    /// Bucket upper bounds (le) in seconds. Last is 10.0; +Inf = count.
    pub le: Vec<f64>,
    /// Cumulative counts per bucket (index matches le).
    pub cumulative_count: Vec<f64>,
    /// Total observations.
    pub count: f64,
    /// Sum of all observed durations in seconds.
    pub sum_secs: f64,
}

#[napi(object)]
pub struct ReflectSendErrorsSnapshot {
    pub not_connected: f64,
    pub unsupported_by_peer: f64,
    pub too_large: f64,
}

#[napi(object)]
pub struct ServerMetricsSnapshot {
    pub now_ms: f64,
    pub sessions_active: u32,
    pub session_tasks_active: u32,
    pub stream_tasks_active: u32,
    pub handshakes_in_flight: u32,
    pub streams_active: u32,
    pub datagrams_in: f64,
    pub datagrams_out: f64,
    pub datagrams_dropped: f64,
    /// Present on native snapshots. Omit on WASM (do not zero).
    pub datagrams_dropped_rate_limited: Option<f64>,
    pub datagrams_dropped_too_large: Option<f64>,
    pub datagrams_dropped_queue_global: Option<f64>,
    pub datagrams_dropped_queue_session: Option<f64>,
    /// Native ingest only. Park events when session slack cannot fit maxDatagramSize.
    pub datagrams_skipped_queue_full: Option<f64>,
    pub queued_bytes_global: f64,
    pub backpressure_wait_count: f64,
    pub backpressure_timeout_count: f64,
    /// Native only. Datagram sends that had to take the parking N-API path and
    /// therefore created a host event-loop reference for their promise.
    pub datagram_sends_async: Option<f64>,
    /// Native only. Mirror calls served — one payload fanned out to many
    /// sessions across a single Node-API crossing. Never counted in
    /// `datagram_sends_async`: the mirror creates no promise.
    pub datagram_mirror_calls: Option<f64>,
    /// Native only. Targets those mirror calls attempted.
    pub datagram_mirror_targets: Option<f64>,
    /// Native only. `sendDatagramMirrorPaced()` calls served. Separate from
    /// `datagram_mirror_calls` because the two envelopes mean different things:
    /// one reports delivery, the other admission to the pacer's schedule.
    pub datagram_mirror_paced_calls: Option<f64>,
    /// Native only. Targets those paced calls offered to admission.
    pub datagram_mirror_paced_targets: Option<f64>,
    /// Native only. Deferred mirror reports lost to ring overflow. Process-wide,
    /// like the pacer's schedule: `drained + this == deferredFailures`.
    pub mirror_reports_dropped: Option<f64>,
    /// Native only. Datagrams the per-server reflector matched.
    pub datagram_reflect_hits: Option<f64>,
    /// Native only. Reflected replies the transport accepted.
    pub datagram_reflect_sent: Option<f64>,
    /// Native only. Reflected replies dropped because the sender queue was full.
    pub datagram_reflect_queue_full: Option<f64>,
    /// Native only. Reflected replies the transport refused (dropped, never retried).
    pub datagram_reflect_send_errors: Option<f64>,
    /// Native only, process-wide. Cross-connection UDP send batching
    /// (`WEBTRANSPORT_NATIVE_UDP_SEND_BATCH`): sendmmsg calls, datagrams sent
    /// through them, datagrams sent one at a time instead (unsupported shape
    /// or platform), datagrams dropped because the batch ring was full, send
    /// errors, and the largest batch flushed. All zero while the knob is off.
    pub udp_send_batch_calls: Option<f64>,
    pub udp_send_batch_messages: Option<f64>,
    pub udp_send_batch_fallback: Option<f64>,
    pub udp_send_batch_dropped: Option<f64>,
    pub udp_send_batch_errors: Option<f64>,
    pub udp_send_batch_max_batch: Option<f64>,
    pub datagram_reflect_send_errors_by_reason: Option<ReflectSendErrorsSnapshot>,
    /// Native only. Receive-to-reflection duration. Present when any observation.
    pub datagram_reflect_hold: Option<HistogramSnapshot>,
    pub rate_limited_count: f64,
    pub limit_exceeded_count: f64,
    /// Native only. Sessions the QUIC idle timeout ended.
    pub sessions_closed_by_idle: Option<f64>,
    /// Native only. Sessions this server ended itself on shutdown.
    pub sessions_closed_by_reap: Option<f64>,
    /// Native only. Every other way a session ended (peer close, transport error).
    pub sessions_closed_other: Option<f64>,
    /// Diagnostic count of unsettled N-API async operations owned by this
    /// server. Non-zero after `close()` resolves means the host event loop is
    /// still referenced by this addon.
    pub native_async_ops_pending: u32,
    pub sni_cert_selections: f64,
    pub default_cert_selections: f64,
    pub unknown_sni_rejected_count: f64,
    /// Diagnostic count of native sessions still owned by this server.
    pub native_session_registry_entries: u32,
    /// Diagnostic count of tracked native tasks still owned by this server.
    pub native_tracked_tasks: u32,
    /// Diagnostic count of rate-limit entries still owned by this server.
    pub native_rate_limit_entries: u32,
    /// Diagnostic count of live JS-visible native bidi stream handles.
    pub native_bidi_handles_live: u32,
    /// Diagnostic count of live JS-visible native unidirectional send handles.
    pub native_uni_send_handles_live: u32,
    /// Diagnostic count of live JS-visible native unidirectional receive handles.
    pub native_uni_recv_handles_live: u32,
    /// Handshake latency (accept start to completion). Present when any observation.
    pub handshake_latency: Option<HistogramSnapshot>,
    /// Datagram send enqueue latency. Present when any observation.
    pub datagram_enqueue_latency: Option<HistogramSnapshot>,
    /// Stream open latency (create_bidi/create_uni). Present when any observation.
    pub stream_open_latency: Option<HistogramSnapshot>,
    /// Native only. Connections that were live when this snapshot was taken and
    /// therefore contributed to the `quic_*` sums below.
    pub quic_sessions: Option<f64>,
    /// Native only. quinn transport counters summed over those live connections.
    /// A boundary sample, not a lifetime total: a closed session's counters are
    /// gone with it, so two boundaries may only be differenced across a window
    /// whose session set is stable. Together with the application's own receive
    /// tally these discriminate NIC-to-quinn loss (`quic_udp_datagrams_received`
    /// short of what the peer sent) from quinn-to-application loss
    /// (`quic_datagram_frames_received` short of what the app counted).
    pub quic_udp_datagrams_received: Option<f64>,
    pub quic_udp_datagrams_sent: Option<f64>,
    pub quic_datagram_frames_received: Option<f64>,
    pub quic_datagram_frames_sent: Option<f64>,
    pub quic_packets_sent: Option<f64>,
    pub quic_packets_lost: Option<f64>,
}

/// Process-wide native stream-handle counts used by post-close residency
/// diagnostics after the owning ServerHandle has been released.
#[napi(object)]
pub struct NativeStreamHandlesSnapshot {
    pub bidi_handles_live: u32,
    pub uni_send_handles_live: u32,
    pub uni_recv_handles_live: u32,
}

/// The QUIC flow-control snapshot a given limits JSON resolves to. Diagnostic
/// only: it reports what the transport would be configured with, so callers can
/// see whether an explicit window took effect or a derived one did.
#[napi(object)]
pub struct TransportWindowsSnapshot {
    pub stream_receive_window: f64,
    pub receive_window: f64,
    pub send_window: f64,
    pub datagram_channel_capacity: f64,
}

/// Real QUIC transport stats from quinn (wire-level, not facade tallies).
#[napi(object)]
pub struct QuicConnectionStats {
    pub rtt_ms: f64,
    /// UDP payload bytes sent/received on the connection (wire bytes).
    pub bytes_sent: f64,
    pub bytes_received: f64,
    /// QUIC packets sent/lost. `packets_received` is the legacy receive field:
    /// the pinned quinn release exposes received UDP datagrams, not a separate
    /// received QUIC-packet total, so it aliases `udp_datagrams_received`.
    pub packets_sent: f64,
    pub packets_received: f64,
    pub packets_lost: f64,
    /// Application DATAGRAM frames emitted/consumed by QUIC.
    pub datagram_frames_sent: f64,
    pub datagram_frames_received: f64,
    /// UDP datagrams emitted/consumed by QUIC. These remain distinct from
    /// application DATAGRAM frames because one UDP datagram can carry other
    /// frame classes and transport batching can change their relationship.
    pub udp_datagrams_sent: f64,
    pub udp_datagrams_received: f64,
    /// Current max datagram payload size for this path (None until known).
    pub max_datagram_size: Option<u32>,
}

fn quic_stats_from_snapshot(
    stats: &wtransport::quinn::ConnectionStats,
    max_datagram_size: Option<usize>,
) -> QuicConnectionStats {
    QuicConnectionStats {
        rtt_ms: stats.path.rtt.as_secs_f64() * 1000.0,
        bytes_sent: stats.udp_tx.bytes as f64,
        bytes_received: stats.udp_rx.bytes as f64,
        packets_sent: stats.path.sent_packets as f64,
        packets_received: stats.udp_rx.datagrams as f64,
        packets_lost: stats.path.lost_packets as f64,
        datagram_frames_sent: stats.frame_tx.datagram as f64,
        datagram_frames_received: stats.frame_rx.datagram as f64,
        udp_datagrams_sent: stats.udp_tx.datagrams as f64,
        udp_datagrams_received: stats.udp_rx.datagrams as f64,
        max_datagram_size: max_datagram_size.map(|n| n as u32),
    }
}

/// Per-server sums of quinn transport counters over the connections that were
/// live when the snapshot was taken.
///
/// Semantics: LIVE connections only. quinn owns its stats per connection, so a
/// session that has already closed takes its counters with it — this is a
/// boundary sample, not a lifetime counter. Differencing two boundaries is only
/// valid while the session set is stable (a steady measurement window); across
/// a window where sessions churn, the delta undercounts by whatever the
/// departed connections carried.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct QuicAggregate {
    pub sessions: u64,
    pub udp_datagrams_received: u64,
    pub udp_datagrams_sent: u64,
    pub datagram_frames_received: u64,
    pub datagram_frames_sent: u64,
    pub packets_sent: u64,
    pub packets_lost: u64,
}

impl QuicAggregate {
    /// Fold one connection's raw quinn stats into the running sums.
    pub fn accumulate(&mut self, stats: &wtransport::quinn::ConnectionStats) {
        self.sessions = self.sessions.saturating_add(1);
        self.udp_datagrams_received = self
            .udp_datagrams_received
            .saturating_add(stats.udp_rx.datagrams);
        self.udp_datagrams_sent = self
            .udp_datagrams_sent
            .saturating_add(stats.udp_tx.datagrams);
        self.datagram_frames_received = self
            .datagram_frames_received
            .saturating_add(stats.frame_rx.datagram);
        self.datagram_frames_sent = self
            .datagram_frames_sent
            .saturating_add(stats.frame_tx.datagram);
        self.packets_sent = self.packets_sent.saturating_add(stats.path.sent_packets);
        self.packets_lost = self.packets_lost.saturating_add(stats.path.lost_packets);
    }
}

pub fn quic_stats_from_conn(conn: &wtransport::Connection) -> QuicConnectionStats {
    let stats = conn.quic_connection().stats();
    quic_stats_from_snapshot(&stats, conn.max_datagram_size())
}

#[napi(object)]
pub struct ServerTlsSnapshot {
    pub sni_server_names: Vec<String>,
    pub unknown_sni_policy: String,
}

#[napi(object)]
pub struct SessionMetricsSnapshot {
    pub datagrams_in: f64,
    pub datagrams_out: f64,
    pub streams_active: u32,
    pub queued_bytes: f64,
}

/// Client pool metrics (debug/test). Present when allowPooling is used.
#[napi(object)]
pub struct ClientPoolMetricsSnapshot {
    pub hits: u32,
    pub misses: u32,
    pub evict_idle: u32,
    pub evict_broken: u32,
}

#[cfg(test)]
mod tests {
    use super::quic_stats_from_snapshot;

    #[test]
    fn quic_stats_snapshot_maps_raw_datagram_stages_exactly() {
        let mut raw = wtransport::quinn::ConnectionStats::default();
        raw.path.rtt = std::time::Duration::from_micros(2_500);
        raw.frame_tx.datagram = 17;
        raw.frame_rx.datagram = 19;
        raw.udp_tx.datagrams = 23;
        raw.udp_rx.datagrams = 29;
        raw.udp_tx.bytes = 31;
        raw.udp_rx.bytes = 37;
        raw.path.sent_packets = 41;
        raw.path.lost_packets = 43;

        let mapped = quic_stats_from_snapshot(&raw, Some(1_200));

        assert_eq!(mapped.datagram_frames_sent, 17.0);
        assert_eq!(mapped.datagram_frames_received, 19.0);
        assert_eq!(mapped.udp_datagrams_sent, 23.0);
        assert_eq!(mapped.udp_datagrams_received, 29.0);
        assert_eq!(mapped.bytes_sent, 31.0);
        assert_eq!(mapped.bytes_received, 37.0);
        assert_eq!(mapped.packets_sent, 41.0);
        assert_eq!(mapped.packets_lost, 43.0);
        assert_eq!(mapped.max_datagram_size, Some(1_200));
        assert_eq!(mapped.rtt_ms, 2.5);
    }

    #[test]
    fn quic_aggregate_sums_every_stage_over_two_sessions() {
        let mut a = wtransport::quinn::ConnectionStats::default();
        a.udp_rx.datagrams = 100;
        a.udp_tx.datagrams = 90;
        a.frame_rx.datagram = 80;
        a.frame_tx.datagram = 70;
        a.path.sent_packets = 60;
        a.path.lost_packets = 5;
        let mut b = wtransport::quinn::ConnectionStats::default();
        b.udp_rx.datagrams = 1;
        b.udp_tx.datagrams = 2;
        b.frame_rx.datagram = 3;
        b.frame_tx.datagram = 4;
        b.path.sent_packets = 6;
        b.path.lost_packets = 7;

        let mut agg = super::QuicAggregate::default();
        assert_eq!(agg, super::QuicAggregate::default());
        agg.accumulate(&a);
        agg.accumulate(&b);

        assert_eq!(agg.sessions, 2);
        assert_eq!(agg.udp_datagrams_received, 101);
        assert_eq!(agg.udp_datagrams_sent, 92);
        assert_eq!(agg.datagram_frames_received, 83);
        assert_eq!(agg.datagram_frames_sent, 74);
        assert_eq!(agg.packets_sent, 66);
        assert_eq!(agg.packets_lost, 12);
    }
}
