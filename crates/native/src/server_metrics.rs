//! Atomic server metrics for Phase 4.3.1. Updated by wtransport accept/session logic.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

use super::histogram::{self, LatencyHistogram};
use super::metrics::HistogramSnapshot;

#[derive(Default)]
pub struct ServerMetrics {
    pub sessions_active: AtomicU64,
    pub handshakes_in_flight: AtomicU64,
    pub streams_active: AtomicU64,
    pub session_tasks_active: AtomicU64,
    pub stream_tasks_active: AtomicU64,
    /// The endpoint accept loop, which lives as long as the server does. Kept
    /// separate so per-session drain checks are not permanently offset by it.
    /// Diagnostic-only by design: it is read into drain-timeout error strings
    /// but deliberately NOT exported on `MetricsSnapshot` — the idle gate is
    /// `spawn_tracked::server_task_count`, which already counts this task.
    pub accept_tasks_active: AtomicU64,
    pub datagrams_in: AtomicU64,
    pub datagrams_out: AtomicU64,
    pub datagrams_dropped: AtomicU64,
    pub queued_bytes_global: AtomicU64,
    pub backpressure_wait_count: AtomicU64,
    pub backpressure_timeout_count: AtomicU64,
    /// Wakes datagram senders competing for this server instance's global byte budget.
    pub(crate) datagram_capacity_notify: Arc<Notify>,
    pub rate_limited_count: AtomicU64,
    pub limit_exceeded_count: AtomicU64,
    pub handshake_histogram: LatencyHistogram,
    pub datagram_enqueue_histogram: LatencyHistogram,
    pub stream_open_histogram: LatencyHistogram,
}

impl ServerMetrics {
    pub fn try_acquire_handshake(&self, max: u64) -> bool {
        self.handshakes_in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < max).then_some(current + 1)
            })
            .is_ok()
    }

    pub fn release_handshake(&self) {
        self.handshakes_in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                Some(current.saturating_sub(1))
            })
            .ok();
    }

    /// Try to reserve n bytes against global budget using compare-and-swap.
    pub fn try_reserve_queued_bytes(&self, n: u64, max: u64) -> bool {
        self.queued_bytes_global
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current
                    .checked_add(n)
                    .and_then(|next| (next <= max).then_some(next))
            })
            .is_ok()
    }

    pub fn release_queued_bytes(&self, n: u64) {
        self.queued_bytes_global.fetch_sub(n, Ordering::Relaxed);
    }

    /// Try to reserve n bytes against both global and per-session budget using CAS.
    pub fn try_reserve_queued_bytes_with_session(
        &self,
        session_queued: &std::sync::atomic::AtomicU64,
        n: u64,
        global_max: u64,
        session_max: u64,
    ) -> bool {
        if !self.try_reserve_queued_bytes(n, global_max) {
            return false;
        }
        let ok = session_queued
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current
                    .checked_add(n)
                    .and_then(|next| (next <= session_max).then_some(next))
            })
            .is_ok();
        if !ok {
            self.release_queued_bytes(n);
        }
        ok
    }

    pub fn release_session_queued_bytes(
        session_queued: &std::sync::atomic::AtomicU64,
        metrics: &Self,
        n: u64,
    ) {
        session_queued.fetch_sub(n, Ordering::Relaxed);
        metrics.release_queued_bytes(n);
    }

    /// Release datagram queue credit and wake both the affected session and
    /// every session competing for this server instance's global budget.
    pub fn release_datagram_capacity(
        &self,
        session_queued: &std::sync::atomic::AtomicU64,
        session_notify: &Notify,
        n: u64,
    ) {
        Self::release_session_queued_bytes(session_queued, self, n);
        session_notify.notify_waiters();
        self.datagram_capacity_notify.notify_waiters();
    }

    pub(crate) fn snapshot(
        &self,
        tls_metrics: Option<crate::server_tls::ResolverMetricsSnapshot>,
    ) -> super::metrics::ServerMetricsSnapshot {
        use super::metrics::ServerMetricsSnapshot;
        let tls_metrics = tls_metrics.unwrap_or(crate::server_tls::ResolverMetricsSnapshot {
            sni_cert_selections: 0,
            default_cert_selections: 0,
            unknown_sni_rejected_count: 0,
        });
        ServerMetricsSnapshot {
            now_ms: js_sys_timestamp(),
            sessions_active: self.sessions_active.load(Ordering::Relaxed) as u32,
            session_tasks_active: self.session_tasks_active.load(Ordering::Relaxed) as u32,
            stream_tasks_active: self.stream_tasks_active.load(Ordering::Relaxed) as u32,
            handshakes_in_flight: self.handshakes_in_flight.load(Ordering::Relaxed) as u32,
            streams_active: self.streams_active.load(Ordering::Relaxed) as u32,
            datagrams_in: self.datagrams_in.load(Ordering::Relaxed) as f64,
            datagrams_out: self.datagrams_out.load(Ordering::Relaxed) as f64,
            datagrams_dropped: self.datagrams_dropped.load(Ordering::Relaxed) as f64,
            queued_bytes_global: self.queued_bytes_global.load(Ordering::Relaxed) as f64,
            backpressure_wait_count: self.backpressure_wait_count.load(Ordering::Relaxed) as f64,
            backpressure_timeout_count: self.backpressure_timeout_count.load(Ordering::Relaxed)
                as f64,
            rate_limited_count: self.rate_limited_count.load(Ordering::Relaxed) as f64,
            limit_exceeded_count: self.limit_exceeded_count.load(Ordering::Relaxed) as f64,
            sni_cert_selections: tls_metrics.sni_cert_selections as f64,
            default_cert_selections: tls_metrics.default_cert_selections as f64,
            unknown_sni_rejected_count: tls_metrics.unknown_sni_rejected_count as f64,
            native_session_registry_entries: 0,
            native_tracked_tasks: 0,
            native_rate_limit_entries: 0,
            native_bidi_handles_live: 0,
            native_uni_send_handles_live: 0,
            native_uni_recv_handles_live: 0,
            handshake_latency: Some(histogram_to_snapshot(&self.handshake_histogram)),
            datagram_enqueue_latency: Some(histogram_to_snapshot(&self.datagram_enqueue_histogram)),
            stream_open_latency: Some(histogram_to_snapshot(&self.stream_open_histogram)),
        }
    }
}

