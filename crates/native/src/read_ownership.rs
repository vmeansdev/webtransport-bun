//! Explicit ownership state for a stream handle's readable half.
//!
//! Exactly one party may own the transport `RecvStream` at a time: the
//! handle's deferred slot, an in-flight deferred-direct read, a receive
//! bridge task, or (RFC_STREAM_SINK, phase 3) a native sink task. Before
//! this type, that ownership was implicit in whether `deferred_recv` held
//! `Some` — which cannot distinguish "a direct read holds the stream out
//! right now" from "a bridge owns it" from "the readable half is finished",
//! and therefore cannot admit a sink safely. The `Mutex<Option<..>>` slots
//! remain the *storage*; this state is the *gate* that decides which path a
//! read takes and whether a sink may claim the stream.
//!
//! Transitions are lock-free CAS so the gate itself never blocks the hot
//! read path. Every transition helper is tolerant of losing a race with
//! `mark_consumed` (dispose/stop teardown): the terminal state always wins
//! and is never left.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum ReadOwnershipState {
    /// The transport receive stream is parked in the handle's deferred slot;
    /// no reader has committed to a delivery path.
    Deferred = 0,
    /// A deferred-direct read currently holds the receive stream out of the
    /// slot and will either park it back (`Deferred`) or finish it
    /// (`Consumed`).
    DirectReadActive = 1,
    /// A receive bridge task owns the stream (eager construction, or a
    /// deferred handle that migrated under concurrent readers); reads go
    /// through the bridge channel.
    Bridged = 2,
    /// A native sink task owns the stream exclusively (RFC_STREAM_SINK).
    Sink = 3,
    /// The readable half is finished: terminal delivered by a direct read,
    /// discarded, stopped, or disposed. Nothing can claim it again.
    Consumed = 4,
}

impl ReadOwnershipState {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Deferred,
            1 => Self::DirectReadActive,
            2 => Self::Bridged,
            3 => Self::Sink,
            _ => Self::Consumed,
        }
    }
}

pub(crate) struct ReadOwnership(AtomicU8);

impl ReadOwnership {
    /// A handle born with its receive stream parked in the deferred slot.
    pub(crate) fn deferred() -> Self {
        Self(AtomicU8::new(ReadOwnershipState::Deferred as u8))
    }

    /// A handle born with a receive bridge already running.
    pub(crate) fn bridged() -> Self {
        Self(AtomicU8::new(ReadOwnershipState::Bridged as u8))
    }

    pub(crate) fn state(&self) -> ReadOwnershipState {
        ReadOwnershipState::from_u8(self.0.load(Ordering::Acquire))
    }

