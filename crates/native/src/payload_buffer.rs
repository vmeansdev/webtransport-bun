//! Payload buffers whose native bytes are reported to the JavaScript GC.
//!
//! napi-rs converts its own `Buffer` with `napi_create_external_buffer` and
//! never calls `napi_adjust_external_memory` (its `Env::create_buffer_with_data`
//! does, and its docs say so). The engine therefore sees only the few-byte JS
//! wrapper and feels no pressure from the payload behind it. Under a datagram
//! flood the JS heap stays tiny, a full collection never runs, and the
//! unaccounted native bytes accumulate — measured at ~90MB/h on a 50
//! datagram/s soak, which is a slow OOM for any long-running server. Forcing
//! `Bun.gc(true)` on a timer reclaimed all of it, which is what proved the
//! bytes were collectable garbage the collector simply could not see.
//!
//! Accounting alone turned out not to be enough on Bun: its
//! `napi_adjust_external_memory` routes to JSC's *deprecated*
//! `deprecatedReportExtraMemory`, which records the bytes but never runs
//! `collectIfNecessaryOrDefer` — so the collector still never fires. What
//! does drive it is allocating the payload as a real `JSC::JSArrayBuffer`
//! (`napi_create_arraybuffer`), whose bytes go through the non-deprecated
//! `reportExtraMemoryAllocated`. `PayloadBuffer` therefore delivers small
//! payloads as Uint8Array-over-arraybuffer (the default), and keeps the
//! accounted external buffer for large ones where the copy would cost more
//! than the pressure is worth.

use std::ffi::c_void;
use std::ptr;
use std::sync::OnceLock;

use napi::bindgen_prelude::{ToNapiValue, TypeName};
use napi::ValueType;
use napi::{sys, Result};

/// How ordinary (engine-owned) payloads reach JavaScript.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadDeliveryMode {
    /// A `Uint8Array` over a true `napi_create_arraybuffer` allocation.
    ArrayBuffer,
    /// The escape hatch: `napi_create_buffer_copy`.
    BufferCopy,
}

impl PayloadDeliveryMode {
    /// The stable name the addon diagnostic reports to JavaScript.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArrayBuffer => "arraybuffer",
            Self::BufferCopy => "buffer-copy",
        }
    }
}

/// The one resolved delivery mode for this process.
///
/// Small payloads default to a `Uint8Array` over a true
/// `napi_create_arraybuffer` allocation. In Bun, that constructs a real
/// `JSC::JSArrayBuffer`, whose creation reports its bytes through JSC's
/// non-deprecated `reportExtraMemoryAllocated` — the only accounting path
/// that also runs `collectIfNecessaryOrDefer`. Measured under a 1000
/// datagram/s load: full collections recur organically every ~15-20s and RSS
/// stays flat, where `napi_create_buffer_copy` delivery never triggered one
/// and grew ~100MB/h. `WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy` is the
/// escape hatch back to the old path.
///
/// The environment is read exactly once. Both the conversion classifier and
/// the `nativePayloadDeliveryMode()` diagnostic read this same `OnceLock`, so
/// the reported mode is always the mode payloads actually took.
pub fn payload_delivery_mode() -> PayloadDeliveryMode {
    static MODE: OnceLock<PayloadDeliveryMode> = OnceLock::new();
    *MODE.get_or_init(
        || match std::env::var("WEBTRANSPORT_PAYLOAD_DELIVERY").as_deref() {
            Ok("buffer-copy") => PayloadDeliveryMode::BufferCopy,
            _ => PayloadDeliveryMode::ArrayBuffer,
        },
    )
}

/// Payloads at or below this size are copied into engine-owned memory instead
/// of being handed over as external buffers. Datagrams and stream chunks live
/// well under it, and the copy is what makes them collectable in practice.
/// Larger payloads keep the zero-copy path with external accounting, where the
/// copy would cost more than the pressure is worth.
pub const ENGINE_OWNED_MAX_BYTES: usize = 256 * 1024;

