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

/// Small payloads are delivered as a `Uint8Array` over a true
/// `napi_create_arraybuffer` allocation. In Bun, that constructs a real
/// `JSC::JSArrayBuffer`, whose creation reports its bytes through JSC's
/// non-deprecated `reportExtraMemoryAllocated` — the only accounting path
/// that also runs `collectIfNecessaryOrDefer`. Measured under a 1000
/// datagram/s load: full collections recur organically every ~15-20s and RSS
/// stays flat, where `napi_create_buffer_copy` delivery never triggered one
/// and grew ~100MB/h. `WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy` is the
/// escape hatch back to the old path.
fn arraybuffer_delivery() -> bool {
    static MODE: OnceLock<bool> = OnceLock::new();
    *MODE.get_or_init(|| {
        std::env::var("WEBTRANSPORT_PAYLOAD_DELIVERY")
            .map(|v| v != "buffer-copy")
            .unwrap_or(true)
    })
}

/// Payloads at or below this size are copied into engine-owned memory instead
/// of being handed over as external buffers. Datagrams and stream chunks live
/// well under it, and the copy is what makes them collectable in practice.
/// Larger payloads keep the zero-copy path with external accounting, where the
/// copy would cost more than the pressure is worth.
const ENGINE_OWNED_MAX_BYTES: usize = 256 * 1024;

/// A payload handed to JavaScript as a `Uint8Array`, sized so the engine can
/// actually feel it: arraybuffer-backed copy for ordinary payloads, accounted
/// external `Buffer` for large ones.
pub struct PayloadBuffer(Vec<u8>);

impl From<Vec<u8>> for PayloadBuffer {
    fn from(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

impl AsRef<[u8]> for PayloadBuffer {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl PayloadBuffer {
    /// Take the bytes back for a payload that stays inside Rust (probe
    /// handlers echo without ever crossing into JS).
    pub fn into_vec(self) -> Vec<u8> {
        self.0
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

unsafe extern "C" fn finalize_payload(env: sys::napi_env, _data: *mut c_void, hint: *mut c_void) {
    if hint.is_null() {
        return;
    }
    let bytes = unsafe { Box::from_raw(hint.cast::<Vec<u8>>()) };
    unsafe { adjust_external_memory(env, -(bytes.len() as i64)) };
    drop(bytes);
}

impl ToNapiValue for PayloadBuffer {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let len = val.0.len();
        let mut ret = ptr::null_mut();
        if len == 0 {
            // Rust hands out a dangling pointer for empty vectors, which the
            // external path rejects; an engine-owned empty buffer needs no
            // accounting either.
            napi::check_status!(
                unsafe { sys::napi_create_buffer(env, 0, ptr::null_mut(), &mut ret) },
                "Failed to create empty payload buffer"
            )?;
            return Ok(ret);
        }

        if len <= ENGINE_OWNED_MAX_BYTES {
            if arraybuffer_delivery() {
                let mut data = ptr::null_mut();
                let mut ab = ptr::null_mut();
                napi::check_status!(
                    unsafe { sys::napi_create_arraybuffer(env, len, &mut data, &mut ab) },
                    "Failed to create payload arraybuffer"
                )?;
                unsafe {
                    ptr::copy_nonoverlapping(val.0.as_ptr(), data.cast::<u8>(), len);
                }
                napi::check_status!(
                    unsafe {
                        sys::napi_create_typedarray(
                            env,
                            sys::TypedarrayType::uint8_array,
                            len,
                            ab,
                            0,
                            &mut ret,
                        )
                    },
                    "Failed to create payload typedarray"
                )?;
                return Ok(ret);
            }
            // Escape-hatch path: an engine-allocated copy whose bytes land in
            // JSC aux memory. Collectable, but its allocation never drives the
            // collector — long floods rely on a full GC something else causes.
            napi::check_status!(
                unsafe {
                    sys::napi_create_buffer_copy(
                        env,
                        len,
                        val.0.as_ptr().cast::<c_void>(),
                        ptr::null_mut(),
                        &mut ret,
                    )
                },
                "Failed to create payload buffer copy"
            )?;
            return Ok(ret);
        }

        // Account before handing ownership away so every exit path below has a
        // matching decrement (the finalizer's, or the explicit ones here).
        unsafe { adjust_external_memory(env, len as i64) };

        let mut boxed = Box::new(val.0);
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
            // release ours and undo our adjustment.
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
            unsafe { adjust_external_memory(env, -(len as i64)) };
            drop(bytes);
            napi::check_status!(copy_status, "Failed to copy payload buffer")?;
            return Ok(ret);
        }

        if status != sys::Status::napi_ok {
            let bytes = unsafe { Box::from_raw(hint) };
            unsafe { adjust_external_memory(env, -(len as i64)) };
            drop(bytes);
            napi::check_status!(status, "Failed to create payload buffer")?;
        }

        Ok(ret)
    }
}
