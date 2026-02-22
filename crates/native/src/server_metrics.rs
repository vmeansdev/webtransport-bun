//! Atomic server metrics for Phase 4.3.1. Updated by wtransport accept/session logic.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct ServerMetrics {
    pub sessions_active: AtomicU64,
    pub handshakes_in_flight: AtomicU64,
    pub streams_active: AtomicU64,
    pub session_tasks_active: AtomicU64,
    pub stream_tasks_active: AtomicU64,
    pub datagrams_in: AtomicU64,
    pub datagrams_out: AtomicU64,
    pub datagrams_dropped: AtomicU64,
    pub queued_bytes_global: AtomicU64,
    pub backpressure_wait_count: AtomicU64,
    pub backpressure_timeout_count: AtomicU64,
    pub rate_limited_count: AtomicU64,
    pub limit_exceeded_count: AtomicU64,
}

impl ServerMetrics {
    /// Try to reserve n bytes against global budget. Returns true if successful.
    pub fn try_reserve_queued_bytes(&self, n: u64, max: u64) -> bool {
        let prev = self.queued_bytes_global.fetch_add(n, Ordering::Relaxed);
        if prev + n <= max {
            true
        } else {
            self.queued_bytes_global.fetch_sub(n, Ordering::Relaxed);
            false
        }
    }

    pub fn release_queued_bytes(&self, n: u64) {
        self.queued_bytes_global.fetch_sub(n, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> super::metrics::ServerMetricsSnapshot {
        use super::metrics::ServerMetricsSnapshot;
        ServerMetricsSnapshot {
            now_ms: js_sys_timestamp(),
            sessions_active: self.sessions_active.load(Ordering::Relaxed) as u32,
            session_tasks_active: self.session_tasks_active.load(Ordering::Relaxed) as u32,
            stream_tasks_active: self.stream_tasks_active.load(Ordering::Relaxed) as u32,
            handshakes_in_flight: self.handshakes_in_flight.load(Ordering::Relaxed) as u32,
            streams_active: self.streams_active.load(Ordering::Relaxed) as u32,
            datagrams_in: self.datagrams_in.load(Ordering::Relaxed) as u32,
            datagrams_out: self.datagrams_out.load(Ordering::Relaxed) as u32,
            datagrams_dropped: self.datagrams_dropped.load(Ordering::Relaxed) as u32,
            queued_bytes_global: self.queued_bytes_global.load(Ordering::Relaxed) as u32,
            backpressure_wait_count: self.backpressure_wait_count.load(Ordering::Relaxed) as u32,
            backpressure_timeout_count: self.backpressure_timeout_count.load(Ordering::Relaxed)
                as u32,
            rate_limited_count: self.rate_limited_count.load(Ordering::Relaxed) as u32,
            limit_exceeded_count: self.limit_exceeded_count.load(Ordering::Relaxed) as u32,
        }
    }
}

fn js_sys_timestamp() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
    #[cfg(target_arch = "wasm32")]
    {
        0.0
    }
}