/// Which construction a payload of a given size takes. Pure: it decides, it
/// does not allocate, copy, or account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PayloadDeliveryPlan {
    /// Zero-length payload — Rust's dangling pointer is unusable externally
    /// and an empty engine buffer needs no accounting.
    Empty,
    /// Engine-owned arraybuffer copy, the accounted-by-the-engine default.
    EngineOwnedArrayBuffer,
    /// Engine-owned `napi_create_buffer_copy`, the escape hatch.
    EngineOwnedBufferCopy,
    /// Handover of our own allocation, accounted explicitly by us.
    ExternalAccounted,
}

#[cfg(test)]
impl PayloadDeliveryPlan {
    /// Whether this plan makes an explicit `napi_adjust_external_memory`
    /// charge. Only the external handover does; every engine-owned path
    /// leaves accounting entirely to the engine. `to_napi_value` expresses the
    /// same rule structurally — the guard exists only in the external arm — so
    /// this is the assertion seam, not a second source of truth.
    pub(crate) fn charges_external_memory(self) -> bool {
        matches!(self, Self::ExternalAccounted)
    }
}

pub(crate) fn plan_delivery(len: usize, mode: PayloadDeliveryMode) -> PayloadDeliveryPlan {
    if len == 0 {
        return PayloadDeliveryPlan::Empty;
    }
    if len > ENGINE_OWNED_MAX_BYTES {
        return PayloadDeliveryPlan::ExternalAccounted;
    }
    match mode {
        PayloadDeliveryMode::ArrayBuffer => PayloadDeliveryPlan::EngineOwnedArrayBuffer,
        PayloadDeliveryMode::BufferCopy => PayloadDeliveryPlan::EngineOwnedBufferCopy,
    }
}

/// A payload handed to JavaScript as a `Uint8Array`, sized so the engine can
/// actually feel it: arraybuffer-backed copy for ordinary payloads, accounted
/// external `Buffer` for large ones.
///
/// `Shared` carries a refcounted transport buffer straight to the engine-owned
/// copy, so a retained datagram or stream chunk pays exactly one copy — the
/// arraybuffer one — instead of a dequeue copy first.
pub struct PayloadBuffer(PayloadSource);

enum PayloadSource {
    Owned(Vec<u8>),
    Shared(bytes::Bytes),
}

impl From<Vec<u8>> for PayloadBuffer {
    fn from(bytes: Vec<u8>) -> Self {
        Self(PayloadSource::Owned(bytes))
    }
}

impl From<bytes::Bytes> for PayloadBuffer {
    fn from(bytes: bytes::Bytes) -> Self {
        Self(PayloadSource::Shared(bytes))
    }
}

impl AsRef<[u8]> for PayloadBuffer {
    fn as_ref(&self) -> &[u8] {
        match &self.0 {
            PayloadSource::Owned(v) => v,
            PayloadSource::Shared(b) => b,
        }
    }
}

impl PayloadBuffer {
    /// Take the bytes back for a payload that stays inside Rust (probe
    /// handlers echo without ever crossing into JS). Copies under `Shared`;
    /// in-Rust consumers should prefer `into_bytes`.
    pub fn into_vec(self) -> Vec<u8> {
        match self.0 {
            PayloadSource::Owned(v) => v,
            PayloadSource::Shared(b) => b.to_vec(),
        }
    }

    /// The bytes as a refcounted buffer, copy-free from either arm.
    pub fn into_bytes(self) -> bytes::Bytes {
        match self.0 {
            PayloadSource::Owned(v) => bytes::Bytes::from(v),
            PayloadSource::Shared(b) => b,
        }
    }
}

impl TypeName for PayloadBuffer {
    fn type_name() -> &'static str {
        // Small payloads arrive as plain Uint8Array views over an arraybuffer;
        // large ones as Buffer (a Uint8Array subclass). Declare the supertype.
        "Uint8Array"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

/// Report `delta` bytes to the engine. Accounting is advisory: a failure must
/// not fail the payload delivery, but the +/- pair still has to balance, so
/// both directions ignore errors identically.
unsafe fn adjust_external_memory(env: sys::napi_env, delta: i64) {
    let mut adjusted = 0i64;
    let _ = unsafe { sys::napi_adjust_external_memory(env, delta, &mut adjusted) };
}

/// Where an external-memory adjustment goes. Production reports to the engine;
/// tests record, so the guard's state machine is exercised as shipped rather
/// than re-described.
pub(crate) trait ExternalMemoryAdjuster {
    fn adjust(&self, delta: i64);
}

struct EnvAdjuster(sys::napi_env);

impl ExternalMemoryAdjuster for EnvAdjuster {
    fn adjust(&self, delta: i64) {
        unsafe { adjust_external_memory(self.0, delta) };
    }
}

/// Balances the one explicit charge the external handover makes.
///
/// Constructed armed and already charged. `disarm` is called only once the
/// finalizer owns the bytes and will issue the matching decrement itself;
/// every other exit — a construction failure, the copied-buffer fallback, an
/// early `?`, a panic unwind — drops the guard, which refunds. The charge and
/// the refund therefore cannot drift apart by construction.
pub(crate) struct ExternalAccountingGuard<'a, A: ExternalMemoryAdjuster> {
    adjuster: &'a A,
    bytes: i64,
    armed: bool,
}

