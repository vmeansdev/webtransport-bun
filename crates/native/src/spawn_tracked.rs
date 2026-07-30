//! spawn_tracked: wrap tokio::spawn with task gauges (Phase 4.3.3).
//! Increments gauge on spawn, decrements on completion (success or panic).

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::panic_guard;
use crate::server_metrics::ServerMetrics;
use tokio::task::{AbortHandle, JoinHandle};

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
    spawn_tracked_watcher(handle, owner_server_id, task_id, scope);
}

fn spawn_tracked_watcher(
    handle: JoinHandle<()>,
    owner_server_id: u64,
    task_id: u64,
    scope: panic_guard::PanicScope,
) {
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
    // Park forever until abort; avoid long timers so current-thread tests stay deterministic.
    std::future::pending::<()>().await;
}

#[cfg(not(any(test, feature = "webtransport_test_seams")))]
async fn maybe_stall_task_exit(_kind: TaskKind) {}

struct DropGuard {
    f: Option<Box<dyn FnOnce() + Send>>,
}

impl DropGuard {
    fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self {
            f: Some(Box::new(f)),
        }
    }
}

impl Drop for DropGuard {
    fn drop(&mut self) {
        if let Some(f) = self.f.take() {
            f();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        abort_server_tasks, server_task_count, spawn_tracked, DropGuard, TaskKind,
        TEST_STALL_SESSION_EXIT_ONCE, TEST_STALL_STREAM_EXIT_ONCE,
    };
    use crate::panic_guard::PanicScope;
    use crate::server_metrics::ServerMetrics;
    use std::future::pending;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Env-var stall/verbose seams are process-global; serialize those tests.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

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

    fn reset_stall_flags() {
        TEST_STALL_SESSION_EXIT_ONCE.store(false, Ordering::SeqCst);
        TEST_STALL_STREAM_EXIT_ONCE.store(false, Ordering::SeqCst);
    }

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().expect("env lock")
    }

    fn clear_stall_env() {
        std::env::remove_var("WEBTRANSPORT_TEST_STALL_TRACKED_SESSION_EXIT");
        std::env::remove_var("WEBTRANSPORT_TEST_STALL_TRACKED_STREAM_EXIT");
        reset_stall_flags();
    }

    fn tracked_idle(metrics: &ServerMetrics, owners: &[u64]) -> bool {
        let outstanding = owners
            .iter()
            .map(|owner| server_task_count(*owner))
            .sum::<usize>()
            + metrics.session_tasks_active.load(Ordering::Relaxed) as usize
            + metrics.stream_tasks_active.load(Ordering::Relaxed) as usize;
        outstanding == 0
    }

    async fn noop_task() {}
    async fn hang_task() {
        pending::<()>().await;
    }
    async fn panic_task() {
        panic!("tracked boom");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn server_scoped_tasks_are_counted_under_owner_id() {
        let _guard = lock_env();
        clear_stall_env();
        let metrics = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&metrics),
            41,
            TaskKind::Session,
            PanicScope::Server(41),
            hang_task(),
        );

        assert_eq!(server_task_count(41), 1);
        assert_eq!(metrics.session_tasks_active.load(Ordering::Relaxed), 1);

