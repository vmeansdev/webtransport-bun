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
    pub datagrams_in: u32,
    pub datagrams_out: u32,
    pub datagrams_dropped: u32,
    pub queued_bytes_global: u32,
    pub backpressure_wait_count: u32,
    pub backpressure_timeout_count: u32,
    pub rate_limited_count: u32,
    pub limit_exceeded_count: u32,
    /// Handshake latency (accept start to completion). Present when any observation.
    pub handshake_latency: Option<HistogramSnapshot>,
    /// Datagram send enqueue latency. Present when any observation.
    pub datagram_enqueue_latency: Option<HistogramSnapshot>,
    /// Stream open latency (create_bidi/create_uni). Present when any observation.
    pub stream_open_latency: Option<HistogramSnapshot>,
}

#[napi(object)]
pub struct SessionMetricsSnapshot {
    pub datagrams_in: u32,
    pub datagrams_out: u32,
    pub streams_active: u32,
    pub queued_bytes: u32,
}

/// Client pool metrics (debug/test). Present when allowPooling is used.
#[napi(object)]
pub struct ClientPoolMetricsSnapshot {
    pub hits: u32,
    pub misses: u32,
    pub evict_idle: u32,
    pub evict_broken: u32,
}
