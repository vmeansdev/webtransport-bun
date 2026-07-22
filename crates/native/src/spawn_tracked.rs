//! spawn_tracked: wrap tokio::spawn with task gauges (Phase 4.3.3).
//! Increments gauge on spawn, decrements on completion (success or panic).

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::atomic::Ordering;
use std::sync::Arc;
#[cfg(any(test, feature = "webtransport_test_seams"))]
use std::time::Duration;

use crate::panic_guard;
use crate::server_metrics::ServerMetrics;
use tokio::task::AbortHandle;

static TRACKED_TASK_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static OWNER_ABORTS: Lazy<DashMap<(u64, u64), AbortHandle>> = Lazy::new(DashMap::new);
#[cfg(any(test, feature = "webtransport_test_seams"))]
static TEST_STALL_STREAM_EXIT_ONCE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(any(test, feature = "webtransport_test_seams"))]
static TEST_STALL_SESSION_EXIT_ONCE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Copy)]
pub enum TaskKind {
    Session,
    Stream,
}

/// Spawn a future on the runtime with tracked gauges.
/// Decrements on completion (including panic path via spawn_quic_task_scoped).
/// `scope` bounds panic teardown to the owning session/server.
pub fn spawn_tracked<F>(
    metrics: Arc<ServerMetrics>,
    owner_server_id: u64,
    kind: TaskKind,
    scope: panic_guard::PanicScope,
    fut: F,
) where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    match kind {
        TaskKind::Session => {
            metrics.session_tasks_active.fetch_add(1, Ordering::Relaxed);
        }
        TaskKind::Stream => {
            metrics.stream_tasks_active.fetch_add(1, Ordering::Relaxed);
        }
    }
    let metrics_clone = Arc::clone(&metrics);
    let decrement = move || match kind {
        TaskKind::Session => {
            metrics_clone
                .session_tasks_active
                .fetch_sub(1, Ordering::Relaxed);
        }
        TaskKind::Stream => {
            metrics_clone
                .stream_tasks_active
                .fetch_sub(1, Ordering::Relaxed);
        }
    };
    let task_id = TRACKED_TASK_IDS.fetch_add(1, Ordering::Relaxed);
    let guard = DropGuard::new(decrement);
    let wrapped = async move {
        let _guard = guard;
        fut.await;
        maybe_stall_task_exit(kind).await;
    };
    let handle = tokio::task::spawn(wrapped);
    OWNER_ABORTS.insert((owner_server_id, task_id), handle.abort_handle());
    tokio::task::spawn(async move {
        let result = handle.await;
        OWNER_ABORTS.remove(&(owner_server_id, task_id));
        if let Err(e) = result {
            if e.is_panic() {
                if std::env::var("WEBTRANSPORT_VERBOSE_PANICS").ok().as_deref() == Some("1") {
                    eprintln!(
                        "webtransport-native: QUIC task panicked (contained): {:?}",
                        e
                    );
                } else {
                    eprintln!("webtransport-native: QUIC task panicked (contained)");
                }
                match scope {
                    panic_guard::PanicScope::Session(id) => {
                        crate::session_registry::close_session(&id, 0, b"panic teardown");
                    }
                    panic_guard::PanicScope::Server(owner) => {
                        crate::session_registry::close_all_for_owner(owner, 0, b"panic teardown");
                    }
                    panic_guard::PanicScope::Conn(conn) => {
                        conn.close(wtransport::VarInt::from_u32(0), b"panic teardown");
                    }
                    panic_guard::PanicScope::LogOnly => {}
                }
            }
        }
    });
}

pub fn abort_server_tasks(server_id: u64) -> usize {
    let keys_and_handles: Vec<((u64, u64), AbortHandle)> = OWNER_ABORTS
        .iter()
        .filter(|entry| entry.key().0 == server_id)
        .map(|entry| (*entry.key(), entry.value().clone()))
        .collect();
    for (key, handle) in &keys_and_handles {
        OWNER_ABORTS.remove(key);
        handle.abort();
    }
    keys_and_handles.len()
}

pub fn server_task_count(server_id: u64) -> usize {
    OWNER_ABORTS
        .iter()
        .filter(|entry| entry.key().0 == server_id)
        .count()
}

#[cfg(any(test, feature = "webtransport_test_seams"))]
async fn maybe_stall_task_exit(kind: TaskKind) {
    let (env_key, claimed) = match kind {
        TaskKind::Session => (
            "WEBTRANSPORT_TEST_STALL_TRACKED_SESSION_EXIT",
            &TEST_STALL_SESSION_EXIT_ONCE,
        ),
        TaskKind::Stream => (
            "WEBTRANSPORT_TEST_STALL_TRACKED_STREAM_EXIT",
            &TEST_STALL_STREAM_EXIT_ONCE,
        ),
    };
    if std::env::var(env_key).ok().as_deref() != Some("1") {
        return;
    }
    if claimed
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

#[cfg(not(any(test, feature = "webtransport_test_seams")))]
async fn maybe_stall_task_exit(_kind: TaskKind) {}

struct DropGuard<F: FnOnce()> {
    f: Option<F>,
}

impl<F: FnOnce()> DropGuard<F> {
    fn new(f: F) -> Self {
        Self { f: Some(f) }
    }
}

impl<F: FnOnce()> Drop for DropGuard<F> {
    fn drop(&mut self) {
        if let Some(f) = self.f.take() {
            f();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{abort_server_tasks, server_task_count, spawn_tracked, TaskKind};
    use crate::panic_guard::PanicScope;
    use crate::server_metrics::ServerMetrics;
    use std::future::pending;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;

    async fn wait_for(predicate: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            if predicate() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "condition timed out"
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn server_scoped_tasks_are_counted_under_owner_id() {
        let metrics = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&metrics),
            41,
            TaskKind::Session,
            PanicScope::Server(41),
            async move {
                pending::<()>().await;
            },
        );

        assert_eq!(server_task_count(41), 1);
        assert_eq!(metrics.session_tasks_active.load(Ordering::Relaxed), 1);

        assert_eq!(abort_server_tasks(41), 1);
        wait_for(|| {
            server_task_count(41) == 0 && metrics.session_tasks_active.load(Ordering::Relaxed) == 0
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn aborts_are_isolated_per_server_id() {
        let metrics_a = Arc::new(ServerMetrics::default());
        let metrics_b = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&metrics_a),
            7,
            TaskKind::Session,
            PanicScope::Server(7),
            async move {
                pending::<()>().await;
            },
        );
        spawn_tracked(
            Arc::clone(&metrics_b),
            8,
            TaskKind::Session,
            PanicScope::Server(8),
            async move {
                pending::<()>().await;
            },
        );

        assert_eq!(server_task_count(7), 1);
        assert_eq!(server_task_count(8), 1);
        assert_eq!(abort_server_tasks(7), 1);
        wait_for(|| {
            server_task_count(7) == 0
                && metrics_a.session_tasks_active.load(Ordering::Relaxed) == 0
                && server_task_count(8) == 1
                && metrics_b.session_tasks_active.load(Ordering::Relaxed) == 1
        })
        .await;

        assert_eq!(abort_server_tasks(8), 1);
        wait_for(|| {
            server_task_count(8) == 0 && metrics_b.session_tasks_active.load(Ordering::Relaxed) == 0
        })
        .await;
    }
}