        assert_eq!(abort_server_tasks(41), 1);
        wait_for(|| tracked_idle(&metrics, &[41])).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn aborts_are_isolated_per_server_id() {
        let _guard = lock_env();
        clear_stall_env();
        let metrics_a = Arc::new(ServerMetrics::default());
        let metrics_b = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&metrics_a),
            7,
            TaskKind::Session,
            PanicScope::Server(7),
            hang_task(),
        );
        spawn_tracked(
            Arc::clone(&metrics_b),
            8,
            TaskKind::Session,
            PanicScope::Server(8),
            hang_task(),
        );

        assert_eq!(server_task_count(7), 1);
        assert_eq!(server_task_count(8), 1);
        assert_eq!(abort_server_tasks(7), 1);
        wait_for(|| tracked_idle(&metrics_a, &[7]) as u8 + (server_task_count(8) == 1) as u8 == 2)
            .await;
        assert_eq!(metrics_b.session_tasks_active.load(Ordering::Relaxed), 1);

        assert_eq!(abort_server_tasks(8), 1);
        wait_for(|| tracked_idle(&metrics_b, &[8])).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stream_and_session_tasks_complete_and_decrement_gauges() {
        let _guard = lock_env();
        clear_stall_env();
        let metrics = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&metrics),
            91,
            TaskKind::Stream,
            PanicScope::LogOnly,
            noop_task(),
        );
        spawn_tracked(
            Arc::clone(&metrics),
            92,
            TaskKind::Session,
            PanicScope::LogOnly,
            noop_task(),
        );

        wait_for(|| tracked_idle(&metrics, &[91, 92])).await;
        assert_eq!(abort_server_tasks(91), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn panic_scopes_are_contained() {
        let _guard = lock_env();
        clear_stall_env();
        std::env::remove_var("WEBTRANSPORT_VERBOSE_PANICS");
        let metrics = Arc::new(ServerMetrics::default());

        spawn_tracked(
            Arc::clone(&metrics),
            93,
            TaskKind::Stream,
            PanicScope::LogOnly,
            panic_task(),
        );
        spawn_tracked(
            Arc::clone(&metrics),
            94,
            TaskKind::Session,
            PanicScope::Session("missing-session".to_string()),
            panic_task(),
        );
        spawn_tracked(
            Arc::clone(&metrics),
            95,
            TaskKind::Stream,
            PanicScope::Server(95),
            panic_task(),
        );

        wait_for(|| tracked_idle(&metrics, &[93, 94, 95])).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn panic_verbose_env_path_is_contained() {
        let _guard = lock_env();
        clear_stall_env();
        let metrics = Arc::new(ServerMetrics::default());
        std::env::set_var("WEBTRANSPORT_VERBOSE_PANICS", "1");
        spawn_tracked(
            Arc::clone(&metrics),
            96,
            TaskKind::Session,
            PanicScope::LogOnly,
            panic_task(),
        );

        wait_for(|| tracked_idle(&metrics, &[96])).await;
        std::env::remove_var("WEBTRANSPORT_VERBOSE_PANICS");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stall_exit_second_claim_returns_immediately() {
        let _guard = lock_env();
        reset_stall_flags();
        let metrics = Arc::new(ServerMetrics::default());
        std::env::remove_var("WEBTRANSPORT_TEST_STALL_TRACKED_SESSION_EXIT");
        std::env::set_var("WEBTRANSPORT_TEST_STALL_TRACKED_STREAM_EXIT", "1");

        spawn_tracked(
            Arc::clone(&metrics),
            97,
            TaskKind::Stream,
            PanicScope::LogOnly,
            noop_task(),
        );
        wait_for(|| {
            TEST_STALL_STREAM_EXIT_ONCE.load(Ordering::SeqCst) && server_task_count(97) == 1
        })
        .await;

        spawn_tracked(
            Arc::clone(&metrics),
            1097,
            TaskKind::Stream,
            PanicScope::LogOnly,
            noop_task(),
        );
        wait_for(|| server_task_count(1097) == 0).await;
        assert_eq!(metrics.stream_tasks_active.load(Ordering::Relaxed), 1);

        assert_eq!(abort_server_tasks(97), 1);
        wait_for(|| tracked_idle(&metrics, &[97])).await;

        std::env::remove_var("WEBTRANSPORT_TEST_STALL_TRACKED_STREAM_EXIT");
        reset_stall_flags();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stall_session_exit_enters_sleep_then_abort() {
        let _guard = lock_env();
        reset_stall_flags();
        std::env::remove_var("WEBTRANSPORT_TEST_STALL_TRACKED_STREAM_EXIT");
        let metrics = Arc::new(ServerMetrics::default());
        std::env::set_var("WEBTRANSPORT_TEST_STALL_TRACKED_SESSION_EXIT", "1");

        spawn_tracked(
            Arc::clone(&metrics),
            98,
            TaskKind::Session,
            PanicScope::LogOnly,
            noop_task(),
        );
        wait_for(|| {
            TEST_STALL_SESSION_EXIT_ONCE.load(Ordering::SeqCst) && server_task_count(98) == 1
        })
        .await;

        assert_eq!(abort_server_tasks(98), 1);
        wait_for(|| tracked_idle(&metrics, &[98])).await;

        std::env::remove_var("WEBTRANSPORT_TEST_STALL_TRACKED_SESSION_EXIT");
        reset_stall_flags();
    }

    #[test]
    fn abort_unknown_server_returns_zero() {
        assert_eq!(abort_server_tasks(u64::MAX - 11), 0);
        assert_eq!(server_task_count(u64::MAX - 11), 0);
    }

    #[test]
    fn drop_guard_none_is_noop() {
        let guard = DropGuard { f: None };
        drop(guard);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn panic_conn_scope_closes_connection() {
        let _guard = lock_env();
        clear_stall_env();
        use crate::client::insecure_loopback_client_config;
        use crate::limits::Limits;
        use crate::rate_limit::RateLimits;
        use crate::server_spawn::{spawn_server_instance, ShutdownOnDrop};
        use crate::server_tls::build_default_dev_resolver;
        use crate::SessionEvent;

        let server_id = u64::MAX - 41;
        let metrics = Arc::new(ServerMetrics::default());
        let (session_tx, mut session_rx) = tokio::sync::mpsc::channel(4);
        let (shutdown_tx, port) = spawn_server_instance(
            server_id,
            Arc::clone(&metrics),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            0,
            &Some(session_tx),
            &None,
            build_default_dev_resolver().expect("resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            false,
            false,
            3,
        )
        .expect("server start");
        let _shutdown = ShutdownOnDrop(Some(shutdown_tx));

        let client_cfg = insecure_loopback_client_config().expect("client cfg");
        let endpoint = wtransport::Endpoint::client(client_cfg).expect("client endpoint");
        let url = format!("https://127.0.0.1:{}/", port);
        let client_conn = endpoint.connect(url).await.expect("connect");
        let event = tokio::time::timeout(Duration::from_secs(5), session_rx.recv())
            .await
            .expect("accept timeout")
            .expect("session event");
        assert!(matches!(event, SessionEvent::Accepted(_)));

        let tracked_metrics = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&tracked_metrics),
            99,
            TaskKind::Stream,
            PanicScope::Conn(client_conn.clone()),
            panic_task(),
        );

        wait_for(|| tracked_idle(&tracked_metrics, &[99])).await;

        let _closed = tokio::time::timeout(Duration::from_secs(2), client_conn.closed())
            .await
            .expect("connection close timeout");
        drop(_shutdown);
    }
}
