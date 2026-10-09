//! Placement of quinn's endpoint driver.
//!
//! quinn spawns exactly one future while a server endpoint is being built:
//! the `EndpointDriver`, the only task that reads the shard's UDP socket.
//! Every later spawn through the same `quinn::Runtime` is a connection
//! driver. On a saturated shard (thousands of runnable connection and forward
//! tasks on a handful of workers) the reader gets one `RECV_TIME_BOUND` slice
//! per scheduler round and inbound datagrams age in the kernel queue.
//!
//! [`SplitRuntime`] routes that first spawn onto a dedicated single-thread
//! runtime owned by the server, and everything after it onto the shared
//! [`crate::RUNTIME`], so the reader never waits behind connection work. The
//! `shared` mode is byte-for-byte today's behaviour (`TokioRuntime` on the
//! shared runtime) and stays the default; the knob exists for campaign A/B
//! measurement, exactly like `WEBTRANSPORT_NATIVE_SERVER_WORKERS`.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use wtransport::quinn::{AsyncTimer, AsyncUdpSocket, Runtime, TokioRuntime};

/// Where the endpoint driver runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecvRuntimeMode {
    /// quinn's `TokioRuntime` on the shared server runtime (the default).
    Shared,
    /// The endpoint driver on its own thread; connection drivers stay shared.
    Dedicated,
}

impl RecvRuntimeMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Dedicated => "dedicated",
        }
    }
}

/// Parse `WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME`. Unset means the shared
/// runtime; only the two literal modes are honoured; anything else is an
/// error the caller turns into a fail-closed abort.
pub(crate) fn parse_recv_runtime_mode(raw: Option<&str>) -> Result<RecvRuntimeMode, ()> {
    match raw {
        None | Some("shared") => Ok(RecvRuntimeMode::Shared),
        Some("dedicated") => Ok(RecvRuntimeMode::Dedicated),
        Some(_) => Err(()),
    }
}

/// Effective endpoint-driver placement, resolved once per process so the
/// runtime and the `serverRecvRuntime` getter can never disagree.
pub(crate) fn server_recv_runtime_mode() -> RecvRuntimeMode {
    static RESOLVED: std::sync::OnceLock<RecvRuntimeMode> = std::sync::OnceLock::new();
    *RESOLVED.get_or_init(|| {
        let raw = std::env::var("WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME").ok();
        match parse_recv_runtime_mode(raw.as_deref()) {
            Ok(mode) => mode,
            Err(()) => {
                eprintln!(
                    "webtransport-native: FATAL E_INTERNAL: WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME must be 'shared' or 'dedicated', got '{}'",
                    raw.unwrap_or_default()
                );
                std::process::abort();
            }
        }
    })
}

/// A quinn runtime whose first spawn (the endpoint driver) lands on a
/// dedicated current-thread runtime and whose later spawns (connection
/// drivers) land on the shared server runtime.
pub(crate) struct SplitRuntime {
    reader: tokio::runtime::Handle,
    shutdown: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    spawns: AtomicUsize,
    inner: TokioRuntime,
}

impl std::fmt::Debug for SplitRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SplitRuntime")
            .field("spawns", &self.spawns.load(Ordering::Relaxed))
            .finish()
    }
}

impl SplitRuntime {
    /// Build the reader runtime on its own OS thread. The thread blocks in
    /// `block_on` until [`Drop`] fires the shutdown signal, so the runtime is
    /// created and destroyed on that thread and never dropped from async
    /// context.
    pub(crate) fn new(server_id: u64) -> io::Result<Arc<Self>> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .thread_name(format!("wt-quic-recv-{server_id}"))
            .build()?;
        let reader = runtime.handle().clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        std::thread::Builder::new()
            .name(format!("wt-quic-recv-{server_id}"))
            .spawn(move || {
                let _ = runtime.block_on(shutdown_rx);
                runtime.shutdown_background();
            })?;
        Ok(Arc::new(Self {
            reader,
            shutdown: std::sync::Mutex::new(Some(shutdown_tx)),
            spawns: AtomicUsize::new(0),
            inner: TokioRuntime,
        }))
    }

    /// Number of futures spawned through this runtime so far. quinn spawns
    /// exactly one (the endpoint driver) while the endpoint is constructed;
    /// the construction site asserts that.
    pub(crate) fn spawn_count(&self) -> usize {
        self.spawns.load(Ordering::SeqCst)
    }
}

