//! Scratch microbench addon for T34: the N-API crossing floor of a
//! **one-payload → N-sessions** fan-out, with nothing behind it. No transport,
//! no governor, no quinn.
//!
//! The shipped fan-out today is one crossing per target. This addon prices the
//! shapes that could replace it, and — separately — the shapes the *return*
//! value could take, because at N = 10,000 the envelope is its own crossing.
//!
//! Every function models the same per-target work the real path owes:
//!
//! * a registry lookup (`DashMap<String, Arc<Target>>`, as `session_registry`),
//! * a "send" that takes the payload and bumps the session's counters.
//!
//! What differs between shapes is *how the targets and the payload cross*, and
//! how many times the payload is copied:
//!
//! * `perTargetPromise`  — today's pipelined `sendDatagram` (promise/target)
//! * `perTargetTry`      — today's landed `trySendDatagram` (sync, no promise)
//! * `mirrorIds`         — one crossing, targets as `string[]`
//! * `mirrorKeys`        — one crossing, targets as a dense `Uint32Array`
//! * `mirrorGroup`       — one crossing, targets pre-registered natively
//! * `mirrorGroupFramed` — as `mirrorGroup`, but a real per-target copy, which
//!   is what `wtransport::Connection::send_datagram` costs (it re-frames per
//!   session id). Prices the shared-`Bytes` refinement against the safe form.
//! * `mirrorGroupAsync` — as `mirrorGroup` behind one promise, which is what a
//!   parking (governor-waiting) mirror would owe.
//!
//! Envelope shapes, at one N and a settable failure fraction:
//!
//! * `envCounter`   — `{sent, code}` (prefix; dishonest for a target set)
//! * `envFailList`  — `{sent, indices: Uint32Array, codes: Uint8Array}`
//! * `envBitset`    — `{sent, ok: Uint8Array}` (⌈N/8⌉ bytes, carries no code)
//! * `envPerTarget` — `(string | null)[]`, the naive N-sized return

use bytes::Bytes;
use dashmap::DashMap;
use napi::bindgen_prelude::{Buffer, Uint32Array, Uint8Array};
use napi::{Env, JsObject, Result};
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

struct Target {
    out: AtomicU64,
    closed: AtomicBool,
}

/// Same shape as the product registry: string-keyed, `Arc` values cloned out
/// under the shard lock so the send itself runs outside it.
static REGISTRY: Lazy<DashMap<String, Arc<Target>>> = Lazy::new(DashMap::new);
/// Dense u32 handles → the same targets. Models "the app holds an integer".
static KEYS: Lazy<DashMap<u32, Arc<Target>>> = Lazy::new(DashMap::new);
/// A pre-resolved target set: the group shape pays no per-call lookup at all.
static GROUPS: Lazy<DashMap<u32, Arc<Vec<Arc<Target>>>>> = Lazy::new(DashMap::new);

static NEXT_GROUP: AtomicU64 = AtomicU64::new(1);

/// The per-target delivery every shape shares: hand the payload to the session
/// and account for it. `Bytes::clone` is a refcount bump — no copy — which is
/// the whole point of carrying one payload across one crossing.
#[inline]
fn deliver(target: &Target, payload: &Bytes) -> bool {
    if target.closed.load(Ordering::Acquire) {
        return false;
    }
    let handed = std::hint::black_box(payload.clone());
    target.out.fetch_add(handed.len() as u64, Ordering::Relaxed);
    true
}

/// The same delivery, but re-framed per target — one allocation and one copy
/// each, which is what today's `conn.send_datagram(&payload)` costs because
/// every session frames the payload behind its own session-id varint.
#[inline]
fn deliver_framed(target: &Target, payload: &[u8]) -> bool {
    if target.closed.load(Ordering::Acquire) {
        return false;
    }
    let mut framed = Vec::with_capacity(payload.len() + 4);
    framed.extend_from_slice(&[0u8; 4]);
    framed.extend_from_slice(payload);
    let handed = std::hint::black_box(Bytes::from(framed));
    target.out.fetch_add(handed.len() as u64, Ordering::Relaxed);
    true
}

