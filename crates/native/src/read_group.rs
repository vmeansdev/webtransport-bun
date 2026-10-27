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
//! **Backpressure is demand.** A feeder reads only while its byte credit is
//! positive and each read spends its length. JavaScript grants credit only
//! for a read the stream's consumer is actually waiting on (one byte of
//! credit per outstanding pull, `grant`), so a feeder makes exactly the reads
//! the direct readable would have made, never more: nothing is read ahead
//! of the consumer. That keeps the receive budgets
//! (`maxQueuedBytesGlobal` / `PerSession` / `PerStream`) authoritative — the
//! bytes a stalled consumer has not asked for stay in the transport under
//! QUIC flow control and the native reservations, exactly as with a parked
//! `read`, instead of sitting in a JavaScript queue no budget sees. What the
//! group saves is unchanged: every stream whose read completed while the
//! event loop was busy crosses in one `next()` resolution.
//!
//! **Lifecycle.** JavaScript `prepare`s a key synchronously before it calls
//! `feedReadGroup`, so a key's native state exists from the moment JavaScript
//! could cancel it: a cancel either finds the key (prepared or feeding) or
//! the key's feeder already ended, and nothing has to be remembered for a
//! feeder that has not registered yet.
//!
//! On by default in the JS layer (`WEBTRANSPORT_STREAM_READ_GROUP=0` turns
//! it off); the group is created lazily on the first accepted stream, and
//! nothing creates one when the knob is off.

use napi::bindgen_prelude::{Null, ToNapiValue, TypeName};
use napi::Result;
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::{HashMap, VecDeque};
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
/// grants more. Signed because a read overshoots the remainder by up to one
/// chunk (one byte of credit admits one read).
pub(crate) struct Credit {
    available: AtomicI64,
    cancelled: AtomicBool,
    /// Set when the key's feeder claims the prepared credit.
    claimed: AtomicBool,
    notify: Notify,
}

