//! Atomic server metrics for Phase 4.3.1. Updated by wtransport accept/session logic.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

use super::histogram::{self, LatencyHistogram};
use super::metrics::HistogramSnapshot;

/// Result of a global+session queued-bytes reservation.
///
/// Recv ingest maps `Global`/`Session` onto datagram drop reasons. The send
/// path treats both as “not reserved yet” and waits — it must not count as
/// `datagrams_dropped`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReserveQueuedBytes {
    Ok,
    Global,
    Session,
}

impl ReserveQueuedBytes {
    pub fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }
}

/// Why one inbound datagram was dropped at ingest. Handshake/stream rate-limit
/// rejects use `rate_limited_count` only and must not appear here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatagramDropReason {
    RateLimited,
    TooLarge,
    QueueGlobal,
    QueueSession,
}

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
    pub datagrams_dropped_rate_limited: AtomicU64,
    pub datagrams_dropped_too_large: AtomicU64,
    pub datagrams_dropped_queue_global: AtomicU64,
    pub datagrams_dropped_queue_session: AtomicU64,
    pub datagrams_skipped_queue_full: AtomicU64,
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

    pub fn session_queue_cannot_fit(
        session_queued: &std::sync::atomic::AtomicU64,
        session_max: u64,
        min_next_bytes: u64,
    ) -> bool {
        session_queued
            .load(Ordering::Relaxed)
            .saturating_add(min_next_bytes)
            > session_max
    }

    /// Count one park of `receive_datagram` because session slack cannot fit
    /// `max_datagram_size`. Not a drop: nothing was pulled into the addon.
    pub fn record_datagram_skip_queue_full(&self) {
        self.datagrams_skipped_queue_full
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Try to reserve n bytes against both global and per-session budget using CAS.
    pub fn try_reserve_queued_bytes_with_session(
        &self,
        session_queued: &std::sync::atomic::AtomicU64,
        n: u64,
        global_max: u64,
        session_max: u64,
    ) -> ReserveQueuedBytes {
        if !self.try_reserve_queued_bytes(n, global_max) {
            return ReserveQueuedBytes::Global;
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
            return ReserveQueuedBytes::Session;
        }
        ReserveQueuedBytes::Ok
    }

    /// Count one inbound datagram drop. Increments `datagrams_dropped` and the
    /// matching reason. Datagram rate-limit also bumps `rate_limited_count`.
    pub fn record_datagram_drop(&self, reason: DatagramDropReason) {
        self.datagrams_dropped.fetch_add(1, Ordering::Relaxed);
        match reason {
            DatagramDropReason::RateLimited => {
                self.datagrams_dropped_rate_limited
                    .fetch_add(1, Ordering::Relaxed);
                self.rate_limited_count.fetch_add(1, Ordering::Relaxed);
            }
            DatagramDropReason::TooLarge => {
                self.datagrams_dropped_too_large
                    .fetch_add(1, Ordering::Relaxed);
            }
            DatagramDropReason::QueueGlobal => {
                self.datagrams_dropped_queue_global
                    .fetch_add(1, Ordering::Relaxed);
            }
            DatagramDropReason::QueueSession => {
                self.datagrams_dropped_queue_session
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
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
        let snap = ServerMetricsSnapshot {
            now_ms: js_sys_timestamp(),
            sessions_active: self.sessions_active.load(Ordering::Relaxed) as u32,
            session_tasks_active: self.session_tasks_active.load(Ordering::Relaxed) as u32,
            stream_tasks_active: self.stream_tasks_active.load(Ordering::Relaxed) as u32,
            handshakes_in_flight: self.handshakes_in_flight.load(Ordering::Relaxed) as u32,
            streams_active: self.streams_active.load(Ordering::Relaxed) as u32,
            datagrams_in: self.datagrams_in.load(Ordering::Relaxed) as f64,
            datagrams_out: self.datagrams_out.load(Ordering::Relaxed) as f64,
            datagrams_dropped: self.datagrams_dropped.load(Ordering::Relaxed) as f64,
            datagrams_dropped_rate_limited: Some(
                self.datagrams_dropped_rate_limited.load(Ordering::Relaxed) as f64,
            ),
            datagrams_dropped_too_large: Some(
                self.datagrams_dropped_too_large.load(Ordering::Relaxed) as f64,
            ),
            datagrams_dropped_queue_global: Some(
                self.datagrams_dropped_queue_global.load(Ordering::Relaxed) as f64,
            ),
            datagrams_dropped_queue_session: Some(
                self.datagrams_dropped_queue_session.load(Ordering::Relaxed) as f64,
            ),
            datagrams_skipped_queue_full: Some(
                self.datagrams_skipped_queue_full.load(Ordering::Relaxed) as f64,
            ),
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
        };
        debug_assert_eq!(
            self.datagrams_dropped.load(Ordering::Relaxed),
            self.datagrams_dropped_rate_limited.load(Ordering::Relaxed)
                + self.datagrams_dropped_too_large.load(Ordering::Relaxed)
                + self.datagrams_dropped_queue_global.load(Ordering::Relaxed)
                + self.datagrams_dropped_queue_session.load(Ordering::Relaxed),
            "native datagram drop identity: total must equal the four ingest reasons",
        );
        snap
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

    fn assert_drop_identity(metrics: &ServerMetrics) {
        let total = metrics.datagrams_dropped.load(Ordering::Relaxed);
        let sum = metrics
            .datagrams_dropped_rate_limited
            .load(Ordering::Relaxed)
            + metrics.datagrams_dropped_too_large.load(Ordering::Relaxed)
            + metrics
                .datagrams_dropped_queue_global
                .load(Ordering::Relaxed)
            + metrics
                .datagrams_dropped_queue_session
                .load(Ordering::Relaxed);
        assert_eq!(total, sum);
        let snap = metrics.snapshot(None);
        assert_eq!(snap.datagrams_dropped, total as f64);
        assert_eq!(
            snap.datagrams_dropped,
            snap.datagrams_dropped_rate_limited.unwrap()
                + snap.datagrams_dropped_too_large.unwrap()
                + snap.datagrams_dropped_queue_global.unwrap()
                + snap.datagrams_dropped_queue_session.unwrap()
        );
    }

    #[test]
    fn datagram_drop_reasons_cover_all_four_ingest_paths() {
        use super::{DatagramDropReason, ReserveQueuedBytes};

        let metrics = ServerMetrics::default();
        let session = std::sync::atomic::AtomicU64::new(0);

        assert_eq!(
            metrics.try_reserve_queued_bytes_with_session(&session, 10, 100, 100),
            ReserveQueuedBytes::Ok
        );
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 10);
        ServerMetrics::release_session_queued_bytes(&session, &metrics, 10);

        metrics.record_datagram_drop(DatagramDropReason::RateLimited);
        metrics.record_datagram_drop(DatagramDropReason::TooLarge);
        assert_eq!(
            metrics.try_reserve_queued_bytes_with_session(&session, 10, 5, 100),
            ReserveQueuedBytes::Global
        );
        metrics.record_datagram_drop(DatagramDropReason::QueueGlobal);
        assert_eq!(
            metrics.try_reserve_queued_bytes_with_session(&session, 10, 100, 5),
            ReserveQueuedBytes::Session
        );
        metrics.record_datagram_drop(DatagramDropReason::QueueSession);

        assert_eq!(metrics.datagrams_dropped.load(Ordering::Relaxed), 4);
        assert_eq!(
            metrics
                .datagrams_dropped_rate_limited
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            metrics.datagrams_dropped_too_large.load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            metrics
                .datagrams_dropped_queue_global
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            metrics
                .datagrams_dropped_queue_session
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(metrics.rate_limited_count.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(session.load(Ordering::Relaxed), 0);
        assert_drop_identity(&metrics);
    }

    #[test]
    fn session_queue_cannot_fit_matches_legal_datagram_reserve() {
        let queued = std::sync::atomic::AtomicU64::new(0);
        assert!(!ServerMetrics::session_queue_cannot_fit(&queued, 100, 10));
        queued.store(90, Ordering::Relaxed);
        assert!(!ServerMetrics::session_queue_cannot_fit(&queued, 100, 10));
        queued.store(91, Ordering::Relaxed);
        assert!(ServerMetrics::session_queue_cannot_fit(&queued, 100, 10));
        queued.store(100, Ordering::Relaxed);
        assert!(ServerMetrics::session_queue_cannot_fit(&queued, 100, 1));

        // 1150 B into 2 MiB: 1823 packets leave 702 B slack, which cannot fit 1200.
        const PACKED: u64 = 1823 * 1150;
        const SESSION_MAX: u64 = 2 * 1024 * 1024;
        const MAX_DATAGRAM: u64 = 1200;
        assert_eq!(PACKED, 2_096_450);
        assert_eq!(SESSION_MAX, 2_097_152);
        queued.store(PACKED, Ordering::Relaxed);
        assert!(ServerMetrics::session_queue_cannot_fit(
            &queued,
            SESSION_MAX,
            MAX_DATAGRAM
        ));
        assert!(!ServerMetrics::session_queue_cannot_fit(
            &queued,
            SESSION_MAX,
            702
        ));
    }

    #[test]
    fn skip_queue_full_does_not_count_as_datagram_drop() {
        let metrics = ServerMetrics::default();
        metrics.record_datagram_skip_queue_full();
        assert_eq!(
            metrics.datagrams_skipped_queue_full.load(Ordering::Relaxed),
            1
        );
        assert_eq!(metrics.datagrams_dropped.load(Ordering::Relaxed), 0);
        assert_eq!(
            metrics
                .datagrams_dropped_queue_session
                .load(Ordering::Relaxed),
            0
        );
        let snap = metrics.snapshot(None);
        assert_eq!(snap.datagrams_skipped_queue_full, Some(1.0));
        assert_drop_identity(&metrics);
    }

    #[test]
    fn handshake_rate_limit_does_not_count_as_datagram_drop() {
        let metrics = ServerMetrics::default();
        metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
        assert_eq!(metrics.datagrams_dropped.load(Ordering::Relaxed), 0);
        assert_eq!(
            metrics
                .datagrams_dropped_rate_limited
                .load(Ordering::Relaxed),
            0
        );
        metrics.record_datagram_drop(super::DatagramDropReason::RateLimited);
        assert_eq!(metrics.datagrams_dropped.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.rate_limited_count.load(Ordering::Relaxed), 2);
        assert_drop_identity(&metrics);
    }
}
