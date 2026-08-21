//! One payload, many sessions: the cap, the failure-code enum and the
//! reject-free envelope the mirror send hands back.
//!
//! The registry work lives in `session_registry.rs` and the per-target send in
//! `session.rs`; what is here is the vocabulary, so the cap cannot drift and a
//! failure code cannot mean two things on the two sides of the boundary.
//!
//! The envelope is a **set**, not a prefix. `send_datagram_batch` reports
//! `{sent: k}` because element `k+1` of one session's batch genuinely cannot go
//! out before element `k`; a target list has no such ordering. Subscriber 4
//! being gone says nothing about subscriber 5, so every target is attempted
//! independently and the envelope names the ones that failed.

use napi::bindgen_prelude::{Uint32Array, Uint8Array};
use napi_derive::napi;

/// Largest target list one mirror call may carry.
///
/// Not `DATAGRAM_BATCH_MAX`: that cap bounds payload memory held outside the
/// queue's byte reservation, and a mirror holds one payload whatever `N` is.
/// This one bounds **time**. The call is synchronous, so it stalls the JS
/// thread for its whole duration; at the worst measured per-target cost of the
/// shipped target shape (90 ns, `tools/bench/mirror-send/RUNS.md`) a 1 ms stall
/// budget — ~20% of G2's p99 ≤ 5 ms ingest bound, which is where a stalled
/// emitter would surface, and in the wrong place — allows 11,111 targets.
///
/// `packages/webtransport/src/datagram-mirror.ts` holds the only other copy and
/// `packages/webtransport/test/native-datagram-mirror.test.ts` asserts the two
/// agree and that no third has appeared.
pub(crate) const DATAGRAM_MIRROR_MAX: u32 = 10_000;

/// Why one target did not take the payload.
///
/// A `u8` rather than a string: at 10,000 targets a per-failure string is
/// 10,000 allocations to say what four values say, and the whole point of the
/// failures-only envelope is that its cost is proportional to what went wrong.
/// The TypeScript decode table in `datagram-mirror.ts` is asserted exhaustive
/// against this list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum MirrorFailure {
    /// Target is not in this server's registry: unknown, already reaped, or
    /// owned by another server in this process. From this server's point of
    /// view those are the same thing.
    SessionClosed = 1,
    /// Payload is larger than the target's `maxDatagramSize`, or quinn refused
    /// the send outright. Permanent for this payload.
    QueueFull = 2,
    /// The target had no queued-byte budget at this instant. The mirror never
    /// waits (design M3), so this is where backpressure lands; the caller's
    /// remedy is `session.sendDatagram()` on just these targets.
    WouldBlock = 3,
    /// The caller handed over more than `DATAGRAM_MIRROR_MAX` targets and this
    /// index is past the cap. Unreachable through the TypeScript wrapper, which
    /// throws `RangeError` before crossing; a raw-addon caller gets the tail
    /// named rather than silently dropped.
    TooManyTargets = 4,
}

impl MirrorFailure {
    /// Map a per-target error code from the send path onto the wire enum.
    ///
    /// Anything unrecognized is `QueueFull` rather than a panic: an unmapped
    /// code must degrade to "this target did not take it", never take the whole
    /// broadcast down.
    pub(crate) fn from_code(code: &str) -> Self {
        match code {
            "E_SESSION_CLOSED" => Self::SessionClosed,
            crate::session::WOULD_BLOCK => Self::WouldBlock,
            _ => Self::QueueFull,
        }
    }
}

/// Outcome of one mirror call. Never a rejection, never a throw for a transport
/// condition: `sent + failed.len() == targets.len()` always holds.
///
/// `failed` carries indices into the caller's target list and `codes` is
/// parallel to it. Both are empty in the healthy case, which is the property
/// bought over a per-target array: a 10,000-subscriber broadcast where nothing
/// went wrong allocates nothing to say so.
#[napi(object)]
pub struct DatagramMirrorResult {
    pub sent: u32,
    pub failed: Uint32Array,
    pub codes: Uint8Array,
}

