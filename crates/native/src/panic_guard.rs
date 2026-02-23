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

/// Spawn a Tokio task that touches QUIC. Panics in the task are contained:
/// the runtime continues; a watcher logs and triggers teardown of all sessions.
/// Use this instead of `Runtime::spawn` for any task that drives wtransport/quinn.
pub fn spawn_quic_task<F>(fut: F)
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
                crate::session_registry::close_all(0, b"panic teardown");
            }
        }
    });
}
