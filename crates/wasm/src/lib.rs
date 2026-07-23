//! webtransport-bun WASM backend bridge.
//!
//! Sans-IO WebTransport over quinn-proto (QUIC) + a minimal hand-rolled
//! HTTP/3 + WebTransport layer, exported to JS via wasm-bindgen.

pub mod cert;
pub mod endpoint;
pub mod event;
pub mod governor;
pub mod h3;
#[cfg(any(target_arch = "wasm32", test))]
mod handle;
pub mod varint;
pub mod verify;

#[cfg(target_arch = "wasm32")]
mod bridge;

// The spike's loopback handshake is a native regression test; its helpers
// (crypto config) are reused by `endpoint`, so the module is always compiled but
// the loopback driver itself is only exercised under `cargo test`.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod spike;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod spike_tests {
    #[test]
    fn loopback_handshake_completes() {
        let r = crate::spike::run_handshake().expect("handshake");
        assert!(r.starts_with("OK"), "unexpected: {r}");
    }
}
