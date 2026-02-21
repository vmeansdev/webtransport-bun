//! Parsed limits from createServer options. AGENTS.md defaults.

#[derive(Clone, Debug)]
pub struct Limits {
    pub max_sessions: u64,
    pub max_handshakes_in_flight: u64,
    pub max_streams_per_session_bidi: u64,
    pub max_streams_per_session_uni: u64,
    pub max_streams_global: u64,
    pub max_datagram_size: usize,
    pub max_queued_bytes_global: u64,
    pub max_queued_bytes_per_session: u64,
    pub max_queued_bytes_per_stream: u64,
    pub backpressure_timeout_ms: u64,
    pub handshake_timeout_ms: u64,
    pub idle_timeout_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_sessions: 2000,
            max_handshakes_in_flight: 200,
            max_streams_per_session_bidi: 200,
            max_streams_per_session_uni: 200,
            max_streams_global: 50_000,
            max_datagram_size: 1200,
            max_queued_bytes_global: 512 * 1024 * 1024, // 512 MiB
            max_queued_bytes_per_session: 2 * 1024 * 1024, // 2 MiB
            max_queued_bytes_per_stream: 256 * 1024,    // 256 KiB
            backpressure_timeout_ms: 5000,
            handshake_timeout_ms: 10_000,
            idle_timeout_ms: 60_000,
        }
    }
}

impl Limits {
    pub fn from_json(json: &str) -> Self {
        let mut lim = Self::default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(n) = v.get("maxSessions").and_then(|x| x.as_u64()) {
                lim.max_sessions = n;
            }
            if let Some(n) = v.get("maxHandshakesInFlight").and_then(|x| x.as_u64()) {
                lim.max_handshakes_in_flight = n;
            }
            if let Some(n) = v.get("maxStreamsPerSessionBidi").and_then(|x| x.as_u64()) {
                lim.max_streams_per_session_bidi = n;
            }
            if let Some(n) = v.get("maxStreamsPerSessionUni").and_then(|x| x.as_u64()) {
                lim.max_streams_per_session_uni = n;
            }
            if let Some(n) = v.get("maxStreamsGlobal").and_then(|x| x.as_u64()) {
                lim.max_streams_global = n;
            }
            if let Some(n) = v.get("maxDatagramSize").and_then(|x| x.as_u64()) {
                lim.max_datagram_size = n as usize;
            }
            if let Some(n) = v.get("maxQueuedBytesGlobal").and_then(|x| x.as_u64()) {
                lim.max_queued_bytes_global = n;
            }
            if let Some(n) = v.get("maxQueuedBytesPerSession").and_then(|x| x.as_u64()) {
                lim.max_queued_bytes_per_session = n;
            }
            if let Some(n) = v.get("maxQueuedBytesPerStream").and_then(|x| x.as_u64()) {
                lim.max_queued_bytes_per_stream = n;
            }
            if let Some(n) = v.get("backpressureTimeoutMs").and_then(|x| x.as_u64()) {
                lim.backpressure_timeout_ms = n;
            }
            if let Some(n) = v.get("handshakeTimeoutMs").and_then(|x| x.as_u64()) {
                lim.handshake_timeout_ms = n;
            }
            if let Some(n) = v.get("idleTimeoutMs").and_then(|x| x.as_u64()) {
                lim.idle_timeout_ms = n;
            }
        }
        lim
    }
}
