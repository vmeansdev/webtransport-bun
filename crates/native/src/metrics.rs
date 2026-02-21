use napi_derive::napi;

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
}

#[napi(object)]
pub struct SessionMetricsSnapshot {
    pub datagrams_in: u32,
    pub datagrams_out: u32,
    pub streams_active: u32,
    pub queued_bytes: u32,
}