fn histogram_to_snapshot(h: &LatencyHistogram) -> HistogramSnapshot {
    HistogramSnapshot {
        le: histogram::BUCKETS.to_vec(),
        cumulative_count: h
            .cumulative_counts()
            .iter()
            .map(|&c| c as f64)
            .collect::<Vec<_>>(),
        count: h.count() as f64,
        sum_secs: h.sum_secs(),
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

#[cfg(test)]
mod tests {
    use super::ServerMetrics;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn handshake_admission_allows_exact_limit_and_release_reopens_capacity() {
        let metrics = ServerMetrics::default();

        assert!(metrics.try_acquire_handshake(2));
        assert!(metrics.try_acquire_handshake(2));
        assert!(!metrics.try_acquire_handshake(2));
        assert_eq!(metrics.handshakes_in_flight.load(Ordering::Acquire), 2);

        metrics.release_handshake();
        assert!(metrics.try_acquire_handshake(2));
        metrics.release_handshake();
        metrics.release_handshake();
        assert_eq!(metrics.handshakes_in_flight.load(Ordering::Acquire), 0);
    }

    #[test]
    fn concurrent_handshake_admission_never_exceeds_cap() {
        let metrics = Arc::new(ServerMetrics::default());
        let mut threads = Vec::new();
        for _ in 0..32 {
            let metrics = Arc::clone(&metrics);
            threads.push(thread::spawn(move || metrics.try_acquire_handshake(4)));
        }
        let admitted = threads
            .into_iter()
            .filter_map(|thread| thread.join().ok())
            .filter(|admitted| *admitted)
            .count();

        assert_eq!(admitted, 4);
        assert_eq!(metrics.handshakes_in_flight.load(Ordering::Acquire), 4);
    }
}