/// Reject-free envelope under evaluation: a partial fan-out is a value.
#[napi(object)]
pub struct MirrorResult {
    pub sent: u32,
    pub failed: u32,
    pub code: Option<String>,
}

#[napi(object)]
pub struct MirrorFailures {
    pub sent: u32,
    pub indices: Uint32Array,
    pub codes: Uint8Array,
}

#[napi(object)]
pub struct MirrorBitset {
    pub sent: u32,
    pub ok: Uint8Array,
}

/// Build a group of `n` targets; returns its group id. Ids are `s-<i>`, the
/// dense keys are `0..n`, and every target is also in `REGISTRY` and `KEYS`.
#[napi]
pub fn register_group(n: u32) -> u32 {
    let group = NEXT_GROUP.fetch_add(1, Ordering::Relaxed) as u32;
    let mut members = Vec::with_capacity(n as usize);
    for i in 0..n {
        let t = Arc::new(Target {
            out: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        });
        REGISTRY.insert(format!("g{group}-s{i}"), Arc::clone(&t));
        KEYS.insert(group * 1_000_000 + i, Arc::clone(&t));
        members.push(t);
    }
    GROUPS.insert(group, Arc::new(members));
    group
}

#[napi]
pub fn group_ids(group: u32, n: u32) -> Vec<String> {
    (0..n).map(|i| format!("g{group}-s{i}")).collect()
}

#[napi]
pub fn group_keys(group: u32, n: u32) -> Uint32Array {
    Uint32Array::new((0..n).map(|i| group * 1_000_000 + i).collect())
}

