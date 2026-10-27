//! Cross-stream batched receive delivery: one N-API crossing hands JavaScript
//! the queued chunks of many streams.
//!
//! G11's arm-T diagnosis (D35) located the app path's cost in the crossings,
//! not in per-chunk latency: at 100 streams × 3 Mbps the JS reader made ~26 k
//! crossings a second of ~1.4 KB each, every one a separate promise
//! resolution on the JS thread. `readBatch` cannot help there — each stream
//! only ever has one frame queued when its read parks. The native frame sink
//! (`frame_sink.rs`) showed that a drain across streams removes the cost, but
//! it moved the deframe and the stamp into native code and polled its ring on
//! an idle timer, which inflated the app-level p99 by the timer period.
//!
//! A **read group** keeps everything the product read path does and changes
//! only how bytes reach the JS thread:
//!
//!  * each stream runs a *feeder* (`feedReadGroup` on its handle) that loops
//!    the handle's own `read_batch_inner` — the same bridge, budgets, and
//!    terminal semantics `readBatch` crosses into — and pushes each batch,
//!    EOF, or error code into the group's queue;
//!  * the group's `next()` is woken by a [`Notify`] the first push signals —
//!    no idle timer — and its result is **drained on the JS thread** when the
//!    promise resolves, so every entry queued while the event loop was busy
//!    rides the same crossing;
//!  * JavaScript demultiplexes the entries into each stream's web readable,
//!    and the delivery stamp is taken there, as it always was.
//!
//! **Backpressure** is a per-stream byte credit. A feeder reads only while its
//! credit is positive and each delivered batch spends its length, so at most
//! one window plus one batch is ever queued per stream; JavaScript re-grants
//! the window as the stream's consumer drains it (`grant`). A consumer that
//! stops reading stops its feeder, which leaves the bytes in the transport
//! where QUIC flow control pushes back on the peer — the same contract a
//! parked `read` gives.
//!
//! On by default in the JS layer (`WEBTRANSPORT_STREAM_READ_GROUP=0` turns
//! it off); the group is created lazily on the first accepted stream, and
//! nothing creates one when the knob is off.

use napi::bindgen_prelude::{Null, ToNapiValue, TypeName};
use napi::Result;
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Notify;

use crate::client_stream::CoalescedChunks;
use crate::payload_buffer::PayloadBuffer;

/// One feeder read's bytes, in the shape the handle's own read produced:
/// `readBatch`'s coalesced chunks when the batch knob is on, `read`'s single
/// payload when it is off — so a group-fed stream crosses exactly the chunks
/// its direct readable would have, only many streams at a time.
pub(crate) enum FeedChunk {
    Batch(CoalescedChunks),
    Single(PayloadBuffer),
}

impl FeedChunk {
    fn len(&self) -> usize {
        match self {
            FeedChunk::Batch(batch) => batch.len(),
            FeedChunk::Single(payload) => payload.as_ref().len(),
        }
    }
}

/// What one queued entry carries.
pub(crate) enum GroupPayload {
    Data(FeedChunk),
    End,
    Error(String),
}

struct GroupEntry {
    key: u32,
    payload: GroupPayload,
}

/// One stream's credit: bytes its feeder may still read before JavaScript
/// grants more. Signed because a batch may overshoot the remainder by up to
/// one batch.
pub(crate) struct Credit {
    available: AtomicI64,
    cancelled: AtomicBool,
    notify: Notify,
}

