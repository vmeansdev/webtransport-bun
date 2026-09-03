//! Server-side ACK cadence: how aggressively the client is asked to
//! coalesce its ACKs.
//!
//! quinn's stock cadence (ack every 2nd ack-eliciting packet, 25 ms
//! `max_ack_delay`) leaves ~30% of packets on a saturated c-32 shard as
//! ACK-only, each paying full AEAD + header protection. quinn-proto 0.11.16
//! always advertises `min_ack_delay` in its own transport parameters
//! (`TransportParameters::new`), so the ACK_FREQUENCY extension is active
//! against any quinn peer regardless of whether `ack_frequency_config` is
//! set — `Connection::peer_supports_ack_frequency` only checks that the
//! *peer's* `min_ack_delay` is present, which quinn always sends. Setting
//! `ack_frequency_config` on the server's transport config therefore asks
//! the client to relax how often *it* acks the server; nothing here changes
//! how the server acks the client.
//!
//! [`WEBTRANSPORT_NATIVE_ACK_CADENCE`] selects the mode; `default` (also the
//! value when unset) is byte-for-byte today's behaviour, `relaxed` widens
//! `max_ack_delay` to 100 ms and configures ACK_FREQUENCY with an
//! ack-eliciting threshold of 10. Registered campaign knob, exactly like
//! `WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME`.

use std::time::Duration;

use wtransport::config::QuicTransportConfig;
use wtransport::quinn::{AckFrequencyConfig, VarInt};

const RELAXED_MAX_ACK_DELAY: Duration = Duration::from_millis(100);
const RELAXED_ACK_ELICITING_THRESHOLD: u64 = 10;

/// Server-side ACK cadence mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AckCadenceMode {
    /// quinn's stock cadence (the default): unchanged `max_ack_delay`, no
    /// `ack_frequency_config`.
    Default,
    /// `max_ack_delay` 100 ms plus an ACK_FREQUENCY request (threshold 10,
    /// 100 ms) asking the peer to coalesce more of its ACKs.
    Relaxed,
}

impl AckCadenceMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Relaxed => "relaxed",
        }
    }
}

/// Parse `WEBTRANSPORT_NATIVE_ACK_CADENCE`. Unset means the default cadence;
/// only the two literal modes are honoured; anything else is an error the
/// caller turns into a fail-closed abort.
pub(crate) fn parse_ack_cadence_mode(raw: Option<&str>) -> Result<AckCadenceMode, ()> {
    match raw {
        None | Some("default") => Ok(AckCadenceMode::Default),
        Some("relaxed") => Ok(AckCadenceMode::Relaxed),
        Some(_) => Err(()),
    }
}

/// Effective ACK cadence, resolved once per process so the transport config
/// and the `serverAckCadence` getter can never disagree.
pub(crate) fn server_ack_cadence_mode() -> AckCadenceMode {
    static RESOLVED: std::sync::OnceLock<AckCadenceMode> = std::sync::OnceLock::new();
    *RESOLVED.get_or_init(|| {
        let raw = std::env::var("WEBTRANSPORT_NATIVE_ACK_CADENCE").ok();
        match parse_ack_cadence_mode(raw.as_deref()) {
            Ok(mode) => mode,
            Err(()) => {
                eprintln!(
                    "webtransport-native: FATAL E_INTERNAL: WEBTRANSPORT_NATIVE_ACK_CADENCE must be 'default' or 'relaxed', got '{}'",
                    raw.unwrap_or_default()
                );
                std::process::abort();
            }
        }
    })
}

/// Apply `mode` to `transport`. `Default` is a no-op — today's behaviour.
/// `Relaxed` requests ACK_FREQUENCY with an ack-eliciting threshold of 10
/// and a 100 ms max ack delay.
///
/// quinn-proto 0.11.16's `TransportConfig` has no standalone `max_ack_delay`
/// setter — only `AckFrequencyConfig::max_ack_delay` (the delay requested of
/// the peer via ACK_FREQUENCY) exists, so that is the only knob this turns.
pub(crate) fn apply(transport: &mut QuicTransportConfig, mode: AckCadenceMode) {
    if mode != AckCadenceMode::Relaxed {
        return;
    }
    let mut ack_frequency_config = AckFrequencyConfig::default();
    ack_frequency_config
        .ack_eliciting_threshold(VarInt::from_u64(RELAXED_ACK_ELICITING_THRESHOLD).unwrap())
        .max_ack_delay(Some(RELAXED_MAX_ACK_DELAY));
    transport.ack_frequency_config(Some(ack_frequency_config));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_two_modes() {
        assert_eq!(parse_ack_cadence_mode(None), Ok(AckCadenceMode::Default));
        assert_eq!(
            parse_ack_cadence_mode(Some("default")),
            Ok(AckCadenceMode::Default)
        );
        assert_eq!(
            parse_ack_cadence_mode(Some("relaxed")),
            Ok(AckCadenceMode::Relaxed)
        );
        assert_eq!(parse_ack_cadence_mode(Some("")), Err(()));
        assert_eq!(parse_ack_cadence_mode(Some("Relaxed")), Err(()));
        assert_eq!(parse_ack_cadence_mode(Some("both")), Err(()));
    }

    #[test]
    fn default_mode_leaves_the_transport_config_untouched() {
        let mut transport = QuicTransportConfig::default();
        let before = format!("{transport:?}");
        apply(&mut transport, AckCadenceMode::Default);
        assert_eq!(format!("{transport:?}"), before);
    }

    #[test]
    fn relaxed_mode_sets_ack_frequency_config() {
        let mut transport = QuicTransportConfig::default();
        apply(&mut transport, AckCadenceMode::Relaxed);
        let debug = format!("{transport:?}");
        assert!(
            debug.contains("ack_frequency_config: Some"),
            "expected an ack_frequency_config in {debug}"
        );
        assert!(
            debug.contains("100"),
            "expected the 100ms max_ack_delay to show up in {debug}"
        );
    }
}