impl Credit {
    fn new(initial: i64) -> Self {
        Self {
            available: AtomicI64::new(initial),
            cancelled: AtomicBool::new(false),
            claimed: AtomicBool::new(false),
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

/// Prepared and feeding keys' credits: exactly the keys JavaScript may still
/// cancel, so the map is bounded by live streams and nothing else.
#[derive(Default)]
struct Credits {
    live: HashMap<u32, Arc<Credit>>,
}

/// What a feeder's claim of its prepared key found.
enum Registration {
    Fed(Arc<Credit>),
    /// The key is already being fed.
    Duplicate,
    /// The key is not prepared: it was cancelled before the feeder started
    /// (cancel removes an unclaimed key), or never prepared.
    NotPrepared,
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

    /// Queue one entry and wake `next` (tests; feeders use `push_fed`). A
    /// closed group drops the entry, which releases its reservations.
    #[cfg(test)]
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

    /// Queue a feeder's entry unless its key was cancelled (or the group
    /// closed). The check runs under the queue lock, which `cancel` also
    /// holds while it marks the key and purges its queued entries, so a read
    /// that completes after a cancel can never leave an entry behind that no
    /// `next()` would drain: it is dropped here, releasing its reservations.
    fn push_fed(&self, key: u32, credit: &Credit, payload: GroupPayload) {
        let rejected = match self.queue.lock() {
            Ok(mut queue) => {
                if self.is_closed() || credit.cancelled.load(Ordering::Acquire) {
                    Some(payload)
                } else {
                    queue.entries.push_back(GroupEntry { key, payload });
                    None
                }
            }
            Err(_) => Some(payload),
        };
        if rejected.is_none() {
            self.ready.notify_one();
        }
        // Dropped outside the lock: a batch's drop releases its budget.
        drop(rejected);
    }

    /// Create `key`'s credit before its feeder starts. Fails if the key is
    /// still live (prepared or feeding) or the credit is not positive.
    fn prepare(&self, key: u32, initial: i64) -> std::result::Result<(), &'static str> {
        if initial <= 0 {
            return Err("E_INVALID_ARGUMENT: read group credit must be positive");
        }
        let Ok(mut credits) = self.credits.lock() else {
            return Err("E_INTERNAL: read group lock poisoned");
        };
        if credits.live.contains_key(&key) {
            return Err("E_INVALID_ARGUMENT: read group key already live");
        }
        credits.live.insert(key, Arc::new(Credit::new(initial)));
        Ok(())
    }

    /// The feeder takes its prepared credit.
    fn claim(&self, key: u32) -> Registration {
        let Ok(credits) = self.credits.lock() else {
            return Registration::NotPrepared;
        };
        match credits.live.get(&key) {
            None => Registration::NotPrepared,
            Some(credit) => {
                if credit.claimed.swap(true, Ordering::AcqRel) {
                    Registration::Duplicate
                } else {
                    Registration::Fed(credit.clone())
                }
            }
        }
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

    /// Stop `key`'s feeder at its next credit check. A prepared key whose
    /// feeder has not claimed it yet is removed, so that feeder finds nothing
    /// and ends before it reads. A key that is not live — its feeder already
    /// ended — needs nothing, and nothing is kept for it.
    fn cancel(&self, key: u32) {
        let Ok(mut credits) = self.credits.lock() else {
            return;
        };
        let Some(credit) = credits.live.get(&key).cloned() else {
            return;
        };
        // Mark and purge under the queue lock (see `push_fed`): entries the
        // key already queued are dropped now, and later ones never land.
        let purged: Vec<GroupEntry> = match self.queue.lock() {
            Ok(mut queue) => {
                credit.cancelled.store(true, Ordering::Release);
                let (purged, kept): (Vec<GroupEntry>, Vec<GroupEntry>) =
                    queue.entries.drain(..).partition(|e| e.key == key);
                queue.entries.extend(kept);
                purged
            }
            Err(_) => {
                credit.cancelled.store(true, Ordering::Release);
                Vec::new()
            }
        };
        if credit.claimed.load(Ordering::Acquire) {
            credit.notify.notify_one();
        } else {
            credits.live.remove(&key);
        }
        drop(credits);
        drop(purged);
    }

    /// Payload bytes queued and not yet drained (diagnostics and tests).
    fn queued_bytes(&self) -> usize {
        self.queue
            .lock()
            .map(|q| {
                q.entries
                    .iter()
                    .map(|e| match &e.payload {
                        GroupPayload::Data(chunk) => chunk.len(),
                        _ => 0,
                    })
                    .sum()
            })
            .unwrap_or(0)
    }

    /// Live keys (prepared or feeding): diagnostics and tests.
    fn live_keys(&self) -> usize {
        self.credits.lock().map(|c| c.live.len()).unwrap_or(0)
    }

    /// Take the next entry for a crossing, or None once it is full: at most
    /// `max_entries`, and no data entry that would take the crossing past
    /// `max_bytes` unless it is the first (terminal entries cost nothing). One entry per lock, so the caller
    /// converts and drops each before the next is taken.
    fn take_for_crossing(
        &self,
        taken: &mut CrossingTally,
        max_entries: usize,
        max_bytes: usize,
    ) -> Option<GroupEntry> {
        if taken.entries >= max_entries.max(1) {
            return None;
        }
        let mut queue = self.queue.lock().ok()?;
        let len = match &queue.entries.front()?.payload {
            GroupPayload::Data(chunk) => chunk.len(),
            _ => 0,
        };
        if taken.entries > 0 && len > 0 && taken.bytes + len > max_bytes {
            return None;
        }
        let entry = queue.entries.pop_front()?;
        taken.entries += 1;
        taken.bytes += len;
        Some(entry)
    }

    #[cfg(test)]
    fn queued(&self) -> usize {
        self.queue.lock().map(|q| q.entries.len()).unwrap_or(0)
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

/// Payload bytes one `next()` crossing may carry. A crossing always takes
/// its first entry, then stops before an entry that would exceed this, so
/// one crossing never materializes more than this in JavaScript (or one
/// entry, if a single batch is larger) on top of what is still queued.
pub(crate) const GROUP_CROSSING_MAX_BYTES: usize = 1024 * 1024;

/// What a crossing has taken so far.
#[derive(Default)]
pub(crate) struct CrossingTally {
    entries: usize,
    bytes: usize,
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
    mut read: F,
) -> Option<String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<FeedChunk>>>,
{
    let credit = match group.claim(key) {
        Registration::Fed(credit) => credit,
        // Cancelled before the feeder started: end unread.
        Registration::NotPrepared => return None,
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
                group.push_fed(key, &credit, GroupPayload::Data(chunk));
            }
            Ok(None) => {
                group.push_fed(key, &credit, GroupPayload::End);
                break;
            }
            Err(error) => {
                group.push_fed(key, &credit, GroupPayload::Error(error.reason.clone()));
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
    ///
    /// Entries are taken off the queue **one at a time** and each payload is
    /// dropped — releasing its buffer and any receive reservation — as soon
    /// as its JavaScript copy exists, so at any moment at most one entry is
    /// held twice. The crossing also stops at [`GROUP_CROSSING_MAX_BYTES`]
    /// (`take_for_crossing`); what is left stays queued, under its
    /// reservations, for the next `next()`.
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        if let Ok(mut queue) = val.shared.queue.lock() {
            queue.woken = false;
        }
        let mut array = std::ptr::null_mut();
        napi::check_status!(unsafe { napi::sys::napi_create_array(env, &mut array) })?;
        let mut taken = CrossingTally::default();
        while let Some(entry) =
            val.shared
                .take_for_crossing(&mut taken, val.max_entries, GROUP_CROSSING_MAX_BYTES)
        {
            let key = unsafe { u32::to_napi_value(env, entry.key)? };
            // Each arm consumes the payload: it is dropped (and its
            // reservation released) when the conversion returns.
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
            let at = ((taken.entries - 1) * 2) as u32;
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

    /// Create stream `key`'s credit (`credit` bytes, positive) before its
    /// handle's `feedReadGroup(id, key, ..)` is called. Throws if the key is
    /// still live; a prepared key that is cancelled before its feeder starts
    /// is forgotten, and that feeder then ends without reading.
    #[napi]
    pub fn prepare(&self, key: u32, credit: u32) -> Result<()> {
        self.shared
            .prepare(key, i64::from(credit))
            .map_err(napi::Error::from_reason)
    }

    /// Keys prepared or feeding (diagnostics and tests).
    #[napi(getter)]
    pub fn live_keys(&self) -> u32 {
        self.shared.live_keys() as u32
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

    /// Stop stream `key`'s feeder at its next credit check. Entries the key
    /// already queued are purged now, and whatever a read still in flight
    /// returns (the owner's stop/reset/dispose usually aborts it) is dropped
    /// natively rather than queued — in both cases releasing the payload and
    /// any reservation it holds, so a cancelled key never leaves anything in
    /// the queue (`GroupShared::cancel`, `push_fed`).
    /// A prepared key whose feeder has not started is forgotten, and that
    /// feeder ends before it reads. A key that is no longer live is ignored:
    /// nothing is remembered, so no cancel is ever lost or left behind.
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

    /// Payload bytes queued and not yet drained (diagnostics and tests).
    #[napi(getter)]
    pub fn queued_bytes(&self) -> f64 {
        self.shared.queued_bytes() as f64
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

    fn prepared(key: u32, credit: i64) -> Arc<GroupShared> {
        let shared = Arc::new(GroupShared::new());
        shared.prepare(key, credit).unwrap();
        shared
    }

    #[tokio::test]
    async fn feeder_delivers_batches_then_eof_in_order() {
        let shared = prepared(3, 1 << 20);
        let mut script = vec![data(10), data(20), Ok(None)].into_iter();
        let out = run_feeder(shared.clone(), 3, || {
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
        assert_eq!(shared.live_keys(), 0);
        assert_eq!(shared.batched_entries.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn feeder_forwards_the_error_code_and_stops() {
        let shared = prepared(1, 1 << 20);
        let mut calls = 0;
        run_feeder(shared.clone(), 1, || {
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
    async fn one_byte_of_credit_admits_exactly_one_read() {
        // The JS pump grants one byte per outstanding pull: each grant must
        // buy one read and no read-ahead, whatever the chunk size.
        let shared = prepared(9, 1);
        let reads = Arc::new(AtomicU32::new(0));
        let r = reads.clone();
        let task = tokio::spawn(run_feeder(shared.clone(), 9, move || {
            r.fetch_add(1, Ordering::SeqCst);
            async { data(1400) }
        }));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // The pump tops the allowance back up to one byte: 1 - 1400 + 1400.
        let credit = shared.credit(9).unwrap();
        credit.available.fetch_add(1400, Ordering::AcqRel);
        credit.notify.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 2, "no read without demand");
        shared.cancel(9);
        assert!(task.await.unwrap().is_none());
        assert!(shared.credit(9).is_none());
    }

    #[tokio::test]
    async fn an_empty_read_does_not_spend_the_demand() {
        let shared = prepared(4, 1);
        let mut script = vec![data(0), data(5)].into_iter();
        let reads = Arc::new(AtomicU32::new(0));
        let r = reads.clone();
        let task = tokio::spawn(run_feeder(shared.clone(), 4, move || {
            r.fetch_add(1, Ordering::SeqCst);
            let next = script.next().unwrap_or_else(|| data(1));
            async move { next }
        }));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        shared.cancel(4);
        assert!(task.await.unwrap().is_none());
    }

    #[tokio::test]
    async fn closing_the_group_stops_feeders_and_drops_entries() {
        let shared = prepared(2, 10);
        let task = tokio::spawn(run_feeder(shared.clone(), 2, || async { data(10) }));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        shared.close();
        assert!(task.await.unwrap().is_none());
        shared.push(2, GroupPayload::End);
        assert!(drain(&shared).is_empty(), "a closed group queues nothing");
    }

    #[tokio::test]
    async fn a_key_cannot_be_prepared_or_fed_twice_and_credit_must_be_positive() {
        let shared = prepared(5, 10);
        assert!(shared.prepare(5, 10).unwrap_err().contains("already live"));
        let Registration::Fed(_held) = shared.claim(5) else {
            panic!("first claim must feed");
        };
        let dup = run_feeder(shared.clone(), 5, || async { data(1) }).await;
        assert!(dup.unwrap().contains("already fed"));
        assert!(shared.prepare(6, 0).unwrap_err().contains("positive"));
    }

    #[tokio::test]
    async fn a_cancel_before_the_feeder_starts_ends_it_unread() {
        let shared = prepared(4, 100);
        shared.cancel(4);
        assert_eq!(
            shared.live_keys(),
            0,
            "an unclaimed cancelled key is forgotten"
        );
        let mut reads = 0;
        let out = run_feeder(shared.clone(), 4, || {
            reads += 1;
            async { data(1) }
        })
        .await;
        assert!(out.is_none());
        assert_eq!(reads, 0, "a pre-cancelled feeder reads nothing");
        assert!(drain(&shared).is_empty());
    }

    #[tokio::test]
    async fn cancels_are_never_lost_however_many_feeders_are_pending() {
        // C-B3: thousands of start-then-cancel streams whose feeders have not
        // registered yet. Every one of them must end unread, and nothing may
        // be left behind once they have.
        let shared = Arc::new(GroupShared::new());
        let n = 5000u32;
        for key in 1..=n {
            shared.prepare(key, 1).unwrap();
            shared.cancel(key);
        }
        assert_eq!(shared.live_keys(), 0);
        let reads = Arc::new(AtomicU32::new(0));
        for key in 1..=n {
            let r = reads.clone();
            let out = run_feeder(shared.clone(), key, move || {
                r.fetch_add(1, Ordering::SeqCst);
                async { data(1) }
            })
            .await;
            assert!(out.is_none());
        }
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(shared.live_keys(), 0);
    }

    #[test]
    fn late_cancels_of_finished_feeders_leave_nothing_behind() {
        let shared = GroupShared::new();
        for key in 0..5000 {
            shared.cancel(key);
        }
        assert_eq!(shared.live_keys(), 0);
    }

    #[tokio::test]
    async fn a_cancel_after_the_feeder_ended_does_not_touch_a_reprepared_key() {
        let shared = prepared(8, 1);
        run_feeder(shared.clone(), 8, || async { Ok(None) }).await;
        shared.cancel(8);
        shared.prepare(8, 1).unwrap();
        let Registration::Fed(credit) = shared.claim(8) else {
            panic!("a re-prepared key must feed");
        };
        assert!(!credit.cancelled.load(Ordering::Acquire));
    }

    fn budget() -> crate::client_stream::StreamBudget {
        crate::client_stream::StreamBudget {
            server_metrics: Arc::new(crate::server_metrics::ServerMetrics::default()),
            session_metrics: Arc::new(crate::session_registry::SessionMetrics::default()),
            stream_queued: Arc::new(AtomicU64::new(0)),
            max_global: 1 << 20,
            max_session: 1 << 18,
            max_stream: 1 << 16,
            capacity_notify: crate::client_stream::StreamBudget::new_notify(),
            backpressure_timeout_ms: 1000,
        }
    }

    /// A batch (`CHUNK_BATCH` on) holding a real three-tier reservation.
    fn reserved_batch(b: &crate::client_stream::StreamBudget, len: usize) -> FeedChunk {
        assert!(b.try_reserve(len as u64));
        FeedChunk::Batch(CoalescedChunks::from_chunks_for_tests(vec![
            crate::client_stream::StreamChunk::new(vec![1u8; len], Some(b.clone()), len as u64),
        ]))
    }

    fn reserved(b: &crate::client_stream::StreamBudget) -> (u64, u64, u64) {
        (
            b.server_metrics.queued_bytes_global.load(Ordering::Relaxed),
            b.session_metrics.queued_bytes.load(Ordering::Relaxed),
            b.stream_queued.load(Ordering::Relaxed),
        )
    }

    #[tokio::test]
    async fn a_cancel_purges_queued_entries_and_returns_their_budget() {
        let b = budget();
        let shared = prepared(1, 1 << 20);
        shared.prepare(2, 1 << 20).unwrap();
        let Registration::Fed(c1) = shared.claim(1) else {
            panic!("claim 1")
        };
        let Registration::Fed(c2) = shared.claim(2) else {
            panic!("claim 2")
        };
        shared.push_fed(1, &c1, GroupPayload::Data(reserved_batch(&b, 300)));
        shared.push_fed(2, &c2, GroupPayload::Data(reserved_batch(&b, 50)));
        shared.push_fed(1, &c1, GroupPayload::Data(reserved_batch(&b, 200)));
        assert_eq!(reserved(&b), (550, 550, 550));
        shared.cancel(1);
        // Key 1's entries are gone and their reservations returned; key 2's
        // entry is untouched.
        assert_eq!(drain(&shared), vec![(2, "data", 50)]);
        assert_eq!(reserved(&b), (0, 0, 0));
    }

    #[tokio::test]
    async fn a_read_that_completes_after_the_cancel_is_dropped_with_its_budget() {
        // r2 A-B1: the pump may already have stopped (its last stream was
        // detached) when an in-flight read wins the race with the abort. The
        // entry must not land in a queue nothing drains.
        let b = budget();
        let shared = prepared(7, 1);
        let gate = Arc::new(Notify::new());
        let (g, bb) = (gate.clone(), b.clone());
        let task = tokio::spawn(run_feeder(shared.clone(), 7, move || {
            let (g, bb) = (g.clone(), bb.clone());
            async move {
                g.notified().await;
                Ok(Some(reserved_batch(&bb, 1400)))
            }
        }));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        shared.cancel(7);
        gate.notify_one();
        assert!(task.await.unwrap().is_none());
        assert_eq!(shared.queued(), 0);
        assert_eq!(shared.queued_bytes(), 0);
        assert_eq!(reserved(&b), (0, 0, 0));
        assert_eq!(shared.live_keys(), 0);
    }

    #[tokio::test]
    async fn a_crossing_respects_its_byte_cap_and_releases_each_entry_as_taken() {
        // r4 C-B1: a crossing must not hold every drained entry (and its
        // reservation) while it copies them into JavaScript.
        let b = budget();
        let shared = Arc::new(GroupShared::new());
        let mut credits = Vec::new();
        for key in 1..=6u32 {
            shared.prepare(key, 1 << 20).unwrap();
            let Registration::Fed(c) = shared.claim(key) else {
                panic!("claim")
            };
            shared.push_fed(key, &c, GroupPayload::Data(reserved_batch(&b, 400)));
            credits.push(c);
        }
        shared.push_fed(1, &credits[0], GroupPayload::End);
        assert_eq!(reserved(&b).0, 2400);
        // A 1,000-byte cap: two 400-byte entries fit, the third would not.
        let mut taken = CrossingTally::default();
        let mut keys = Vec::new();
        while let Some(entry) = shared.take_for_crossing(&mut taken, 4096, 1000) {
            keys.push(entry.key);
            // "Copy into JS", then drop: the reservation goes with it, while
            // everything not yet taken stays reserved.
            drop(entry);
            assert_eq!(reserved(&b).0 as usize, shared.queued_bytes());
        }
        assert_eq!(keys, vec![1, 2]);
        assert_eq!(taken.bytes, 800);
        assert_eq!(reserved(&b).0, 1600);
        // The next crossing continues where this one stopped.
        let mut next = CrossingTally::default();
        let mut more = Vec::new();
        while let Some(entry) = shared.take_for_crossing(&mut next, 4096, 1000) {
            more.push(entry.key);
        }
        assert_eq!(more, vec![3, 4]);
        // The entry cap still applies, and a first entry larger than the
        // byte cap is still taken alone (a crossing always makes progress).
        let mut one = CrossingTally::default();
        assert_eq!(shared.take_for_crossing(&mut one, 1, 1000).unwrap().key, 5);
        assert!(shared.take_for_crossing(&mut one, 1, 1000).is_none());
        let mut tiny = CrossingTally::default();
        assert_eq!(
            shared.take_for_crossing(&mut tiny, 4096, 10).unwrap().key,
            6
        );
        // A terminal entry costs no bytes.
        assert_eq!(
            shared.take_for_crossing(&mut tiny, 4096, 10).unwrap().key,
            1
        );
        assert!(shared.take_for_crossing(&mut tiny, 4096, 10).is_none());
        assert_eq!(reserved(&b), (0, 0, 0));
    }

    #[tokio::test]
    async fn data_and_batched_counts_are_kept_side_by_side() {
        let shared = prepared(8, 1 << 20);
        let mut script = vec![
            Ok(Some(FeedChunk::Single(PayloadBuffer::from(vec![1u8; 3])))),
            data(4),
            Ok(None),
        ]
        .into_iter();
        run_feeder(shared.clone(), 8, || {
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
