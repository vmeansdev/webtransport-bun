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
pub mod congestion;
pub mod endpoint;
pub mod event;
pub mod governor;
pub mod h3;
#[cfg(any(target_arch = "wasm32", test))]
mod handle;
pub mod server_tls;
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

    /// End-to-end proof for the `caPem` client trust path: a server holding a
    /// CA-issued leaf completes the QUIC/TLS1.3 handshake against a client that
    /// trusts only that CA, and a client trusting a different CA is refused.
    #[test]
    fn loopback_handshake_over_ca_root_trust() {
        // Certificate lifetimes are checked against the real clock during the
        // handshake, so the chain has to be valid right now.
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after unix epoch")
            .as_secs() as i64
            - 3600;
        let chain = crate::cert::generate_ca_signed("localhost", 14, now_unix).expect("chain");
        let server_config = || {
            crate::spike::server_config_from_der(
                chain.leaf.cert_der.clone(),
                chain.leaf.key_der.clone(),
            )
            .expect("server config")
        };

        let trusted =
            crate::verify::client_crypto_ca_roots(&chain.ca_pem).expect("trusted ca client");
        let r = crate::spike::run_handshake_with(server_config(), trusted)
            .expect("ca-verified handshake");
        assert!(r.starts_with("OK"), "unexpected: {r}");

        let foreign =
            crate::cert::generate_ca_signed("other.example", 14, now_unix).expect("other ca");
        let untrusting =
            crate::verify::client_crypto_ca_roots(&foreign.ca_pem).expect("foreign ca client");
        let err = crate::spike::run_handshake_with(server_config(), untrusting)
            .expect_err("a foreign CA must not complete the handshake");
        assert!(err.contains("connection lost"), "unexpected: {err}");
    }
}
