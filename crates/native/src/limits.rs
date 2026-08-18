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
    /// QUIC per-stream receive window, in bytes. `None` derives it from
    /// `max_queued_bytes_per_stream` (the shipped behaviour).
    pub stream_receive_window: Option<u64>,
    /// QUIC connection receive window, in bytes. `None` derives it from
    /// `max_queued_bytes_per_session` (the shipped behaviour).
    pub receive_window: Option<u64>,
    /// QUIC connection send window, in bytes. `None` derives it from
    /// `max_queued_bytes_per_session` (the shipped behaviour).
    pub send_window: Option<u64>,
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
            stream_receive_window: None,
            receive_window: None,
            send_window: None,
            backpressure_timeout_ms: 5000,
            handshake_timeout_ms: 10_000,
            idle_timeout_ms: 60_000,
            keep_alive_interval_ms: None,
        }
    }
}

fn positive_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|x| x.as_u64()).filter(|n| *n > 0)
}

impl Limits {
    pub fn from_json(json: &str) -> Self {
        let mut lim = Self::default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(n) = v.get("maxSessions").and_then(|x| x.as_u64()) {
                lim.max_sessions = n.max(1);
            }
            if let Some(n) = v.get("maxHandshakesInFlight").and_then(|x| x.as_u64()) {
                lim.max_handshakes_in_flight = n.max(1);
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
                lim.max_datagram_size = (n as usize).max(1);
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
            // Explicit QUIC windows. Omitted, non-numeric or zero leaves the
            // window derived from the byte governors, so the shipped config is
            // byte-identical to before these fields existed.
            lim.stream_receive_window = positive_u64(&v, "streamReceiveWindow");
            lim.receive_window = positive_u64(&v, "receiveWindow");
            lim.send_window = positive_u64(&v, "sendWindow");
            if let Some(n) = v.get("backpressureTimeoutMs").and_then(|x| x.as_u64()) {
                lim.backpressure_timeout_ms = n.max(100);
            }
            if let Some(n) = v.get("handshakeTimeoutMs").and_then(|x| x.as_u64()) {
                lim.handshake_timeout_ms = n.max(100);
            }
            if let Some(n) = v.get("idleTimeoutMs").and_then(|x| x.as_u64()) {
                lim.idle_timeout_ms = n.max(1000);
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
    use super::*;

    #[test]
    fn test_zero_max_datagram_size_clamped_to_one() {
        let lim = Limits::from_json(r#"{"maxDatagramSize": 0}"#);
        assert_eq!(lim.max_datagram_size, 1);
    }

    #[test]
    fn test_zero_max_sessions_clamped_to_one() {
        let lim = Limits::from_json(r#"{"maxSessions": 0}"#);
        assert_eq!(lim.max_sessions, 1);
    }

    #[test]
    fn test_zero_handshake_timeout_clamped() {
        let lim = Limits::from_json(r#"{"handshakeTimeoutMs": 0}"#);
        assert_eq!(lim.handshake_timeout_ms, 100);
    }

    #[test]
    fn test_normal_values_pass_through() {
        let lim = Limits::from_json(r#"{"maxSessions": 500, "maxDatagramSize": 1200}"#);
        assert_eq!(lim.max_sessions, 500);
        assert_eq!(lim.max_datagram_size, 1200);
    }

    #[test]
    fn test_defaults_unchanged() {
        let lim = Limits::from_json("{}");
        assert_eq!(lim.max_sessions, 2000);
        assert_eq!(lim.max_datagram_size, 1200);
        assert_eq!(lim.handshake_timeout_ms, 10_000);
    }

    #[test]
    fn test_default_impl_and_clone_debug() {
        let lim = Limits::default();
        let cloned = lim.clone();
        assert_eq!(cloned.max_sessions, 2000);
        assert_eq!(cloned.max_handshakes_in_flight, 200);
        assert_eq!(cloned.max_streams_per_session_bidi, 200);
        assert_eq!(cloned.max_streams_per_session_uni, 200);
        assert_eq!(cloned.max_streams_global, 50_000);
        assert_eq!(cloned.max_datagram_size, 1200);
        assert_eq!(cloned.max_queued_bytes_global, 512 * 1024 * 1024);
        assert_eq!(cloned.max_queued_bytes_per_session, 2 * 1024 * 1024);
        assert_eq!(cloned.max_queued_bytes_per_stream, 256 * 1024);
        assert_eq!(cloned.backpressure_timeout_ms, 5000);
        assert_eq!(cloned.handshake_timeout_ms, 10_000);
        assert_eq!(cloned.idle_timeout_ms, 60_000);
        let debug = format!("{:?}", cloned);
        assert!(debug.contains("max_sessions"));
    }

    #[test]
    fn test_invalid_json_keeps_defaults() {
        let lim = Limits::from_json("not-json");
        assert_eq!(lim.max_sessions, Limits::default().max_sessions);
        assert_eq!(lim.idle_timeout_ms, Limits::default().idle_timeout_ms);
    }

    #[test]
    fn test_non_u64_fields_ignored() {
        let lim = Limits::from_json(
            r#"{
                "maxSessions": "nope",
                "maxHandshakesInFlight": null,
                "maxStreamsPerSessionBidi": true,
                "maxStreamsPerSessionUni": [],
                "maxStreamsGlobal": {},
                "maxDatagramSize": -1,
                "maxQueuedBytesGlobal": "x",
                "maxQueuedBytesPerSession": false,
                "maxQueuedBytesPerStream": 1.5,
                "backpressureTimeoutMs": "slow",
                "handshakeTimeoutMs": {},
                "idleTimeoutMs": []
            }"#,
        );
        let defaults = Limits::default();
        assert_eq!(lim.max_sessions, defaults.max_sessions);
        assert_eq!(
            lim.max_handshakes_in_flight,
            defaults.max_handshakes_in_flight
        );
        assert_eq!(
            lim.max_streams_per_session_bidi,
            defaults.max_streams_per_session_bidi
        );
        assert_eq!(
            lim.max_streams_per_session_uni,
            defaults.max_streams_per_session_uni
        );
        assert_eq!(lim.max_streams_global, defaults.max_streams_global);
        assert_eq!(lim.max_datagram_size, defaults.max_datagram_size);
        assert_eq!(
            lim.max_queued_bytes_global,
            defaults.max_queued_bytes_global
        );
        assert_eq!(
            lim.max_queued_bytes_per_session,
            defaults.max_queued_bytes_per_session
        );
        assert_eq!(
            lim.max_queued_bytes_per_stream,
            defaults.max_queued_bytes_per_stream
        );
        assert_eq!(
            lim.backpressure_timeout_ms,
            defaults.backpressure_timeout_ms
        );
        assert_eq!(lim.handshake_timeout_ms, defaults.handshake_timeout_ms);
        assert_eq!(lim.idle_timeout_ms, defaults.idle_timeout_ms);
    }

    #[test]
    fn test_all_fields_parsed_and_clamped() {
        let lim = Limits::from_json(
            r#"{
                "maxSessions": 10,
                "maxHandshakesInFlight": 0,
                "maxStreamsPerSessionBidi": 3,
                "maxStreamsPerSessionUni": 4,
                "maxStreamsGlobal": 5,
                "maxDatagramSize": 64,
                "maxQueuedBytesGlobal": 1024,
                "maxQueuedBytesPerSession": 512,
                "maxQueuedBytesPerStream": 256,
                "backpressureTimeoutMs": 50,
                "handshakeTimeoutMs": 200,
                "idleTimeoutMs": 500
            }"#,
        );
        assert_eq!(lim.max_sessions, 10);
        assert_eq!(lim.max_handshakes_in_flight, 1);
        assert_eq!(lim.max_streams_per_session_bidi, 3);
        assert_eq!(lim.max_streams_per_session_uni, 4);
        assert_eq!(lim.max_streams_global, 5);
        assert_eq!(lim.max_datagram_size, 64);
        assert_eq!(lim.max_queued_bytes_global, 1024);
        assert_eq!(lim.max_queued_bytes_per_session, 512);
        assert_eq!(lim.max_queued_bytes_per_stream, 256);
        assert_eq!(lim.backpressure_timeout_ms, 100);
        assert_eq!(lim.handshake_timeout_ms, 200);
        assert_eq!(lim.idle_timeout_ms, 1000);
    }

    #[test]
    fn test_timeout_floors_apply_only_when_below_minimum() {
        let lim = Limits::from_json(
            r#"{
                "backpressureTimeoutMs": 100,
                "handshakeTimeoutMs": 100,
                "idleTimeoutMs": 1000
            }"#,
        );
        assert_eq!(lim.backpressure_timeout_ms, 100);
        assert_eq!(lim.handshake_timeout_ms, 100);
        assert_eq!(lim.idle_timeout_ms, 1000);
    }

    #[test]
    fn window_fields_default_to_derived() {
        let lim = Limits::from_json("{}");
        assert_eq!(lim.stream_receive_window, None);
        assert_eq!(lim.receive_window, None);
        assert_eq!(lim.send_window, None);
    }

    #[test]
    fn window_fields_parse_when_present() {
        let lim = Limits::from_json(
            r#"{"streamReceiveWindow": 8388608, "receiveWindow": 33554432, "sendWindow": 4194304}"#,
        );
        assert_eq!(lim.stream_receive_window, Some(8 * 1024 * 1024));
        assert_eq!(lim.receive_window, Some(32 * 1024 * 1024));
        assert_eq!(lim.send_window, Some(4 * 1024 * 1024));
        // The governors they decouple from are untouched.
        assert_eq!(lim.max_queued_bytes_per_session, 2 * 1024 * 1024);
        assert_eq!(lim.max_queued_bytes_per_stream, 256 * 1024);
    }

    #[test]
    fn zero_or_malformed_windows_stay_derived() {
        let lim = Limits::from_json(
            r#"{"streamReceiveWindow": 0, "receiveWindow": "big", "sendWindow": -1}"#,
        );
        assert_eq!(lim.stream_receive_window, None);
        assert_eq!(lim.receive_window, None);
        assert_eq!(lim.send_window, None);
    }

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

        // from_json floors idleTimeoutMs at 1000, so a degenerate idle timeout
        // only reaches the clamp when set directly. It still yields a nonzero
        // interval rather than 0 (which would read as "keep-alive disabled").
        let lim = Limits::from_json(r#"{"idleTimeoutMs":2,"keepAliveIntervalMs":100}"#);
        assert_eq!(lim.idle_timeout_ms, 1000, "parse floor applies");
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(100));

        let mut lim = Limits::default();
        lim.idle_timeout_ms = 2;
        lim.keep_alive_interval_ms = Some(100);
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(1));
    }
}