impl Credit {
    fn new(window: i64) -> Self {
        Self {
            available: AtomicI64::new(window),
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

#[derive(Default)]
struct GroupQueue {
    entries: VecDeque<GroupEntry>,
    /// Set by `wake`: the pending `next` resolves even with nothing queued,
    /// so the JS pump can observe that it has no streams left and stop.
    woken: bool,
}

/// Live feeders' credits, and keys cancelled before their feeder registered.
/// One lock covers both, so a cancel and a registration can never miss each
/// other: whichever comes second sees the first.
#[derive(Default)]
struct Credits {
    live: HashMap<u32, Arc<Credit>>,
    cancelled_early: HashSet<u32>,
    /// Insertion order of `cancelled_early`, for its bound.
    cancelled_order: VecDeque<u32>,
}

/// `cancelled_early` only has to bridge the microseconds between a feeder's
/// start and its registration. A cancel that lands after a feeder already
/// unregistered (its last entry still in flight to JavaScript) also lands
/// here and is never consumed, so the set is bounded: the oldest key is
/// forgotten first, and no real early cancel is that old.
const CANCELLED_EARLY_CAP: usize = 1024;

/// What a feeder's registration found.
enum Registration {
    Fed(Arc<Credit>),
    Duplicate,
    CancelledEarly,
}

pub(crate) struct GroupShared {
    queue: Mutex<GroupQueue>,
    ready: Notify,
    closed: AtomicBool,
    credits: Mutex<Credits>,
    /// Data entries a feeder produced with `read_batch_inner` (the batch knob
    /// on) — measured here, where the read happened, so the harness's knob
    /// provenance check grades what ran rather than what was configured.
    batched_entries: AtomicU64,
    /// Every data entry a feeder produced, counted beside `batched_entries`
    /// so the two are compared on one side in one window.
    data_entries: AtomicU64,
}

impl GroupShared {
    fn new() -> Self {
        Self {
            queue: Mutex::new(GroupQueue::default()),
            ready: Notify::new(),
            closed: AtomicBool::new(false),
            credits: Mutex::new(Credits::default()),
            batched_entries: AtomicU64::new(0),
            data_entries: AtomicU64::new(0),
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Queue one entry and wake `next`. A closed group drops the entry, which
    /// releases the batch's byte reservations with it.
    fn push(&self, key: u32, payload: GroupPayload) {
        if self.is_closed() {
            return;
        }
        if let Ok(mut queue) = self.queue.lock() {
            queue.entries.push_back(GroupEntry { key, payload });
        }
        // `notify_one` stores a permit when `next` is not parked yet, so a
        // push between `next`'s empty check and its await is never lost.
        self.ready.notify_one();
    }

    fn register(&self, key: u32, window: i64) -> Registration {
        let Ok(mut credits) = self.credits.lock() else {
            return Registration::Duplicate;
        };
        if credits.cancelled_early.remove(&key) {
            credits.cancelled_order.retain(|k| *k != key);
            return Registration::CancelledEarly;
        }
        if credits.live.contains_key(&key) {
            return Registration::Duplicate;
        }
        let credit = Arc::new(Credit::new(window));
        credits.live.insert(key, credit.clone());
        Registration::Fed(credit)
    }

    fn unregister(&self, key: u32, credit: &Arc<Credit>) {
        if let Ok(mut credits) = self.credits.lock() {
            if credits
                .live
                .get(&key)
                .is_some_and(|c| Arc::ptr_eq(c, credit))
            {
                credits.live.remove(&key);
            }
        }
    }

    fn credit(&self, key: u32) -> Option<Arc<Credit>> {
        self.credits.lock().ok()?.live.get(&key).cloned()
    }

    /// Stop `key`'s feeder at its next credit check; a key whose feeder has
    /// not registered yet is remembered, and its registration then ends the
    /// feeder before it reads anything.
    fn cancel(&self, key: u32) {
        let Ok(mut credits) = self.credits.lock() else {
            return;
        };
        match credits.live.get(&key) {
            Some(credit) => {
                credit.cancelled.store(true, Ordering::Release);
                credit.notify.notify_one();
            }
            None => {
                if credits.cancelled_early.insert(key) {
                    credits.cancelled_order.push_back(key);
                }
                while credits.cancelled_order.len() > CANCELLED_EARLY_CAP {
                    if let Some(old) = credits.cancelled_order.pop_front() {
                        credits.cancelled_early.remove(&old);
                    }
                }
            }
        }
    }

    fn has_ready(&self) -> bool {
        self.queue
            .lock()
            .map(|q| !q.entries.is_empty() || q.woken)
            .unwrap_or(true)
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut queue) = self.queue.lock() {
            queue.entries.clear();
        }
        self.ready.notify_one();
        if let Ok(credits) = self.credits.lock() {
            for credit in credits.live.values() {
                credit.notify.notify_one();
            }
        }
    }
}

static NEXT_GROUP_ID: AtomicU32 = AtomicU32::new(1);
static GROUPS: Lazy<Mutex<HashMap<u32, Weak<GroupShared>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub(crate) fn lookup_group(id: u32) -> Option<Arc<GroupShared>> {
    GROUPS.lock().ok()?.get(&id)?.upgrade()
}

/// The feeder loop both receive handles run: read under credit, push what
/// came back, stop at the stream's terminal event, a cancel, or group close.
///
/// `read` is the handle's own read (`read_batch_inner` or `read_inner`), so a
/// feeder delivers exactly what the direct readable would, in the same order,
/// with the same terminal events.
pub(crate) async fn run_feeder<F, Fut>(
    group: Arc<GroupShared>,
    key: u32,
    window: u32,
    mut read: F,
) -> Option<String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<FeedChunk>>>,
{
    if window == 0 {
        return Some("E_INVALID_ARGUMENT: read group window must be positive".to_string());
    }
    let credit = match group.register(key, i64::from(window)) {
        Registration::Fed(credit) => credit,
        Registration::CancelledEarly => return None,
        Registration::Duplicate => {
            return Some("E_INVALID_ARGUMENT: read group key already fed".to_string())
        }
    };
    loop {
        // Park until JavaScript grants credit, the stream is cancelled, or
        // the group closes. `notify_one` permits make a grant that lands
        // between the check and the await wake this wait.
        loop {
            if group.is_closed() || credit.cancelled.load(Ordering::Acquire) {
                group.unregister(key, &credit);
                return None;
            }
            if credit.available.load(Ordering::Acquire) > 0 {
                break;
            }
            credit.notify.notified().await;
        }
        match read().await {
            Ok(Some(chunk)) => {
                credit
                    .available
                    .fetch_sub(chunk.len() as i64, Ordering::AcqRel);
                group.data_entries.fetch_add(1, Ordering::Relaxed);
                if matches!(chunk, FeedChunk::Batch(_)) {
                    group.batched_entries.fetch_add(1, Ordering::Relaxed);
                }
                group.push(key, GroupPayload::Data(chunk));
            }
            Ok(None) => {
                group.push(key, GroupPayload::End);
                break;
            }
            Err(error) => {
                group.push(key, GroupPayload::Error(error.reason.clone()));
                break;
            }
        }
    }
    group.unregister(key, &credit);
    None
}

/// The result of one `next()`: drained on the JS thread at resolution, so it
/// carries everything queued by then rather than what was queued at wake.
pub struct GroupBatch {
    shared: Arc<GroupShared>,
    max_entries: usize,
}

impl TypeName for GroupBatch {
    fn type_name() -> &'static str {
        "Array"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl ToNapiValue for GroupBatch {
    /// A flat array `[key0, value0, key1, value1, ...]`: each value is the
    /// batch's `Uint8Array`, `null` for EOF, or the error code string — the
    /// same three shapes `readBatch` resolves with.
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        let drained: Vec<GroupEntry> = match val.shared.queue.lock() {
            Ok(mut queue) => {
                queue.woken = false;
                let n = queue.entries.len().min(val.max_entries.max(1));
                queue.entries.drain(..n).collect()
            }
            Err(_) => Vec::new(),
        };
        let mut array = std::ptr::null_mut();
        napi::check_status!(unsafe {
            napi::sys::napi_create_array_with_length(env, drained.len() * 2, &mut array)
        })?;
        for (i, entry) in drained.into_iter().enumerate() {
            let key = unsafe { u32::to_napi_value(env, entry.key)? };
            let value = match entry.payload {
                GroupPayload::Data(FeedChunk::Batch(batch)) => unsafe {
                    CoalescedChunks::to_napi_value(env, batch)?
                },
                GroupPayload::Data(FeedChunk::Single(payload)) => unsafe {
                    PayloadBuffer::to_napi_value(env, payload)?
                },
                GroupPayload::End => unsafe { Null::to_napi_value(env, Null)? },
                GroupPayload::Error(code) => unsafe { String::to_napi_value(env, code)? },
            };
            let at = (i * 2) as u32;
            napi::check_status!(unsafe { napi::sys::napi_set_element(env, array, at, key) })?;
            napi::check_status!(unsafe { napi::sys::napi_set_element(env, array, at + 1, value) })?;
        }
        Ok(array)
    }
}

/// A process-level receive queue shared by many streams (see module docs).
#[napi]
pub struct StreamReadGroup {
    shared: Arc<GroupShared>,
    id: u32,
}

impl Default for StreamReadGroup {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl StreamReadGroup {
    #[napi(constructor)]
    pub fn new() -> Self {
        let shared = Arc::new(GroupShared::new());
        let id = NEXT_GROUP_ID.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut groups) = GROUPS.lock() {
            groups.retain(|_, weak| weak.strong_count() > 0);
            groups.insert(id, Arc::downgrade(&shared));
        }
        Self { shared, id }
    }

    /// The id a handle's `feedReadGroup` names this group by.
    #[napi(getter)]
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Resolve with up to `max_entries` queued entries once at least one is
    /// queued (or `wake` was called); null once the group is closed. Never
    /// rejects.
    #[napi]
    pub async fn next(&self, max_entries: u32) -> Option<GroupBatch> {
        loop {
            if self.shared.is_closed() {
                return None;
            }
            if self.shared.has_ready() {
                return Some(GroupBatch {
                    shared: self.shared.clone(),
                    max_entries: max_entries as usize,
                });
            }
            self.shared.ready.notified().await;
        }
    }

    /// Return `bytes` of credit to stream `key`'s feeder. A key with no live
    /// feeder is ignored: the stream already ended.
    #[napi]
    pub fn grant(&self, key: u32, bytes: u32) {
        if let Some(credit) = self.shared.credit(key) {
            credit
                .available
                .fetch_add(i64::from(bytes), Ordering::AcqRel);
            credit.notify.notify_one();
        }
    }

    /// Stop stream `key`'s feeder at its next credit check. A read already in
    /// flight completes (the owner's stop/reset/dispose aborts it), and what it
    /// returns is still queued; the JS side drops entries for a cancelled key.
    /// A cancel that lands before the feeder registered is remembered and ends
    /// that feeder at registration, before it reads anything. (The JS pump
    /// cancels only feeders it has not seen a terminal entry from, so a
    /// remembered key is not left behind by streams that already ended,
    /// except for a cancel racing the feeder's own last entry — one key.)
    #[napi]
    pub fn cancel(&self, key: u32) {
        self.shared.cancel(key);
    }

    /// Every data entry the feeders produced since the group was made
    /// (monotonic; compared with `batchedEntries` on the same side).
    #[napi(getter)]
    pub fn data_entries(&self) -> f64 {
        self.shared.data_entries.load(Ordering::Relaxed) as f64
    }

    /// Resolve the pending `next` even if nothing is queued.
    #[napi]
    pub fn wake(&self) {
        if let Ok(mut queue) = self.shared.queue.lock() {
            queue.woken = true;
        }
        self.shared.ready.notify_one();
    }

    /// Close the group: `next` resolves null, feeders stop at their next
    /// credit check, and queued entries are dropped.
    #[napi]
    pub fn close(&self) {
        self.shared.close();
    }

    /// Data entries produced by the batched read since the group was made
    /// (monotonic; the JS instrument windows it by subtraction).
    #[napi(getter)]
    pub fn batched_entries(&self) -> f64 {
        self.shared.batched_entries.load(Ordering::Relaxed) as f64
    }

    /// Entries queued and not yet drained (diagnostics and tests).
    #[napi(getter)]
    pub fn queued(&self) -> u32 {
        self.shared
            .queue
            .lock()
            .map(|q| q.entries.len() as u32)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(len: usize) -> Result<Option<FeedChunk>> {
        Ok(Some(FeedChunk::Batch(CoalescedChunks::for_tests(vec![
            7u8;
            len
        ]))))
    }

    fn drain(shared: &GroupShared) -> Vec<(u32, &'static str, usize)> {
        let mut queue = shared.queue.lock().unwrap();
        queue
            .entries
            .drain(..)
            .map(|e| match e.payload {
                GroupPayload::Data(b) => (e.key, "data", b.len()),
                GroupPayload::End => (e.key, "end", 0),
                GroupPayload::Error(_) => (e.key, "error", 0),
            })
            .collect()
    }

    #[tokio::test]
    async fn feeder_delivers_batches_then_eof_in_order() {
        let shared = Arc::new(GroupShared::new());
        let mut script = vec![data(10), data(20), Ok(None)].into_iter();
        let out = run_feeder(shared.clone(), 3, 1 << 20, || {
            let next = script.next().unwrap();
            async move { next }
        })
        .await;
        assert!(out.is_none());
        assert_eq!(
            drain(&shared),
            vec![(3, "data", 10), (3, "data", 20), (3, "end", 0)]
        );
        assert!(shared.credit(3).is_none(), "an ended feeder unregisters");
        assert_eq!(shared.batched_entries.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn feeder_forwards_the_error_code_and_stops() {
        let shared = Arc::new(GroupShared::new());
        let mut calls = 0;
        run_feeder(shared.clone(), 1, 1 << 20, || {
            calls += 1;
            async { Err(napi::Error::from_reason("E_STREAM_RESET")) }
        })
        .await;
        assert_eq!(calls, 1);
        let mut queue = shared.queue.lock().unwrap();
        match &queue.entries.pop_front().unwrap().payload {
            GroupPayload::Error(code) => assert_eq!(code, "E_STREAM_RESET"),
            _ => panic!("expected the error entry"),
        }
    }

    #[tokio::test]
    async fn feeder_parks_without_credit_until_granted() {
        let shared = Arc::new(GroupShared::new());
        let reads = Arc::new(AtomicU32::new(0));
        let r = reads.clone();
        let task = tokio::spawn(run_feeder(shared.clone(), 9, 100, move || {
            r.fetch_add(1, Ordering::SeqCst);
            async { data(100) }
        }));
        // One read spends the whole 100-byte window; the feeder must park.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let credit = shared.credit(9).unwrap();
        credit.available.fetch_add(150, Ordering::AcqRel);
        credit.notify.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        // 150 of credit allows two more 100-byte reads (the second overshoots
        // by one batch, never more), then it parks again.
        assert_eq!(reads.load(Ordering::SeqCst), 3);
        credit.cancelled.store(true, Ordering::Release);
        credit.notify.notify_one();
        assert!(task.await.unwrap().is_none());
        assert!(shared.credit(9).is_none());
    }

    #[tokio::test]
    async fn closing_the_group_stops_feeders_and_drops_entries() {
        let shared = Arc::new(GroupShared::new());
        let task = tokio::spawn(run_feeder(shared.clone(), 2, 10, || async { data(10) }));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        shared.close();
        assert!(task.await.unwrap().is_none());
        shared.push(2, GroupPayload::End);
        assert!(drain(&shared).is_empty(), "a closed group queues nothing");
    }

    #[tokio::test]
    async fn a_key_cannot_be_fed_twice_and_window_must_be_positive() {
        let shared = Arc::new(GroupShared::new());
        let Registration::Fed(_held) = shared.register(5, 10) else {
            panic!("first registration must feed");
        };
        let dup = run_feeder(shared.clone(), 5, 10, || async { data(1) }).await;
        assert!(dup.unwrap().contains("already fed"));
        let zero = run_feeder(shared.clone(), 6, 0, || async { data(1) }).await;
        assert!(zero.unwrap().contains("window"));
    }

    #[tokio::test]
    async fn a_cancel_before_registration_ends_the_feeder_unread() {
        let shared = Arc::new(GroupShared::new());
        shared.cancel(4);
        let mut reads = 0;
        let out = run_feeder(shared.clone(), 4, 100, || {
            reads += 1;
            async { data(1) }
        })
        .await;
        assert!(out.is_none());
        assert_eq!(reads, 0, "a pre-cancelled feeder reads nothing");
        assert!(drain(&shared).is_empty());
        let credits = shared.credits.lock().unwrap();
        assert!(credits.cancelled_early.is_empty());
        assert!(credits.cancelled_order.is_empty());
    }

    #[test]
    fn late_cancels_of_finished_feeders_stay_bounded() {
        let shared = GroupShared::new();
        for key in 0..5000 {
            shared.cancel(key);
        }
        let credits = shared.credits.lock().unwrap();
        assert_eq!(credits.cancelled_early.len(), CANCELLED_EARLY_CAP);
        assert_eq!(credits.cancelled_order.len(), CANCELLED_EARLY_CAP);
        assert!(credits.cancelled_early.contains(&4999));
        assert!(!credits.cancelled_early.contains(&0));
    }

    #[tokio::test]
    async fn data_and_batched_counts_are_kept_side_by_side() {
        let shared = Arc::new(GroupShared::new());
        let mut script = vec![
            Ok(Some(FeedChunk::Single(PayloadBuffer::from(vec![1u8; 3])))),
            data(4),
            Ok(None),
        ]
        .into_iter();
        run_feeder(shared.clone(), 8, 1 << 20, || {
            let next = script.next().unwrap();
            async move { next }
        })
        .await;
        assert_eq!(shared.data_entries.load(Ordering::Relaxed), 2);
        assert_eq!(shared.batched_entries.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_push_before_next_parks_is_not_lost() {
        let shared = Arc::new(GroupShared::new());
        shared.push(1, GroupPayload::End);
        // The stored permit (or the non-empty check) must let this finish.
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !shared.has_ready() {
                shared.ready.notified().await;
            }
        })
        .await
        .expect("next would have hung");
    }
}