/// Outcome of one **paced** mirror call: what the schedule accepted, and which
/// targets it refused.
///
/// Deliberately not [`DatagramMirrorResult`], and deliberately carrying no
/// delivery count of any name. Nothing has been delivered when this returns: no
/// target has been resolved, no ownership checked, no byte budget consulted.
/// `admitted` counts targets accepted onto the pacer's schedule and nothing
/// more, and the per-target outcomes arrive later through `readMirrorReports`.
///
/// `refused` carries indices into the caller's target list and `codes` is
/// parallel to it, exactly as the synchronous envelope's failure arrays are —
/// same decode table, same set-not-prefix rule.
#[napi(object)]
pub struct DatagramMirrorAdmission {
    /// Whether there was a schedule to be admitted to at all.
    ///
    /// `false` means the pacer knob is off; nothing was offered and the other
    /// fields are empty. The wrapper turns it into an `E_UNSUPPORTED_ARGUMENT`
    /// `WebTransportError`.
    ///
    /// A returned flag rather than a returned `Err`, because Bun does not raise
    /// a synchronous N-API `Err` as a JavaScript exception: it hands the error
    /// object back as the *return value*, so a `try`/`catch` around the call
    /// never runs and the caller decodes an `Error` as if it were an envelope
    /// (observed on Bun 1.3.14, `packages/webtransport/test/native-datagram-mirror-paced.test.ts`).
    pub paced: bool,
    pub admitted: u32,
    pub refused: Uint32Array,
    pub codes: Uint8Array,
}

impl DatagramMirrorAdmission {
    /// The envelope for "there is no schedule": nothing offered, nothing
    /// refused, and the flag that says so.
    pub(crate) fn unpaced() -> Self {
        Self {
            paced: false,
            admitted: 0,
            refused: Uint32Array::new(Vec::new()),
            codes: Uint8Array::new(Vec::new()),
        }
    }
}

/// One deferred per-target failure, drained from the reports ring.
///
/// Successes are never reported: a broadcast to 10,000 healthy subscribers
/// produces nothing here, which is the same "cost proportional to what went
/// wrong" property the synchronous envelope has.
#[napi(object)]
pub struct MirrorReportEntry {
    /// The session id, as the caller wrote it in its target list.
    pub target: String,
    /// A [`MirrorFailure`] as its wire `u8`, decoded through the same
    /// TypeScript table the synchronous envelope uses.
    pub code: u8,
}

/// The same envelope in plain Rust, which is what the fan-out produces.
///
/// Deliberately not the `#[napi(object)]` type: constructing a napi typed array
/// links against the host's N-API symbols, which the `cargo test` binary does
/// not have. Keeping the fan-out napi-free is what makes it unit-testable at
/// all, and the conversion happens once, in the binding.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct MirrorOutcome {
    pub(crate) sent: usize,
    pub(crate) failed: Vec<u32>,
    pub(crate) codes: Vec<u8>,
}

impl MirrorOutcome {
    fn record(&mut self, index: usize, failure: MirrorFailure) {
        self.failed.push(index as u32);
        self.codes.push(failure as u8);
    }

    pub(crate) fn into_napi(self) -> DatagramMirrorResult {
        DatagramMirrorResult {
            sent: self.sent as u32,
            failed: Uint32Array::new(self.failed),
            codes: Uint8Array::new(self.codes),
        }
    }

    /// Read the same outcome as an **admission**.
    ///
    /// The fan-out is shared with the synchronous path deliberately — one
    /// implementation of "attempt every target, report the ones that said no" —
    /// but on the paced path the successful count is not a send. It is renamed
    /// here, once, at the boundary, so `sent` never reaches the paced surface.
    pub(crate) fn into_admission_napi(self) -> DatagramMirrorAdmission {
        DatagramMirrorAdmission {
            paced: true,
            admitted: self.sent as u32,
            refused: Uint32Array::new(self.failed),
            codes: Uint8Array::new(self.codes),
        }
    }
}

/// How much of a caller's target list one call may attempt, and how many
/// indices past it have to be reported rather than dropped.
pub(crate) fn split_at_cap(len: usize) -> usize {
    len.min(DATAGRAM_MIRROR_MAX as usize)
}