    fn transition(
        &self,
        from: ReadOwnershipState,
        to: ReadOwnershipState,
    ) -> std::result::Result<(), ReadOwnershipState> {
        self.0
            .compare_exchange(from as u8, to as u8, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(ReadOwnershipState::from_u8)
    }

    /// Claim the stream for one deferred-direct read. `false` means the
    /// stream is not available for direct reading (bridged, mid-read,
    /// sink-owned, or finished) and the caller falls through to the bridge
    /// path exactly as it did when the deferred slot came up empty.
    pub(crate) fn begin_direct_read(&self) -> bool {
        self.transition(
            ReadOwnershipState::Deferred,
            ReadOwnershipState::DirectReadActive,
        )
        .is_ok()
    }

    /// The direct read parked the stream back for the next reader. Loses
    /// quietly to a concurrent `mark_consumed`: teardown owns the outcome.
    pub(crate) fn end_direct_read_keep(&self) {
        let _ = self.transition(
            ReadOwnershipState::DirectReadActive,
            ReadOwnershipState::Deferred,
        );
    }

    /// The direct read finished the readable half (EOF, wire error, abort)
    /// and dropped the stream.
    pub(crate) fn end_direct_read_consumed(&self) {
        let _ = self.transition(
            ReadOwnershipState::DirectReadActive,
            ReadOwnershipState::Consumed,
        );
    }

    /// The claimed slot was empty: teardown emptied it between the claim and
    /// the take. Resolve the claim to the terminal state teardown intended.
    pub(crate) fn direct_read_lost(&self) {
        self.end_direct_read_consumed();
    }

    /// A receive bridge took ownership of the stream. Terminal state wins if
    /// teardown got there first.
    pub(crate) fn mark_bridged(&self) {
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                if current == ReadOwnershipState::Consumed as u8 {
                    None
                } else {
                    Some(ReadOwnershipState::Bridged as u8)
                }
            });
    }

    /// The readable half is finished for good (dispose, discard, stop).
    pub(crate) fn mark_consumed(&self) {
        self.0
            .store(ReadOwnershipState::Consumed as u8, Ordering::Release);
    }

    /// Roll back a sink claim whose open failed after the CAS (bad buffer,
    /// bad options): the stream went back into the deferred slot first, so
    /// the Deferred invariant holds.
    pub(crate) fn release_sink_claim(&self) {
        let _ = self.transition(ReadOwnershipState::Sink, ReadOwnershipState::Deferred);
    }

    /// Claim the stream for a native sink task (RFC_STREAM_SINK §6): legal
    /// only from `Deferred`. The rejecting state comes back so the caller
    /// can map it to the right in-band error code. Callers must additionally
    /// consult the handle's `TerminalLatch`: a batch that consumed a reset
    /// while holding bytes leaves the state `Deferred` with the terminal
    /// latched, and a sink must not open past a latched terminal.
    pub(crate) fn try_claim_sink(&self) -> std::result::Result<(), ReadOwnershipState> {
        self.transition(ReadOwnershipState::Deferred, ReadOwnershipState::Sink)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_read_round_trip_returns_to_deferred() {
        let ownership = ReadOwnership::deferred();
        assert!(ownership.begin_direct_read());
        assert_eq!(ownership.state(), ReadOwnershipState::DirectReadActive);
        ownership.end_direct_read_keep();
        assert_eq!(ownership.state(), ReadOwnershipState::Deferred);
        assert!(ownership.begin_direct_read());
    }

    #[test]
    fn direct_read_is_exclusive() {
        let ownership = ReadOwnership::deferred();
        assert!(ownership.begin_direct_read());
        assert!(!ownership.begin_direct_read());
    }

    #[test]
    fn terminal_direct_read_consumes() {
        let ownership = ReadOwnership::deferred();
        assert!(ownership.begin_direct_read());
        ownership.end_direct_read_consumed();
        assert_eq!(ownership.state(), ReadOwnershipState::Consumed);
        assert!(!ownership.begin_direct_read());
    }

    #[test]
    fn bridged_handles_never_direct_read() {
        let ownership = ReadOwnership::bridged();
        assert!(!ownership.begin_direct_read());
    }

    #[test]
    fn consumed_wins_over_parking_back() {
        let ownership = ReadOwnership::deferred();
        assert!(ownership.begin_direct_read());
        ownership.mark_consumed();
        ownership.end_direct_read_keep();
        assert_eq!(ownership.state(), ReadOwnershipState::Consumed);
    }

    #[test]
    fn consumed_wins_over_bridge_migration() {
        let ownership = ReadOwnership::deferred();
        ownership.mark_consumed();
        ownership.mark_bridged();
        assert_eq!(ownership.state(), ReadOwnershipState::Consumed);
    }

    #[test]
    fn deferred_migrates_to_bridge() {
        let ownership = ReadOwnership::deferred();
        ownership.mark_bridged();
        assert_eq!(ownership.state(), ReadOwnershipState::Bridged);
        assert!(!ownership.begin_direct_read());
    }

    #[test]
    fn sink_claims_only_from_deferred() {
        let ownership = ReadOwnership::deferred();
        assert!(ownership.try_claim_sink().is_ok());
        assert_eq!(ownership.state(), ReadOwnershipState::Sink);

        let bridged = ReadOwnership::bridged();
        assert_eq!(bridged.try_claim_sink(), Err(ReadOwnershipState::Bridged));

        let mid_read = ReadOwnership::deferred();
        assert!(mid_read.begin_direct_read());
        assert_eq!(
            mid_read.try_claim_sink(),
            Err(ReadOwnershipState::DirectReadActive)
        );
        mid_read.end_direct_read_keep();
        assert!(mid_read.try_claim_sink().is_ok());
    }

    #[test]
    fn sink_owned_stream_rejects_direct_reads() {
        let ownership = ReadOwnership::deferred();
        assert!(ownership.try_claim_sink().is_ok());
        assert!(!ownership.begin_direct_read());
    }
}
