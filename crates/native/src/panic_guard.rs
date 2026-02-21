//! Panic containment: wrap Rust entrypoints so wtransport/quinn panics
//! never take down the Bun process. Translate to E_INTERNAL + log.

use napi::Result;
use std::panic::{self, AssertUnwindSafe};

const E_INTERNAL_PREFIX: &str = "E_INTERNAL: ";

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
                .or_else(|| panic_any.downcast_ref::<String>().map(|s| s.clone()))
                .unwrap_or_else(|| "panic (no message)".to_string());
            eprintln!("webtransport-native: panic contained: {}", msg);
            Err(napi::Error::from_reason(format!("{}{}", E_INTERNAL_PREFIX, msg)))
        }
    }
}
