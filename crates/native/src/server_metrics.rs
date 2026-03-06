//! Atomic server metrics for Phase 4.3.1. Updated by wtransport accept/session logic.

use std::sync::atomic::{AtomicU64, Ordering};

use super::histogram::{self, LatencyHistogram};
use super::metrics::HistogramSnapshot;

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
    pub handshake_histogram: LatencyHistogram,
    pub datagram_enqueue_histogram: LatencyHistogram,
    pub stream_open_histogram: LatencyHistogram,
}

impl ServerMetrics {
    /// Try to reserve n bytes against global budget using compare-and-swap.
    pub fn try_reserve_queued_bytes(&self, n: u64, max: u64) -> bool {
        self.queued_bytes_global
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                if current + n <= max {
                    Some(current + n)
                } else {
                    None
                }
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
                if current + n <= session_max {
                    Some(current + n)
                } else {
                    None
                }
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
            datagrams_in: self.datagrams_in.load(Ordering::Relaxed) as u32,
            datagrams_out: self.datagrams_out.load(Ordering::Relaxed) as u32,
            datagrams_dropped: self.datagrams_dropped.load(Ordering::Relaxed) as u32,
            queued_bytes_global: self.queued_bytes_global.load(Ordering::Relaxed) as u32,
            backpressure_wait_count: self.backpressure_wait_count.load(Ordering::Relaxed) as u32,
            backpressure_timeout_count: self.backpressure_timeout_count.load(Ordering::Relaxed)
                as u32,
            rate_limited_count: self.rate_limited_count.load(Ordering::Relaxed) as u32,
            limit_exceeded_count: self.limit_exceeded_count.load(Ordering::Relaxed) as u32,
            sni_cert_selections: tls_metrics.sni_cert_selections as u32,
            default_cert_selections: tls_metrics.default_cert_selections as u32,
            unknown_sni_rejected_count: tls_metrics.unknown_sni_rejected_count as u32,
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