/// Mark every `fail_every`-th member closed, so the envelope shapes have real
/// failures to report. `fail_every == 0` closes none.
#[napi]
pub fn set_failures(group: u32, fail_every: u32) {
    let Some(members) = GROUPS.get(&group) else {
        return;
    };
    for (i, t) in members.iter().enumerate() {
        let closed = fail_every != 0 && (i as u32 + 1).is_multiple_of(fail_every);
        t.closed.store(closed, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Baselines: one crossing per target.
// ---------------------------------------------------------------------------

/// Today's `sendDatagram`: one promise per target, payload copied per target.
#[napi(ts_return_type = "Promise<number>")]
pub fn per_target_promise(env: Env, id: String, data: Buffer) -> Result<JsObject> {
    let payload = Bytes::from(data.as_ref().to_vec());
    env.spawn_future(async move {
        let ok = match REGISTRY.get(&id) {
            Some(t) => deliver(&t, &payload),
            None => false,
        };
        Ok(u32::from(ok))
    })
}

/// Today's landed `trySendDatagram`: synchronous, no promise, still one
/// crossing and one payload copy per target.
#[napi]
pub fn per_target_try(id: String, data: Buffer) -> Option<String> {
    let payload = Bytes::from(data.as_ref().to_vec());
    match REGISTRY.get(&id) {
        Some(t) if deliver(&t, &payload) => None,
        Some(_) => Some("E_SESSION_CLOSED".to_string()),
        None => Some("E_SESSION_CLOSED".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Mirror shapes: one crossing, one payload copy, N targets.
// ---------------------------------------------------------------------------

#[napi]
pub fn mirror_ids(ids: Vec<String>, data: Uint8Array) -> MirrorResult {
    let payload = Bytes::from(data.as_ref().to_vec());
    let (mut sent, mut failed) = (0u32, 0u32);
    for id in &ids {
        let ok = match REGISTRY.get(id) {
            Some(t) => deliver(&t, &payload),
            None => false,
        };
        if ok {
            sent += 1
        } else {
            failed += 1
        }
    }
    MirrorResult {
        sent,
        failed,
        code: None,
    }
}

#[napi]
pub fn mirror_keys(keys: Uint32Array, data: Uint8Array) -> MirrorResult {
    let payload = Bytes::from(data.as_ref().to_vec());
    let (mut sent, mut failed) = (0u32, 0u32);
    for key in keys.as_ref() {
        let ok = match KEYS.get(key) {
            Some(t) => deliver(&t, &payload),
            None => false,
        };
        if ok {
            sent += 1
        } else {
            failed += 1
        }
    }
    MirrorResult {
        sent,
        failed,
        code: None,
    }
}

#[napi]
pub fn mirror_group(group: u32, data: Uint8Array) -> MirrorResult {
    let payload = Bytes::from(data.as_ref().to_vec());
    let (mut sent, mut failed) = (0u32, 0u32);
    if let Some(members) = GROUPS.get(&group) {
        for t in members.iter() {
            if deliver(t, &payload) {
                sent += 1
            } else {
                failed += 1
            }
        }
    }
    MirrorResult {
        sent,
        failed,
        code: None,
    }
}

#[napi]
pub fn mirror_group_framed(group: u32, data: Uint8Array) -> MirrorResult {
    let payload = data.as_ref().to_vec();
    let (mut sent, mut failed) = (0u32, 0u32);
    if let Some(members) = GROUPS.get(&group) {
        for t in members.iter() {
            if deliver_framed(t, &payload) {
                sent += 1
            } else {
                failed += 1
            }
        }
    }
    MirrorResult {
        sent,
        failed,
        code: None,
    }
}

/// What a parking mirror would cost: the same fan-out behind one promise.
#[napi(ts_return_type = "Promise<MirrorResult>")]
pub fn mirror_group_async(env: Env, group: u32, data: Uint8Array) -> Result<JsObject> {
    let payload = Bytes::from(data.as_ref().to_vec());
    env.spawn_future(async move {
        let (mut sent, mut failed) = (0u32, 0u32);
        if let Some(members) = GROUPS.get(&group) {
            for t in members.iter() {
                if deliver(t, &payload) {
                    sent += 1
                } else {
                    failed += 1
                }
            }
        }
        Ok(MirrorResult {
            sent,
            failed,
            code: None,
        })
    })
}

// ---------------------------------------------------------------------------
// Envelope shapes: what the return value costs at N.
// ---------------------------------------------------------------------------

#[napi]
pub fn env_counter(group: u32, data: Uint8Array) -> MirrorResult {
    mirror_group(group, data)
}

#[napi]
pub fn env_fail_list(group: u32, data: Uint8Array) -> MirrorFailures {
    let payload = Bytes::from(data.as_ref().to_vec());
    let mut sent = 0u32;
    let mut indices: Vec<u32> = Vec::new();
    let mut codes: Vec<u8> = Vec::new();
    if let Some(members) = GROUPS.get(&group) {
        for (i, t) in members.iter().enumerate() {
            if deliver(t, &payload) {
                sent += 1;
            } else {
                indices.push(i as u32);
                codes.push(1); // E_SESSION_CLOSED
            }
        }
    }
    MirrorFailures {
        sent,
        indices: Uint32Array::new(indices),
        codes: Uint8Array::new(codes),
    }
}

#[napi]
pub fn env_bitset(group: u32, data: Uint8Array) -> MirrorBitset {
    let payload = Bytes::from(data.as_ref().to_vec());
    let mut sent = 0u32;
    let members = GROUPS.get(&group);
    let n = members.as_ref().map(|m| m.len()).unwrap_or(0);
    let mut ok = vec![0u8; n.div_ceil(8)];
    if let Some(members) = members {
        for (i, t) in members.iter().enumerate() {
            if deliver(t, &payload) {
                sent += 1;
                ok[i / 8] |= 1 << (i % 8);
            }
        }
    }
    MirrorBitset {
        sent,
        ok: Uint8Array::new(ok),
    }
}

#[napi]
pub fn env_per_target(group: u32, data: Uint8Array) -> Vec<Option<String>> {
    let payload = Bytes::from(data.as_ref().to_vec());
    let members = GROUPS.get(&group);
    let n = members.as_ref().map(|m| m.len()).unwrap_or(0);
    let mut out: Vec<Option<String>> = Vec::with_capacity(n);
    if let Some(members) = members {
        for t in members.iter() {
            out.push(if deliver(t, &payload) {
                None
            } else {
                Some("E_SESSION_CLOSED".to_string())
            });
        }
    }
    out
}