impl<'a, A: ExternalMemoryAdjuster> ExternalAccountingGuard<'a, A> {
    pub(crate) fn charge(adjuster: &'a A, len: usize) -> Self {
        adjuster.adjust(len as i64);
        Self {
            adjuster,
            bytes: len as i64,
            armed: true,
        }
    }

    /// Hand the outstanding decrement to the finalizer.
    pub(crate) fn disarm(mut self) {
        self.armed = false;
    }
}

impl<A: ExternalMemoryAdjuster> Drop for ExternalAccountingGuard<'_, A> {
    fn drop(&mut self) {
        if self.armed {
            self.adjuster.adjust(-self.bytes);
        }
    }
}

/// Allocate an engine-owned arraybuffer of `len` bytes, let `fill` write the
/// payload into it once, and wrap it in a `Uint8Array`.
///
/// The fill callback is what lets a payload assembled from several transport
/// segments pay exactly one copy: the segments are written straight into the
/// engine's allocation instead of being concatenated into an intermediate
/// `Vec` first.
pub(crate) unsafe fn engine_owned_arraybuffer(
    env: sys::napi_env,
    len: usize,
    fill: impl FnOnce(&mut [u8]),
) -> Result<sys::napi_value> {
    let mut data = ptr::null_mut();
    let mut ab = ptr::null_mut();
    napi::check_status!(
        unsafe { sys::napi_create_arraybuffer(env, len, &mut data, &mut ab) },
        "Failed to create payload arraybuffer"
    )?;
    fill(unsafe { std::slice::from_raw_parts_mut(data.cast::<u8>(), len) });
    let mut ret = ptr::null_mut();
    napi::check_status!(
        unsafe {
            sys::napi_create_typedarray(env, sys::TypedarrayType::uint8_array, len, ab, 0, &mut ret)
        },
        "Failed to create payload typedarray"
    )?;
    Ok(ret)
}

/// The `buffer-copy` escape hatch for a segmented payload: an engine-allocated
/// `Buffer` the caller fills in place. `napi_create_buffer_copy` cannot express
/// this without an intermediate concatenation, and the two differ only in who
/// writes the bytes — the buffer is engine-owned and engine-accounted either
/// way.
pub(crate) unsafe fn engine_owned_buffer(
    env: sys::napi_env,
    len: usize,
    fill: impl FnOnce(&mut [u8]),
) -> Result<sys::napi_value> {
    let mut data = ptr::null_mut();
    let mut ret = ptr::null_mut();
    napi::check_status!(
        unsafe { sys::napi_create_buffer(env, len, &mut data, &mut ret) },
        "Failed to create payload buffer"
    )?;
    fill(unsafe { std::slice::from_raw_parts_mut(data.cast::<u8>(), len) });
    Ok(ret)
}

/// The empty payload: Rust hands out a dangling pointer for empty allocations,
/// which the external path rejects, and an empty engine buffer needs no
/// accounting.
pub(crate) unsafe fn empty_payload_value(env: sys::napi_env) -> Result<sys::napi_value> {
    let mut ret = ptr::null_mut();
    napi::check_status!(
        unsafe { sys::napi_create_buffer(env, 0, ptr::null_mut(), &mut ret) },
        "Failed to create empty payload buffer"
    )?;
    Ok(ret)
}

unsafe extern "C" fn finalize_payload(env: sys::napi_env, _data: *mut c_void, hint: *mut c_void) {
    if hint.is_null() {
        return;
    }
    let bytes = unsafe { Box::from_raw(hint.cast::<Vec<u8>>()) };
    unsafe { adjust_external_memory(env, -(bytes.len() as i64)) };
    drop(bytes);
}