/// Fan one payload out over `targets`, attempting every one of them.
///
/// `send_one` returns `None` when the target took the payload and `Some(code)`
/// when it did not. It is called exactly once per in-cap target, in list order,
/// with no wait between them — the loop is the whole call.
pub(crate) fn fan_out<F>(targets_len: usize, mut send_one: F) -> MirrorOutcome
where
    F: FnMut(usize) -> Option<&'static str>,
{
    let take = split_at_cap(targets_len);
    let mut outcome = MirrorOutcome::default();
    for index in 0..take {
        match send_one(index) {
            None => outcome.sent += 1,
            Some(code) => outcome.record(index, MirrorFailure::from_code(code)),
        }
    }
    for index in take..targets_len {
        outcome.record(index, MirrorFailure::TooManyTargets);
    }
    debug_assert_eq!(outcome.sent + outcome.failed.len(), targets_len);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_target_list_produces_an_empty_envelope() {
        let result = fan_out(0, |_| unreachable!("nothing to send"));
        assert_eq!(result.sent, 0);
        assert!(result.failed.is_empty());
        assert!(result.codes.is_empty());
    }

    #[test]
    fn every_target_is_attempted_and_a_failure_does_not_stop_the_fan_out() {
        let mut attempted = Vec::new();
        let result = fan_out(5, |index| {
            attempted.push(index);
            if index == 0 {
                Some("E_SESSION_CLOSED")
            } else {
                None
            }
        });
        assert_eq!(
            attempted,
            vec![0, 1, 2, 3, 4],
            "a dead target at index 0 must not end the broadcast"
        );
        assert_eq!(result.sent, 4);
        assert_eq!(result.failed, &[0]);
        assert_eq!(result.codes, &[MirrorFailure::SessionClosed as u8]);
    }

    #[test]
    fn failures_carry_their_own_index_and_code_in_target_order() {
        let result = fan_out(4, |index| match index {
            1 => Some(crate::session::WOULD_BLOCK),
            3 => Some("E_QUEUE_FULL"),
            _ => None,
        });
        assert_eq!(result.sent, 2);
        assert_eq!(result.failed, &[1, 3]);
        assert_eq!(
            result.codes,
            &[
                MirrorFailure::WouldBlock as u8,
                MirrorFailure::QueueFull as u8
            ]
        );
    }

    #[test]
    fn sent_and_failed_always_account_for_every_target() {
        for failing in [0usize, 1, 3, 8] {
            let result = fan_out(8, |index| {
                if index % 3 == failing % 3 {
                    Some("E_SESSION_CLOSED")
                } else {
                    None
                }
            });
            assert_eq!(
                result.sent + result.failed.len(),
                8,
                "the envelope must account for every target"
            );
        }
    }

    #[test]
    fn an_unmapped_code_degrades_to_queue_full_rather_than_panicking() {
        assert_eq!(
            MirrorFailure::from_code("E_SOMETHING_NEW"),
            MirrorFailure::QueueFull
        );
        assert_eq!(
            MirrorFailure::from_code("E_SESSION_CLOSED"),
            MirrorFailure::SessionClosed
        );
        assert_eq!(
            MirrorFailure::from_code(crate::session::WOULD_BLOCK),
            MirrorFailure::WouldBlock
        );
    }

    #[test]
    fn the_over_cap_tail_is_reported_rather_than_dropped() {
        let cap = DATAGRAM_MIRROR_MAX as usize;
        let mut attempted = 0usize;
        let result = fan_out(cap + 3, |_| {
            attempted += 1;
            None
        });
        assert_eq!(attempted, cap, "only the in-cap prefix is attempted");
        assert_eq!(result.sent, cap);
        assert_eq!(result.failed, &[cap as u32, cap as u32 + 1, cap as u32 + 2]);
        assert!(result
            .codes
            .iter()
            .all(|code| *code == MirrorFailure::TooManyTargets as u8));
    }

    #[test]
    fn the_cap_is_the_only_bound_on_the_attempted_prefix() {
        let cap = DATAGRAM_MIRROR_MAX as usize;
        assert_eq!(split_at_cap(0), 0);
        assert_eq!(split_at_cap(1), 1);
        assert_eq!(split_at_cap(cap), cap);
        assert_eq!(split_at_cap(cap + 1), cap);
    }
}
