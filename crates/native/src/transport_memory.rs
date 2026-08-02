//! Shared native QUIC memory policy.
//!
//! The application byte governors and QUIC transport windows are related, but
//! they are not interchangeable.  This module owns the bounded arithmetic and
//! exposes a snapshot that can be applied to both native endpoints without
//! reaching into Quinn's private configuration fields.

use crate::limits::Limits;

pub(crate) const QUIC_VARINT_MAX: u64 = (1u64 << 62) - 1;
pub(crate) const DATAGRAM_CHANNEL_CAPACITY_CEILING: usize = 2048;
pub(crate) const H1B_DATAGRAM_BUFFER_CANDIDATE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TransportMemoryPolicy {
    /// Maximum peer bytes advertised for one incoming stream.
    pub(crate) stream_receive_window: u64,
    /// Maximum peer bytes advertised across all incoming streams.
    pub(crate) receive_window: u64,
    /// Maximum unacknowledged outgoing stream bytes.
    pub(crate) send_window: u64,
    /// H1b-owned transport datagram setting. `None` means keep Quinn's default.
    pub(crate) datagram_receive_buffer_size: Option<usize>,
    /// H1b-owned transport datagram setting. `None` means keep Quinn's default.
    pub(crate) datagram_send_buffer_size: Option<usize>,
    /// H2-owned native channel capacity, derived here but applied separately.
    pub(crate) datagram_channel_capacity: usize,
}

impl TransportMemoryPolicy {
    pub(crate) fn from_limits(limits: &Limits) -> Self {
        let max_datagram_size = (limits.max_datagram_size as u64).max(1);
        let stream_receive_window =
            clamp_quic_window(limits.max_queued_bytes_per_stream.max(max_datagram_size));
        let receive_window = clamp_quic_window(
            limits
                .max_queued_bytes_per_session
                .max(stream_receive_window),
        );
        let send_window = clamp_quic_window(
            limits
                .max_queued_bytes_per_session
                .max(stream_receive_window),
        );
        let datagram_channel_capacity = ceil_div(
            limits.max_queued_bytes_per_session.max(1),
            max_datagram_size,
        )
        .clamp(1, DATAGRAM_CHANNEL_CAPACITY_CEILING as u64)
            as usize;

        Self {
            stream_receive_window,
            receive_window,
            send_window,
            datagram_receive_buffer_size: None,
            datagram_send_buffer_size: None,
            datagram_channel_capacity,
        }
    }

    pub(crate) fn with_datagram_buffers(
        self,
        limits: &Limits,
        receive_buffer_size: usize,
        send_buffer_size: usize,
    ) -> Self {
        let payload_floor = limits.max_datagram_size.max(1);
        Self {
            datagram_receive_buffer_size: Some(receive_buffer_size.max(payload_floor)),
            datagram_send_buffer_size: Some(send_buffer_size.max(payload_floor)),
            ..self
        }
    }

    pub(crate) fn with_h1b_datagram_buffers(self, limits: &Limits) -> Self {
        self.with_datagram_buffers(
            limits,
            H1B_DATAGRAM_BUFFER_CANDIDATE_BYTES,
            H1B_DATAGRAM_BUFFER_CANDIDATE_BYTES,
        )
    }

    pub(crate) fn apply_datagram_buffers(
        &self,
        config: &mut wtransport::config::QuicTransportConfig,
    ) {
        if let Some(receive) = self.datagram_receive_buffer_size {
            config.datagram_receive_buffer_size(Some(receive));
        }
        if let Some(send) = self.datagram_send_buffer_size {
            config.datagram_send_buffer_size(send);
        }
    }

    pub(crate) fn apply_flow_control(&self, config: &mut wtransport::config::QuicTransportConfig) {
        let stream =
            wtransport::quinn::VarInt::from_u64(clamp_quic_window(self.stream_receive_window))
                .unwrap_or(wtransport::quinn::VarInt::MAX);
        let receive = wtransport::quinn::VarInt::from_u64(clamp_quic_window(self.receive_window))
            .unwrap_or(wtransport::quinn::VarInt::MAX);
        config
            .stream_receive_window(stream)
            .receive_window(receive)
            .send_window(clamp_quic_window(self.send_window));
    }
}