/// Hand our own allocation to the engine, with the one explicit charge held by
/// an armed guard until the finalizer takes over the matching decrement.
pub(crate) unsafe fn external_payload_to_napi_value(
    env: sys::napi_env,
    bytes: Vec<u8>,
    len: usize,
) -> Result<sys::napi_value> {
    let adjuster = EnvAdjuster(env);
    let accounting = ExternalAccountingGuard::charge(&adjuster, len);

    let mut ret = ptr::null_mut();
    let mut boxed = Box::new(bytes);
    let data = boxed.as_mut_ptr();
    let hint = Box::into_raw(boxed);
    let status = unsafe {
        sys::napi_create_external_buffer(
            env,
            len,
            data.cast::<c_void>(),
            Some(finalize_payload),
            hint.cast::<c_void>(),
            &mut ret,
        )
    };

    if status == sys::Status::napi_no_external_buffers_allowed {
        // Engine copied-buffer fallback: it owns and accounts the copy, so
        // release ours and let the guard undo our adjustment.
        let bytes = unsafe { Box::from_raw(hint) };
        let copy_status = unsafe {
            sys::napi_create_buffer_copy(
                env,
                len,
                bytes.as_ptr().cast::<c_void>(),
                ptr::null_mut(),
                &mut ret,
            )
        };
        drop(bytes);
        napi::check_status!(copy_status, "Failed to copy payload buffer")?;
        return Ok(ret);
    }

    if status != sys::Status::napi_ok {
        drop(unsafe { Box::from_raw(hint) });
        napi::check_status!(status, "Failed to create payload buffer")?;
    }

    // The finalizer now owns the bytes and their decrement.
    accounting.disarm();
    Ok(ret)
}

