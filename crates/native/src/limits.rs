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

/// Smallest accepted value of each integer field. Kept in step with
/// `LIMIT_FLOORS` in `packages/webtransport/src/index.ts`, which rejects first;
/// this parser refuses the same inputs so a direct addon call cannot have a
/// value silently replaced either.
const FLOORS: &[(&str, u64)] = &[
    ("maxSessions", 1),
    ("maxHandshakesInFlight", 1),
    ("maxStreamsPerSessionBidi", 0),
    ("maxStreamsPerSessionUni", 0),
    ("maxStreamsGlobal", 0),
    ("maxDatagramSize", 1),
    ("maxQueuedBytesGlobal", 0),
    ("maxQueuedBytesPerSession", 0),
    ("maxQueuedBytesPerStream", 0),
    ("backpressureTimeoutMs", 100),
    ("handshakeTimeoutMs", 100),
    ("idleTimeoutMs", 1000),
    ("keepAliveIntervalMs", 0),
];

/// An integer field: absent is `None`, present must be an integer at or above
/// its floor.
fn integer_field(
    v: &serde_json::Value,
    key: &str,
    floor: u64,
) -> std::result::Result<Option<u64>, String> {
    let Some(raw) = v.get(key) else {
        return Ok(None);
    };
    match raw.as_u64() {
        Some(n) if n >= floor => Ok(Some(n)),
        _ => Err(format!(
            "E_INVALID_ARGUMENT: limits.{key} must be an integer >= {floor}, got {raw}"
        )),
    }
}

fn floor_of(key: &str) -> u64 {
    FLOORS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, floor)| *floor)
        .unwrap_or(0)
}

impl Limits {
    /// Parse a `limits` JSON object. Absent fields keep their defaults; a
    /// present field that is not an integer at or above its floor is an
    /// `E_INVALID_ARGUMENT` error rather than a silently substituted value.
    pub fn from_json(json: &str) -> std::result::Result<Self, String> {
        let v: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| format!("E_INVALID_ARGUMENT: limits must be a JSON object: {e}"))?;
        if !v.is_object() {
            return Err("E_INVALID_ARGUMENT: limits must be an object".to_string());
        }
        let field = |key: &str| integer_field(&v, key, floor_of(key));
        let mut lim = Self::default();
        if let Some(n) = field("maxSessions")? {
            lim.max_sessions = n;
        }
        if let Some(n) = field("maxHandshakesInFlight")? {
            lim.max_handshakes_in_flight = n;
        }
        if let Some(n) = field("maxStreamsPerSessionBidi")? {
            lim.max_streams_per_session_bidi = n;
        }
        if let Some(n) = field("maxStreamsPerSessionUni")? {
            lim.max_streams_per_session_uni = n;
        }
        if let Some(n) = field("maxStreamsGlobal")? {
            lim.max_streams_global = n;
        }
        if let Some(n) = field("maxDatagramSize")? {
            lim.max_datagram_size = usize::try_from(n).unwrap_or(usize::MAX);
        }
        if let Some(n) = field("maxQueuedBytesGlobal")? {
            lim.max_queued_bytes_global = n;
        }
        if let Some(n) = field("maxQueuedBytesPerSession")? {
            lim.max_queued_bytes_per_session = n;
        }
        if let Some(n) = field("maxQueuedBytesPerStream")? {
            lim.max_queued_bytes_per_stream = n;
        }
        // Explicit QUIC windows: omitted leaves the window derived from the
        // byte governors; set means a positive integer.
        lim.stream_receive_window = integer_field(&v, "streamReceiveWindow", 1)?;
        lim.receive_window = integer_field(&v, "receiveWindow", 1)?;
        lim.send_window = integer_field(&v, "sendWindow", 1)?;
        if let Some(n) = field("backpressureTimeoutMs")? {
            lim.backpressure_timeout_ms = n;
        }
        if let Some(n) = field("handshakeTimeoutMs")? {
            lim.handshake_timeout_ms = n;
        }
        if let Some(n) = field("idleTimeoutMs")? {
            lim.idle_timeout_ms = n;
        }
        if let Some(n) = field("keepAliveIntervalMs")? {
            // 0 means disabled, same as omitting the field.
            lim.keep_alive_interval_ms = (n > 0).then_some(n);
        }
        Ok(lim)
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

    fn parse(json: &str) -> Limits {
        Limits::from_json(json).expect("valid limits")
    }

    fn reject(json: &str) -> String {
        Limits::from_json(json).expect_err("invalid limits")
    }