fn clamp_quic_window(value: u64) -> u64 {
    value.clamp(1, QUIC_VARINT_MAX)
}

fn ceil_div(numerator: u64, denominator: u64) -> u64 {
    debug_assert!(denominator > 0);
    let quotient = numerator / denominator;
    quotient + u64::from(!numerator.is_multiple_of(denominator))
}

#[cfg(test)]
mod tests {
    use super::{TransportMemoryPolicy, H1B_DATAGRAM_BUFFER_CANDIDATE_BYTES};
    use crate::limits::Limits;

    #[test]
    fn derives_default_flow_control_and_slot_snapshot() {
        let policy = TransportMemoryPolicy::from_limits(&Limits::default());

        assert_eq!(policy.stream_receive_window, 256 * 1024);
        assert_eq!(policy.receive_window, 2 * 1024 * 1024);
        assert_eq!(policy.send_window, 2 * 1024 * 1024);
        assert_eq!(policy.datagram_receive_buffer_size, None);
        assert_eq!(policy.datagram_send_buffer_size, None);
        assert_eq!(policy.datagram_channel_capacity, 1748);
    }

    #[test]
    fn malformed_relational_limits_stay_nonzero() {
        let mut limits = Limits::default();
        limits.max_datagram_size = 0;
        limits.max_queued_bytes_per_session = 0;
        limits.max_queued_bytes_per_stream = 0;

        let policy = TransportMemoryPolicy::from_limits(&limits);

        assert_eq!(policy.stream_receive_window, 1);
        assert_eq!(policy.receive_window, 1);
        assert_eq!(policy.send_window, 1);
        assert_eq!(policy.datagram_channel_capacity, 1);
    }

    #[test]
    fn payload_floor_wins_when_datagram_exceeds_stream_budgets() {
        let mut limits = Limits::default();
        limits.max_datagram_size = 4096;
        limits.max_queued_bytes_per_session = 1;
        limits.max_queued_bytes_per_stream = 1;

        let policy = TransportMemoryPolicy::from_limits(&limits);

        assert_eq!(policy.stream_receive_window, 4096);
        assert_eq!(policy.receive_window, 4096);
        assert_eq!(policy.send_window, 4096);
        assert_eq!(policy.datagram_channel_capacity, 1);
    }

    #[test]
    fn saturates_windows_at_quic_varint_limit() {
        let mut limits = Limits::default();
        limits.max_queued_bytes_per_session = u64::MAX;
        limits.max_queued_bytes_per_stream = u64::MAX;

        let policy = TransportMemoryPolicy::from_limits(&limits);

        assert_eq!(policy.stream_receive_window, super::QUIC_VARINT_MAX);
        assert_eq!(policy.receive_window, super::QUIC_VARINT_MAX);
        assert_eq!(policy.send_window, super::QUIC_VARINT_MAX);
    }

    #[test]
    fn applies_snapshot_to_real_quic_transport_config() {
        let policy = TransportMemoryPolicy::from_limits(&Limits::default());
        let mut config = wtransport::config::QuicTransportConfig::default();

        policy.apply_flow_control(&mut config);
    }

    #[test]
    fn clamps_datagram_buffers_to_the_configured_payload_floor() {
        let mut limits = Limits::default();
        limits.max_datagram_size = 1200;
        let policy =
            TransportMemoryPolicy::from_limits(&limits).with_datagram_buffers(&limits, 64, 32);

        assert_eq!(policy.datagram_receive_buffer_size, Some(1200));
        assert_eq!(policy.datagram_send_buffer_size, Some(1200));
    }

    #[test]
    fn applies_h1b_datagram_snapshot_to_real_quic_transport_config() {
        let limits = Limits::default();
        let policy = TransportMemoryPolicy::from_limits(&limits).with_h1b_datagram_buffers(&limits);
        assert_eq!(
            policy.datagram_receive_buffer_size,
            Some(H1B_DATAGRAM_BUFFER_CANDIDATE_BYTES)
        );
        assert_eq!(
            policy.datagram_send_buffer_size,
            Some(H1B_DATAGRAM_BUFFER_CANDIDATE_BYTES)
        );
        let mut config = wtransport::config::QuicTransportConfig::default();

        policy.apply_datagram_buffers(&mut config);
    }
}
