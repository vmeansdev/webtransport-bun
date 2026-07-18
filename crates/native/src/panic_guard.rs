//! Panic containment: wrap Rust entrypoints so wtransport/quinn panics
//! never take down the Bun process. Translate to E_INTERNAL + log.

use napi::Result;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};

const E_INTERNAL_PREFIX: &str = "E_INTERNAL: ";
static PANIC_LOG_VERBOSE: AtomicBool = AtomicBool::new(false);

pub fn set_panic_log_verbose(enabled: bool) {
    PANIC_LOG_VERBOSE.store(enabled, Ordering::Relaxed);
}

/// Run a closure, catching panics and converting to `Err(E_INTERNAL: ...)`.
/// Logs the panic for debugging.
pub fn catch_panic<R, F>(f: F) -> Result<R>
where
    F: FnOnce() -> Result<R> + std::panic::UnwindSafe,
{
    match panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(inner) => inner,
        Err(panic_any) => {
            let msg = panic_any
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| panic_any.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic (no message)".to_string());
            let verbose = PANIC_LOG_VERBOSE.load(Ordering::Relaxed);
            if verbose {
                eprintln!("webtransport-native: panic contained: {}", msg);
            } else {
                eprintln!("webtransport-native: panic contained");
            }
            let out_msg = if verbose {
                msg
            } else {
                "panic (redacted)".to_string()
            };
            Err(napi::Error::from_reason(format!(
                "{}{}",
                E_INTERNAL_PREFIX, out_msg
            )))
        }
    }
}

/// Teardown scope applied when a QUIC task panics. Keeps the blast radius
/// proportional to what the task could have corrupted: never the whole process.
pub enum PanicScope {
    /// Close a single server-side session (stream/session-scoped tasks).
    Session(String),
    /// Close every session owned by one server instance (accept-loop tasks).
    Server(u64),
    /// Close a specific connection (client-side tasks).
    Conn(wtransport::Connection),
    /// Nothing to tear down beyond the task itself; log only.
    LogOnly,
}

/// Spawn a Tokio task that touches QUIC. Panics in the task are contained:
/// the runtime continues; a watcher logs and tears down only the given scope.
/// Use this instead of `Runtime::spawn` for any task that drives wtransport/quinn.
pub fn spawn_quic_task_scoped<F>(scope: PanicScope, fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let handle = tokio::task::spawn(fut);
    tokio::task::spawn(async move {
        if let Err(e) = handle.await {
            if e.is_panic() {
                if PANIC_LOG_VERBOSE.load(Ordering::Relaxed) {
                    eprintln!(
                        "webtransport-native: QUIC task panicked (contained): {:?}",
                        e
                    );
                } else {
                    eprintln!("webtransport-native: QUIC task panicked (contained)");
                }
                match scope {
                    PanicScope::Session(id) => {
                        crate::session_registry::close_session(&id, 0, b"panic teardown");
                    }
                    PanicScope::Server(owner) => {
                        crate::session_registry::close_all_for_owner(owner, 0, b"panic teardown");
                    }
                    PanicScope::Conn(conn) => {
                        conn.close(wtransport::VarInt::from_u32(0), b"panic teardown");
                    }
                    PanicScope::LogOnly => {}
                }
            }
        }
    });
}

/// Legacy unscoped spawn: log-only containment. Prefer `spawn_quic_task_scoped`.
pub fn spawn_quic_task<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    spawn_quic_task_scoped(PanicScope::LogOnly, fut);
}
