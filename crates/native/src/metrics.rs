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
}
