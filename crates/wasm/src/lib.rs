//! webtransport-bun WASM backend bridge.
//!
//! Sans-IO WebTransport over quinn-proto (QUIC) + a minimal hand-rolled
//! HTTP/3 + WebTransport layer, exported to JS via wasm-bindgen.

// Fail closed for shipped artifacts: dist builds pass
// `RUSTFLAGS=--cfg wt_ship_production`. This is intentionally NOT
// `feature = "dev-insecure" + not(debug_assertions)` and NOT a Cargo feature
// pair — both of those break `cargo test/clippy --all-features` on release
// profiles. The cfg is inert unless the dist build script sets it.
#[cfg(all(feature = "dev-insecure", wt_ship_production))]
compile_error!(
    "feature \"dev-insecure\" cannot be enabled under cfg(wt_ship_production); \
     dist builds must omit --features dev-insecure"
);

pub mod cert;
pub mod endpoint;
pub mod event;
pub mod governor;
pub mod h3;
#[cfg(any(target_arch = "wasm32", test))]
mod handle;
pub mod ticket_store;
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
