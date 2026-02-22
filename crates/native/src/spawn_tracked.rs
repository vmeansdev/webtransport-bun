//! spawn_tracked: wrap tokio::spawn with task gauges (Phase 4.3.3).
//! Increments gauge on spawn, decrements on completion (success or panic).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::panic_guard;
use crate::server_metrics::ServerMetrics;

pub enum TaskKind {
    Session,
    Stream,
}

/// Spawn a future on the runtime with tracked gauges.
/// Decrements on completion (including panic path via spawn_quic_task).
pub fn spawn_tracked<F>(metrics: Arc<ServerMetrics>, kind: TaskKind, fut: F)
where
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
    let wrapped = async move {
        let _guard = DropGuard::new(decrement);
        fut.await;
    };
    panic_guard::spawn_quic_task(wrapped);
}

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
