//! Shared vocabulary for batched datagram calls: the one cap, the reject-free
//! result envelope, and the synchronous pre-pass every send batch owes.
//!
//! Both handles (`SessionHandle` in `session_napi.rs` and `ClientSessionHandle`
//! in `client.rs`) are genuinely separate types with separate send mechanics.
//! What they share lives here, so the cap cannot drift and the envelope cannot
//! mean two different things on the two surfaces.

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

/// Largest batch one datagram call may carry — receive or send, server or
/// client. This is the only definition; `packages/webtransport/test/
/// datagram-send-batch.test.ts` asserts the TypeScript constant matches it and
/// that no second definition has appeared.
///
/// The point of batching is amortizing the N-API round trip, and the win is
/// already flat well before here; a larger cap only widens the window in which
/// payloads are held outside the queue's byte reservation.
pub(crate) const DATAGRAM_BATCH_MAX: u32 = 256;

/// Outcome of one batched send, with **prefix** semantics: `sent = k` means
/// elements `0..k` went out, in order; `code` (when present) is why element `k`
/// failed; elements after `k` were never attempted. `sent == input.len()` with
/// no `code` is full success.
///
/// It is a resolved value rather than a rejection because a rejected async
/// N-API call leaks a strong self-reference on its handle under Bun. It is a
/// single counter rather than a per-element array because the array would put
/// an N-sized allocation and an N-sized crossing back into the return path —
/// the exact cost batching exists to remove. At N=1 it degenerates to today's
/// single-datagram behavior: `{sent: 1}` is a resolve, `{sent: 0, code}` a
/// throw.
#[napi(object)]
pub struct DatagramBatchResult {
    pub sent: u32,
    pub code: Option<String>,
}

impl DatagramBatchResult {
    pub(crate) fn new(sent: usize, code: Option<String>) -> Self {
        Self {
            sent: sent as u32,
            code,
        }
    }
}

/// Payloads copied out of JS-owned memory, plus the reason the copy stopped
/// short of the caller's array.
pub(crate) struct PreparedBatch {
    pub items: Vec<Vec<u8>>,
    /// `Some("E_BATCH_TOO_LARGE")` when the caller handed over more than
    /// `DATAGRAM_BATCH_MAX` elements. Reported only once every prepared item
    /// has actually been sent — a truncation is not an error about element `k`.
    pub truncated: Option<String>,
}

/// Copy every payload out of the caller's arrays **before** anything awaits.
///
/// `Uint8Array` is not `Send`, so the copy is forced by the type system, but it
/// is also the contract: a caller may reuse or mutate its arrays the moment the
/// promise is returned, and the peer must still receive the bytes it passed.
/// The copy is ~0.2 µs against a ~15 µs per-crossing saving, so it is free in
/// the only sense that matters.
///
/// Over-cap input is truncated rather than clamped away silently: the read path
/// treats `max` as a hint and clamping is right there, but silently discarding
/// elements 256..N of a *send* would lose data. The TypeScript layer chunks so
/// no ordinary caller ever reaches this; a raw-addon caller gets the honest
/// `{sent: <=256, code: "E_BATCH_TOO_LARGE"}` and can re-call with the rest.
pub(crate) fn prepare_batch(data: &[Uint8Array]) -> PreparedBatch {
    let cap = DATAGRAM_BATCH_MAX as usize;
    let take = data.len().min(cap);
    let items = data[..take].iter().map(|item| item.to_vec()).collect();
    let truncated = (data.len() > cap).then(|| "E_BATCH_TOO_LARGE".to_string());
    PreparedBatch { items, truncated }
}

/// Send a prepared batch element by element, stopping at the first failure.
///
/// Oversize elements, a closed session and an expired backpressure deadline all
/// take this one exit: the caller learns exactly which element is bad from
/// `index == sent`, drops it, and re-calls with the remainder. Skip-and-report
/// was rejected because a single `sent` counter cannot say which element was
/// dropped, so it would silently lose data.
pub(crate) async fn send_prepared<F, Fut>(
    prepared: PreparedBatch,
    mut send_one: F,
) -> DatagramBatchResult
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = std::result::Result<(), String>>,
{
    let mut sent = 0usize;
    for item in prepared.items {
        if let Err(code) = send_one(item).await {
            return DatagramBatchResult::new(sent, Some(code));
        }
        sent += 1;
    }
    DatagramBatchResult::new(sent, prepared.truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_prepares_nothing_and_reports_no_truncation() {
        let prepared = prepare_batch(&[]);
        assert!(prepared.items.is_empty());
        assert!(prepared.truncated.is_none());
    }

    #[tokio::test]
    async fn a_prepared_batch_reports_full_success() {
        let prepared = PreparedBatch {
            items: vec![vec![1], vec![2], vec![3]],
            truncated: None,
        };
        let result = send_prepared(prepared, |_| async { Ok(()) }).await;
        assert_eq!(result.sent, 3);
        assert!(result.code.is_none());
    }

    #[tokio::test]
    async fn the_first_failure_ends_the_batch_and_names_its_index() {
        let prepared = PreparedBatch {
            items: vec![vec![1], vec![2], vec![3]],
            truncated: None,
        };
        let mut seen = 0usize;
        let result = send_prepared(prepared, |_| {
            seen += 1;
            let fail = seen == 2;
            async move {
                if fail {
                    Err("E_QUEUE_FULL".to_string())
                } else {
                    Ok(())
                }
            }
        })
        .await;
        assert_eq!(
            result.sent, 1,
            "element 1 failed, so elements 0..1 went out"
        );
        assert_eq!(result.code.as_deref(), Some("E_QUEUE_FULL"));
        assert_eq!(seen, 2, "elements after the failure are not attempted");
    }

    #[tokio::test]
    async fn truncation_is_reported_only_after_every_prepared_item_is_sent() {
        let prepared = PreparedBatch {
            items: vec![vec![1], vec![2]],
            truncated: Some("E_BATCH_TOO_LARGE".to_string()),
        };
        let result = send_prepared(prepared, |_| async { Ok(()) }).await;
        assert_eq!(result.sent, 2);
        assert_eq!(result.code.as_deref(), Some("E_BATCH_TOO_LARGE"));
    }

    #[tokio::test]
    async fn a_failure_outranks_truncation() {
        let prepared = PreparedBatch {
            items: vec![vec![1], vec![2]],
            truncated: Some("E_BATCH_TOO_LARGE".to_string()),
        };
        let result =
            send_prepared(prepared, |_| async { Err("E_SESSION_CLOSED".to_string()) }).await;
        assert_eq!(result.sent, 0);
        assert_eq!(result.code.as_deref(), Some("E_SESSION_CLOSED"));
    }
}
