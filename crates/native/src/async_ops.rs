//! Accounting for in-flight N-API async operations owned by a server instance.
//!
//! Every `Env::spawn_future` call hands JavaScript a promise backed by an
//! N-API deferred, and the host keeps its event loop referenced until that
//! promise settles. Tokio tasks are tracked by `spawn_tracked` and aborted on
//! close; these futures are not tasks and cannot be aborted, so a single one
//! that never settles pins the process for as long as it lives — the shape
//! observed on latency run 32159708926, where the driver sat 55 minutes with
//! zero sockets open after `server.close()` had already resolved.
//!
//! The counters here make that state observable and give `close()` something
//! to wait on: a close that ends with outstanding operations reports which
//! kinds were still in flight instead of leaving a silent pin behind.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Coarse grouping of async operations. Coarse on purpose: the point is to
/// name the stuck lane on the next occurrence, not to build a profiler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AsyncOpKind {
    /// Datagram receive/send/discard.
    Datagram,
    /// Stream open, accept, and stream discard drains.
    Stream,
    /// Session lifecycle waits (drain notification, close).
    Lifecycle,
}

const KIND_COUNT: usize = 3;
const KIND_NAMES: [&str; KIND_COUNT] = ["datagram", "stream", "lifecycle"];

impl AsyncOpKind {
    const fn index(self) -> usize {
        match self {
            AsyncOpKind::Datagram => 0,
            AsyncOpKind::Stream => 1,
            AsyncOpKind::Lifecycle => 2,
        }
    }
}

/// Per-owner counters. Sessions hold an `Arc` of their owner's block, so the
/// hot path is two relaxed atomics with no map lookup.
#[derive(Default)]
pub struct OwnerAsyncOps {
    counts: [AtomicU64; KIND_COUNT],
}

impl OwnerAsyncOps {
    pub fn pending_total(&self) -> u64 {
        self.counts
            .iter()
            .map(|c| c.load(Ordering::Acquire))
            .sum::<u64>()
    }

    /// `kind=n` pairs for the kinds that still have work in flight.
    pub fn breakdown(&self) -> String {
        let mut out = String::new();
        for (index, name) in KIND_NAMES.iter().enumerate() {
            let value = self.counts[index].load(Ordering::Acquire);
            if value == 0 {
                continue;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            let _ = write!(out, "{}={}", name, value);
        }
        if out.is_empty() {
            out.push_str("none");
        }
        out
    }
}

/// Owner id used by handles whose session is already gone by the time the
/// handle is constructed. Their work still counts, just not against a server.
const ORPHAN_OWNER: u64 = 0;

static OWNERS: Lazy<DashMap<u64, Arc<OwnerAsyncOps>>> = Lazy::new(DashMap::new);

/// The counter block for one server, created on first use.
pub fn owner_ops(owner_server_id: u64) -> Arc<OwnerAsyncOps> {
    Arc::clone(
        OWNERS
            .entry(owner_server_id)
            .or_insert_with(|| Arc::new(OwnerAsyncOps::default()))
            .value(),
    )
}

pub fn orphan_ops() -> Arc<OwnerAsyncOps> {
    owner_ops(ORPHAN_OWNER)
}

pub fn owner_pending(owner_server_id: u64) -> u64 {
    OWNERS
        .get(&owner_server_id)
        .map(|ops| ops.pending_total())
        .unwrap_or(0)
}

pub fn owner_breakdown(owner_server_id: u64) -> String {
    OWNERS
        .get(&owner_server_id)
        .map(|ops| ops.breakdown())
        .unwrap_or_else(|| "none".to_string())
}

/// Drop an owner's block once nothing is in flight for it. A block still
/// holding work is left alone: the guards outlive `close()` by definition.
pub fn forget_owner(owner_server_id: u64) {
    if owner_server_id == ORPHAN_OWNER {
        return;
    }
    OWNERS.remove_if(&owner_server_id, |_, ops| ops.pending_total() == 0);
}

/// Counts one async operation for as long as it is alive. Held inside the
/// spawned future, so it is released when the future settles *or* is dropped.
pub struct AsyncOpGuard {
    ops: Arc<OwnerAsyncOps>,
    index: usize,
}

impl AsyncOpGuard {
    pub fn new(ops: &Arc<OwnerAsyncOps>, kind: AsyncOpKind) -> Self {
        let index = kind.index();
        ops.counts[index].fetch_add(1, Ordering::AcqRel);
        Self {
            ops: Arc::clone(ops),
            index,
        }
    }
}

impl Drop for AsyncOpGuard {
    fn drop(&mut self) {
        self.ops.counts[self.index]
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                Some(current.saturating_sub(1))
            })
            .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_counts_while_alive_and_releases_on_drop() {
        let owner = u64::MAX - 101;
        let ops = owner_ops(owner);
        assert_eq!(owner_pending(owner), 0);
        let guard = AsyncOpGuard::new(&ops, AsyncOpKind::Datagram);
        assert_eq!(owner_pending(owner), 1);
        assert_eq!(owner_breakdown(owner), "datagram=1");
        let other = AsyncOpGuard::new(&ops, AsyncOpKind::Stream);
        assert_eq!(owner_pending(owner), 2);
        assert_eq!(owner_breakdown(owner), "datagram=1 stream=1");
        drop(guard);
        drop(other);
        assert_eq!(owner_pending(owner), 0);
        assert_eq!(owner_breakdown(owner), "none");
        forget_owner(owner);
        assert_eq!(owner_pending(owner), 0);
    }

    #[test]
    fn forget_owner_keeps_blocks_that_still_have_work() {
        let owner = u64::MAX - 102;
        let ops = owner_ops(owner);
        let guard = AsyncOpGuard::new(&ops, AsyncOpKind::Lifecycle);
        forget_owner(owner);
        assert_eq!(owner_pending(owner), 1);
        drop(guard);
        forget_owner(owner);
    }
}
