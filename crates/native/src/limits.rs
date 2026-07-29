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
    /// Keep-alive ping interval. `None` disables keep-alive (the default).
    pub keep_alive_interval_ms: Option<u64>,
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
            keep_alive_interval_ms: None,
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
            if let Some(n) = v.get("keepAliveIntervalMs").and_then(|x| x.as_u64()) {
                // 0 means disabled, same as omitting the field.
                lim.keep_alive_interval_ms = if n > 0 { Some(n) } else { None };
            }
        }
        lim
    }

    /// Effective keep-alive interval: clamped to at most idle_timeout/3 so
    /// pings always land well before the idle deadline (same rule as the
    /// wasm backend), floored at 1ms.
    pub fn effective_keep_alive_interval_ms(&self) -> Option<u64> {
        let interval = self.keep_alive_interval_ms?;
        let cap = (self.idle_timeout_ms / 3).max(1);
        Some(interval.min(cap))
    }
}

#[cfg(test)]
mod tests {
    use super::Limits;

    #[test]
    fn keep_alive_disabled_by_default_and_on_zero() {
        assert_eq!(Limits::default().effective_keep_alive_interval_ms(), None);
        let lim = Limits::from_json(r#"{"keepAliveIntervalMs":0}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), None);
    }

    #[test]
    fn keep_alive_clamped_to_third_of_idle_timeout() {
        let lim = Limits::from_json(r#"{"idleTimeoutMs":3000,"keepAliveIntervalMs":5000}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(1000));

        let lim = Limits::from_json(r#"{"idleTimeoutMs":3000,"keepAliveIntervalMs":200}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(200));

        // Degenerate idle timeout still yields a nonzero interval.
        let lim = Limits::from_json(r#"{"idleTimeoutMs":2,"keepAliveIntervalMs":100}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(1));
    }
}