    #[test]
    fn test_normal_values_pass_through() {
        let lim = parse(r#"{"maxSessions": 500, "maxDatagramSize": 1200}"#);
        assert_eq!(lim.max_sessions, 500);
        assert_eq!(lim.max_datagram_size, 1200);
    }

    #[test]
    fn test_defaults_unchanged() {
        let lim = parse("{}");
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
    fn invalid_json_or_a_non_object_is_rejected() {
        assert!(reject("not-json").starts_with("E_INVALID_ARGUMENT: "));
        assert!(reject("[]").starts_with("E_INVALID_ARGUMENT: "));
    }

    #[test]
    fn non_integer_fields_are_rejected_not_ignored() {
        for (key, raw) in [
            ("maxSessions", r#""nope""#),
            ("maxHandshakesInFlight", "null"),
            ("maxStreamsPerSessionBidi", "true"),
            ("maxStreamsPerSessionUni", "[]"),
            ("maxStreamsGlobal", "{}"),
            ("maxDatagramSize", "-1"),
            ("maxQueuedBytesGlobal", r#""x""#),
            ("maxQueuedBytesPerSession", "false"),
            ("maxQueuedBytesPerStream", "1.5"),
            ("backpressureTimeoutMs", r#""slow""#),
            ("handshakeTimeoutMs", "{}"),
            ("idleTimeoutMs", "[]"),
            ("keepAliveIntervalMs", "-5"),
        ] {
            let err = reject(&format!(r#"{{"{key}": {raw}}}"#));
            assert!(
                err.starts_with(&format!("E_INVALID_ARGUMENT: limits.{key} must be")),
                "{key}: {err}"
            );
        }
    }

    #[test]
    fn values_below_a_floor_are_rejected_not_clamped() {
        for (key, below) in [
            ("maxSessions", 0),
            ("maxHandshakesInFlight", 0),
            ("maxDatagramSize", 0),
            ("backpressureTimeoutMs", 99),
            ("handshakeTimeoutMs", 0),
            ("idleTimeoutMs", 999),
        ] {
            let err = reject(&format!(r#"{{"{key}": {below}}}"#));
            assert!(
                err.contains(&format!("limits.{key} must be an integer >=")),
                "{err}"
            );
        }
    }

    #[test]
    fn floors_themselves_are_accepted() {
        let lim = parse(
            r#"{
                "maxSessions": 1,
                "maxHandshakesInFlight": 1,
                "maxStreamsPerSessionBidi": 0,
                "maxStreamsPerSessionUni": 0,
                "maxStreamsGlobal": 0,
                "maxDatagramSize": 1,
                "maxQueuedBytesGlobal": 0,
                "maxQueuedBytesPerSession": 0,
                "maxQueuedBytesPerStream": 0,
                "backpressureTimeoutMs": 100,
                "handshakeTimeoutMs": 100,
                "idleTimeoutMs": 1000,
                "keepAliveIntervalMs": 0
            }"#,
        );
        assert_eq!(lim.max_sessions, 1);
        assert_eq!(lim.max_handshakes_in_flight, 1);
        assert_eq!(lim.max_streams_per_session_bidi, 0);
        assert_eq!(lim.max_streams_global, 0);
        assert_eq!(lim.max_datagram_size, 1);
        assert_eq!(lim.max_queued_bytes_per_stream, 0);
        assert_eq!(lim.backpressure_timeout_ms, 100);
        assert_eq!(lim.handshake_timeout_ms, 100);
        assert_eq!(lim.idle_timeout_ms, 1000);
        assert_eq!(lim.keep_alive_interval_ms, None);
    }

    #[test]
    fn test_all_fields_parsed() {
        let lim = parse(
            r#"{
                "maxSessions": 10,
                "maxHandshakesInFlight": 2,
                "maxStreamsPerSessionBidi": 3,
                "maxStreamsPerSessionUni": 4,
                "maxStreamsGlobal": 5,
                "maxDatagramSize": 64,
                "maxQueuedBytesGlobal": 1024,
                "maxQueuedBytesPerSession": 512,
                "maxQueuedBytesPerStream": 256,
                "backpressureTimeoutMs": 150,
                "handshakeTimeoutMs": 200,
                "idleTimeoutMs": 1500
            }"#,
        );
        assert_eq!(lim.max_sessions, 10);
        assert_eq!(lim.max_handshakes_in_flight, 2);
        assert_eq!(lim.max_streams_per_session_bidi, 3);
        assert_eq!(lim.max_streams_per_session_uni, 4);
        assert_eq!(lim.max_streams_global, 5);
        assert_eq!(lim.max_datagram_size, 64);
        assert_eq!(lim.max_queued_bytes_global, 1024);
        assert_eq!(lim.max_queued_bytes_per_session, 512);
        assert_eq!(lim.max_queued_bytes_per_stream, 256);
        assert_eq!(lim.backpressure_timeout_ms, 150);
        assert_eq!(lim.handshake_timeout_ms, 200);
        assert_eq!(lim.idle_timeout_ms, 1500);
    }

    #[test]
    fn window_fields_default_to_derived() {
        let lim = parse("{}");
        assert_eq!(lim.stream_receive_window, None);
        assert_eq!(lim.receive_window, None);
        assert_eq!(lim.send_window, None);
    }

    #[test]
    fn window_fields_parse_when_present() {
        let lim = parse(
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
    fn zero_or_malformed_windows_are_rejected() {
        for raw in [
            r#"{"streamReceiveWindow": 0}"#,
            r#"{"receiveWindow": "big"}"#,
            r#"{"sendWindow": -1}"#,
        ] {
            assert!(
                reject(raw).starts_with("E_INVALID_ARGUMENT: limits."),
                "{raw}"
            );
        }
    }

    #[test]
    fn keep_alive_disabled_by_default_and_on_zero() {
        assert_eq!(Limits::default().effective_keep_alive_interval_ms(), None);
        let lim = parse(r#"{"keepAliveIntervalMs":0}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), None);
    }

    #[test]
    fn keep_alive_clamped_to_third_of_idle_timeout() {
        let lim = parse(r#"{"idleTimeoutMs":3000,"keepAliveIntervalMs":5000}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(1000));

        let lim = parse(r#"{"idleTimeoutMs":3000,"keepAliveIntervalMs":200}"#);
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(200));

        // The parser refuses idle timeouts below 1000 ms, so a degenerate one
        // only reaches the clamp when set directly. It still yields a nonzero
        // interval rather than 0 (which would read as "keep-alive disabled").
        let lim = Limits {
            idle_timeout_ms: 2,
            keep_alive_interval_ms: Some(100),
            ..Limits::default()
        };
        assert_eq!(lim.effective_keep_alive_interval_ms(), Some(1));
    }
}
