use crate::latency_probe::STAMP_BYTES_V3;
use std::time::Duration;

#[allow(unused_imports)]
pub use crate::latency_probe::{
    read_stamp, write_stamp_v3, CLASS_ACK, CLASS_ACTION, CLASS_MOVE, CLASS_RAID, CLASS_RAID_JOIN,
    CLASS_SNAPSHOT,
};

#[cfg_attr(not(test), allow(dead_code))]
pub const MOVE_HZ: u64 = 4;
#[cfg_attr(not(test), allow(dead_code))]
pub const ACTION_HZ_NUMERATOR: u64 = 1;
#[cfg_attr(not(test), allow(dead_code))]
pub const ACTION_HZ_DENOMINATOR: u64 = 2;
pub const SNAPSHOT_HZ: u64 = 5;
pub const EMITTER_SLICE_HZ: u64 = 50;
pub const SNAPSHOT_PAYLOAD_BYTES: usize = 1150;
pub const SNAPSHOT_DATAGRAMS: usize = 3;
#[allow(dead_code)]
pub const UPSTREAM_PAYLOAD_BYTES: usize = 64;

const OFFSET_ECHO_ACTUAL: usize = 28;
const OFFSET_HOLD: usize = 36;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TickObservation {
    pub intended_ns: u64,
    pub lag_ns: u64,
    pub skipped_ticks: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct G6ServerCorePlan {
    pub snapshot_payload_bytes: usize,
    pub snapshot_datagrams: usize,
    pub snapshot_hz: u64,
    pub emitter_slice_hz: u64,
    pub slice_ms: u64,
    pub slices_per_tick: usize,
}

impl G6ServerCorePlan {
    pub fn registered() -> Self {
        Self {
            snapshot_payload_bytes: SNAPSHOT_PAYLOAD_BYTES,
            snapshot_datagrams: SNAPSHOT_DATAGRAMS,
            snapshot_hz: SNAPSHOT_HZ,
            emitter_slice_hz: EMITTER_SLICE_HZ,
            slice_ms: 1000 / EMITTER_SLICE_HZ,
            slices_per_tick: (EMITTER_SLICE_HZ / SNAPSHOT_HZ) as usize,
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn action_every_nth_tick() -> u64 {
    MOVE_HZ * ACTION_HZ_DENOMINATOR / ACTION_HZ_NUMERATOR
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn class_for_tick(sequence: u64, action_every: u64) -> u8 {
    if action_every > 0 && sequence.is_multiple_of(action_every) {
        CLASS_ACTION
    } else {
        CLASS_MOVE
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn first_tick_offset(interval: Duration, phase_offset: f64) -> Duration {
    interval / 2 + interval.mul_f64(phase_offset.clamp(0.0, 1.0))
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn ticks_due_after(elapsed: Duration, interval: Duration, phase_offset: f64) -> u64 {
    let interval_ns = interval.as_nanos();
    if interval_ns == 0 {
        return 0;
    }
    let first = first_tick_offset(interval, phase_offset);
    if elapsed < first {
        return 0;
    }
    u64::try_from((elapsed - first).as_nanos() / interval_ns + 1).unwrap_or(u64::MAX)
}

fn saturating_u128_to_u64(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

pub fn observe_tick(
    scheduled: tokio::time::Instant,
    observed: tokio::time::Instant,
    actual_ns: u64,
    interval: Duration,
) -> TickObservation {
    let lag = observed.saturating_duration_since(scheduled);
    let lag_ns = saturating_u128_to_u64(lag.as_nanos());
    let skipped_ticks = if interval.is_zero() {
        0
    } else {
        saturating_u128_to_u64(lag.as_nanos() / interval.as_nanos())
    };
    TickObservation {
        intended_ns: actual_ns.saturating_sub(lag_ns),
        lag_ns,
        skipped_ticks,
    }
}

pub fn encode_snapshot_datagram(intended_ns: u64, actual_ns: u64, sequence: u64) -> Vec<u8> {
    let mut datagram = vec![0x77; SNAPSHOT_PAYLOAD_BYTES];
    write_stamp_v3(
        &mut datagram[..STAMP_BYTES_V3],
        intended_ns,
        actual_ns,
        sequence,
        CLASS_SNAPSHOT,
    );
    datagram
}

pub fn encode_reflected_ack(
    echo_actual_ns: u64,
    server_send_ns: u64,
    hold_ns: u64,
    sequence: u64,
) -> [u8; STAMP_BYTES_V3] {
    let mut datagram = [0u8; STAMP_BYTES_V3];
    write_stamp_v3(&mut datagram, 0, server_send_ns, sequence, CLASS_ACK);
    datagram[OFFSET_ECHO_ACTUAL..OFFSET_ECHO_ACTUAL + 8]
        .copy_from_slice(&echo_actual_ns.to_le_bytes());
    datagram[OFFSET_HOLD..OFFSET_HOLD + 8].copy_from_slice(&hold_ns.to_le_bytes());
    datagram
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_rate_matches_registered_cadence() {
        assert_eq!(action_every_nth_tick(), 8);
        let actions = (1..=800u64)
            .filter(|sequence| class_for_tick(*sequence, action_every_nth_tick()) == CLASS_ACTION)
            .count();
        assert_eq!(actions, 100);
    }

    #[test]
    fn snapshot_datagram_layout_matches_registered_shape() {
        let datagram = encode_snapshot_datagram(10, 20, 30);
        assert_eq!(datagram.len(), SNAPSHOT_PAYLOAD_BYTES);
        let stamp = read_stamp(&datagram[..STAMP_BYTES_V3]).expect("stamp");
        assert_eq!(stamp.version, 3);
        assert_eq!(stamp.class, CLASS_SNAPSHOT);
        assert_eq!(stamp.intended_ns, 10);
        assert_eq!(stamp.actual_ns, 20);
        assert_eq!(stamp.sequence, 30);
    }

    #[test]
    fn reflected_ack_carries_echo_and_hold_fields() {
        let datagram = encode_reflected_ack(90, 125, 35, 7);
        let stamp = read_stamp(&datagram).expect("stamp");
        assert_eq!(stamp.class, CLASS_ACK);
        assert_eq!(stamp.actual_ns, 125);
        assert_eq!(stamp.echo_actual_ns, 90);
        assert_eq!(stamp.hold_ns, 35);
        assert_eq!(stamp.sequence, 7);
    }
}