impl ToNapiValue for PayloadBuffer {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let len = val.as_ref().len();
        match plan_delivery(len, payload_delivery_mode()) {
            PayloadDeliveryPlan::Empty => unsafe { empty_payload_value(env) },
            PayloadDeliveryPlan::EngineOwnedArrayBuffer => unsafe {
                engine_owned_arraybuffer(env, len, |dst| dst.copy_from_slice(val.as_ref()))
            },
            PayloadDeliveryPlan::EngineOwnedBufferCopy => {
                // Escape-hatch path: an engine-allocated copy whose bytes land
                // in JSC aux memory. Collectable, but its allocation never
                // drives the collector — long floods rely on a full GC
                // something else causes.
                let mut ret = ptr::null_mut();
                napi::check_status!(
                    unsafe {
                        sys::napi_create_buffer_copy(
                            env,
                            len,
                            val.as_ref().as_ptr().cast::<c_void>(),
                            ptr::null_mut(),
                            &mut ret,
                        )
                    },
                    "Failed to create payload buffer copy"
                )?;
                Ok(ret)
            }
            // The external handover's finalizer owns a `Vec`; a `Shared`
            // payload above the engine-owned bound falls back to one copy.
            // Unreachable in practice: datagrams sit under the MTU and the
            // in-scope stream chunks under 4 KiB, both far below the bound.
            PayloadDeliveryPlan::ExternalAccounted => unsafe {
                external_payload_to_napi_value(env, val.into_vec(), len)
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// The test end of the same `ExternalMemoryAdjuster` seam production uses,
    /// so the guard under test is the shipped guard.
    #[derive(Default)]
    struct RecordingAdjuster {
        deltas: RefCell<Vec<i64>>,
    }

    impl RecordingAdjuster {
        fn deltas(&self) -> Vec<i64> {
            self.deltas.borrow().clone()
        }
    }

    impl ExternalMemoryAdjuster for RecordingAdjuster {
        fn adjust(&self, delta: i64) {
            self.deltas.borrow_mut().push(delta);
        }
    }

    #[test]
    fn empty_payloads_plan_the_engine_owned_empty_buffer_in_either_mode() {
        for mode in [
            PayloadDeliveryMode::ArrayBuffer,
            PayloadDeliveryMode::BufferCopy,
        ] {
            assert_eq!(plan_delivery(0, mode), PayloadDeliveryPlan::Empty);
        }
    }

    #[test]
    fn ordinary_payloads_plan_engine_owned_delivery_for_the_resolved_mode() {
        assert_eq!(
            plan_delivery(1, PayloadDeliveryMode::ArrayBuffer),
            PayloadDeliveryPlan::EngineOwnedArrayBuffer
        );
        assert_eq!(
            plan_delivery(1, PayloadDeliveryMode::BufferCopy),
            PayloadDeliveryPlan::EngineOwnedBufferCopy
        );
        // The engine-owned band is inclusive of its bound.
        assert_eq!(
            plan_delivery(ENGINE_OWNED_MAX_BYTES, PayloadDeliveryMode::ArrayBuffer),
            PayloadDeliveryPlan::EngineOwnedArrayBuffer
        );
        assert_eq!(
            plan_delivery(ENGINE_OWNED_MAX_BYTES, PayloadDeliveryMode::BufferCopy),
            PayloadDeliveryPlan::EngineOwnedBufferCopy
        );
    }

    #[test]
    fn payloads_past_the_engine_owned_bound_plan_the_accounted_handover() {
        for mode in [
            PayloadDeliveryMode::ArrayBuffer,
            PayloadDeliveryMode::BufferCopy,
        ] {
            assert_eq!(
                plan_delivery(ENGINE_OWNED_MAX_BYTES + 1, mode),
                PayloadDeliveryPlan::ExternalAccounted
            );
        }
    }

    /// Every engine-owned outcome leaves accounting to the engine: an explicit
    /// adjustment there would double-count against the engine's own report.
    #[test]
    fn only_the_external_plan_charges_external_memory() {
        assert!(!PayloadDeliveryPlan::Empty.charges_external_memory());
        assert!(!PayloadDeliveryPlan::EngineOwnedArrayBuffer.charges_external_memory());
        assert!(!PayloadDeliveryPlan::EngineOwnedBufferCopy.charges_external_memory());
        assert!(PayloadDeliveryPlan::ExternalAccounted.charges_external_memory());
    }

    /// Classifier-level only: no size in the engine-owned band, in either
    /// mode, is routed to the accounted plan. That the engine-owned arms then
    /// make no adjustment is structural rather than asserted here — the guard
    /// is constructed in exactly one place, `external_payload_to_napi_value`,
    /// which only the `ExternalAccounted` arm calls, and running
    /// `to_napi_value` itself needs a real `napi_env`. The guard's own
    /// behaviour is covered by the three tests below.
    #[test]
    fn no_engine_owned_size_is_classified_as_externally_accounted() {
        for mode in [
            PayloadDeliveryMode::ArrayBuffer,
            PayloadDeliveryMode::BufferCopy,
        ] {
            for len in [0usize, 1, 1150, ENGINE_OWNED_MAX_BYTES] {
                let plan = plan_delivery(len, mode);
                assert!(!plan.charges_external_memory(), "{plan:?} for {len} bytes");
            }
        }
    }

    /// Successful handover: exactly one charge stays outstanding, because the
    /// finalizer — not the guard — owns its decrement.
    #[test]
    fn a_successful_external_handover_leaves_exactly_one_outstanding_charge() {
        let adjuster = RecordingAdjuster::default();
        let len = ENGINE_OWNED_MAX_BYTES + 4096;
        let guard = ExternalAccountingGuard::charge(&adjuster, len);
        guard.disarm();
        assert_eq!(adjuster.deltas(), vec![len as i64]);
    }

    /// Failed handover: the same single charge, balanced by the guard's own
    /// refund, so a construction failure strands nothing.
    #[test]
    fn a_failed_external_handover_balances_its_single_charge() {
        let adjuster = RecordingAdjuster::default();
        let len = ENGINE_OWNED_MAX_BYTES + 4096;
        {
            let _guard = ExternalAccountingGuard::charge(&adjuster, len);
            // Construction fails, or an early `?` unwinds the scope.
        }
        let deltas = adjuster.deltas();
        assert_eq!(deltas, vec![len as i64, -(len as i64)]);
        assert_eq!(deltas.iter().sum::<i64>(), 0);
    }

    /// The guard cannot be disarmed twice or refunded after disarming: `disarm`
    /// consumes it, which is what makes "charge once" a type-level property.
    #[test]
    fn a_disarmed_guard_issues_no_further_adjustment() {
        let adjuster = RecordingAdjuster::default();
        ExternalAccountingGuard::charge(&adjuster, 4096).disarm();
        assert_eq!(adjuster.deltas().len(), 1);
    }

    /// The exported diagnostic and the conversion classifier must not be able
    /// to disagree: both read the one resolved mode.
    #[test]
    fn the_exported_mode_is_the_mode_the_classifier_uses() {
        let mode = payload_delivery_mode();
        assert_eq!(payload_delivery_mode(), mode, "the decision is a OnceLock");
        assert_eq!(crate::native_payload_delivery_mode(), mode.as_str());
        assert!(matches!(mode.as_str(), "arraybuffer" | "buffer-copy"));

        let expected = match mode {
            PayloadDeliveryMode::ArrayBuffer => PayloadDeliveryPlan::EngineOwnedArrayBuffer,
            PayloadDeliveryMode::BufferCopy => PayloadDeliveryPlan::EngineOwnedBufferCopy,
        };
        assert_eq!(plan_delivery(1150, payload_delivery_mode()), expected);
    }

    #[test]
    fn the_exported_engine_owned_bound_is_the_bound_the_classifier_uses() {
        let bound = crate::native_payload_engine_owned_max_bytes() as usize;
        assert_eq!(bound, ENGINE_OWNED_MAX_BYTES);
        assert!(!plan_delivery(bound, payload_delivery_mode()).charges_external_memory());
        assert!(plan_delivery(bound + 1, payload_delivery_mode()).charges_external_memory());
    }
}

#[cfg(test)]
mod alloc_falsifier {
    use super::*;
    use crate::alloc_counter::measure;

    /// The refactor's claim, asserted: moving a payload from either arm into
    /// (and back out of) `PayloadBuffer` performs zero heap allocations. The
    /// only copy a payload pays is the napi arraybuffer at the JS boundary.
    #[test]
    fn payload_buffer_conversions_do_not_allocate() {
        let owned_src = vec![7u8; 1150];
        let shared_src = bytes::Bytes::from(vec![9u8; 1150]);

        let ((), owned_allocs) = measure(|| {
            let pb = PayloadBuffer::from(owned_src);
            assert_eq!(pb.as_ref().len(), 1150);
            let b = pb.into_bytes();
            assert_eq!(b.len(), 1150);
            drop(b);
        });
        assert_eq!(owned_allocs, 0, "Owned round-trip must be moves only");

        // First share of a Vec-backed `Bytes` promotes it to its Arc-shared
        // form — one control-block allocation, surfaced by this very harness.
        // Promote outside the measured window; steady state is what the hot
        // path sees, and it must be allocation-free.
        let shared_src = shared_src.slice(..);
        let ((), shared_allocs) = measure(|| {
            let pb = PayloadBuffer::from(shared_src.slice(..));
            assert_eq!(pb.as_ref().len(), 1150);
            let b = pb.into_bytes();
            assert_eq!(b.len(), 1150);
            drop(b);
        });
        assert_eq!(
            shared_allocs, 0,
            "Shared round-trip must be refcount bumps only"
        );
    }

    /// `DatagramSlot::take`'s Transport arm returns `Datagram::payload()`,
    /// which is `Bytes::slice` of the retained buffer. `Datagram` itself is
    /// not constructible outside wtransport, so the arm's allocation-freedom
    /// is asserted via the identical operation: slicing a `Bytes` allocates
    /// nothing. (Before the refactor this arm paid a full `to_vec` per
    /// dequeued datagram.)
    #[test]
    fn bytes_slicing_the_transport_arm_operation_does_not_allocate() {
        let backing = bytes::Bytes::from(vec![3u8; 1500]);
        let ((), first) = measure(|| {
            drop(backing.slice(350..));
        });
        // One-time promotion of the Vec-backed buffer to Arc-shared form;
        // amortized once per received parent datagram, not per payload.
        assert!(first <= 1, "first slice may only pay the Arc promotion");
        let ((), steady) = measure(|| {
            let payload = backing.slice(350..);
            assert_eq!(payload.len(), 1150);
            drop(payload);
        });
        assert_eq!(
            steady, 0,
            "steady-state Bytes::slice must be a refcount bump"
        );
    }
}