impl Drop for SplitRuntime {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.shutdown.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
    }
}

impl Runtime for SplitRuntime {
    fn new_timer(&self, i: Instant) -> Pin<Box<dyn AsyncTimer>> {
        self.inner.new_timer(i)
    }

    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send>>) {
        let index = self.spawns.fetch_add(1, Ordering::SeqCst);
        if index == 0 {
            self.reader.spawn(future);
        } else {
            crate::RUNTIME.spawn(future);
        }
    }

    fn wrap_udp_socket(&self, sock: std::net::UdpSocket) -> io::Result<Arc<dyn AsyncUdpSocket>> {
        // Register the socket with the reader runtime's I/O driver: that is
        // the runtime that polls it.
        let _guard = self.reader.enter();
        // A second handle to the same socket for the batch flusher; the
        // inner wrapper keeps the original for receive and readiness.
        let flusher_socket = match crate::udp_send_batch::configured_batch() {
            Some(_) => Some(sock.try_clone()?),
            None => None,
        };
        let inner = self.inner.wrap_udp_socket(sock)?;
        Ok(match flusher_socket {
            Some(raw) => crate::udp_send_batch::wrap(inner, raw),
            None => inner,
        })
    }

    fn now(&self) -> Instant {
        self.inner.now()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_two_modes() {
        assert_eq!(parse_recv_runtime_mode(None), Ok(RecvRuntimeMode::Shared));
        assert_eq!(
            parse_recv_runtime_mode(Some("shared")),
            Ok(RecvRuntimeMode::Shared)
        );
        assert_eq!(
            parse_recv_runtime_mode(Some("dedicated")),
            Ok(RecvRuntimeMode::Dedicated)
        );
        assert_eq!(parse_recv_runtime_mode(Some("")), Err(()));
        assert_eq!(parse_recv_runtime_mode(Some("Dedicated")), Err(()));
        assert_eq!(parse_recv_runtime_mode(Some("both")), Err(()));
    }

    #[test]
    fn first_spawn_runs_on_the_reader_thread_and_later_spawns_on_the_shared_runtime() {
        let split = SplitRuntime::new(7).expect("reader runtime");
        let (tx1, rx1) = std::sync::mpsc::channel::<String>();
        let (tx2, rx2) = std::sync::mpsc::channel::<String>();
        let name = || std::thread::current().name().unwrap_or("").to_string();
        split.spawn(Box::pin(async move {
            let _ = tx1.send(name());
        }));
        split.spawn(Box::pin(async move {
            let _ = tx2.send(name());
        }));
        let first = rx1
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("first spawn ran");
        let second = rx2
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("second spawn ran");
        assert_eq!(first, "wt-quic-recv-7");
        assert!(
            second.starts_with("wt-server"),
            "second spawn ran on {second}"
        );
        assert_eq!(split.spawn_count(), 2);
    }

    #[test]
    fn dropping_the_runtime_stops_the_reader_thread() {
        let split = SplitRuntime::new(9).expect("reader runtime");
        let handle = split.reader.clone();
        drop(split);
        // After shutdown the handle can no longer spawn: spawning on a
        // shut-down runtime panics inside tokio, so probe with `try_current`
        // semantics instead: the block below must not hang.
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handle.spawn(async {});
            }));
            let _ = tx.send(());
        });
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("shutdown must not hang the probe thread");
    }
}
