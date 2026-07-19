//! JS-facing wasm-bindgen API over a registry of WtEndpoints.
//!
//! Browsers are single-threaded; the registry is a thread-local map keyed by an
//! integer handle so JS holds only plain numbers, never Rust pointers.
#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::prelude::*;
use web_time::Instant;

use crate::endpoint::WtEndpoint;

thread_local! {
    static REGISTRY: RefCell<HashMap<u32, WtEndpoint>> = RefCell::new(HashMap::new());
    static NEXT: RefCell<u32> = const { RefCell::new(1) };
}

fn alloc_id() -> u32 {
    NEXT.with(|n| {
        let mut n = n.borrow_mut();
        let id = *n;
        *n += 1;
        id
    })
}

/// Create a test/dev endpoint. Returns the numeric eid on success, or 0 on a
/// bad address (0 is never a valid eid — allocation starts at 1). CLIENT
/// endpoints created here accept ANY server cert — use `wt_new_client` in
/// production.
#[wasm_bindgen]
pub fn wt_new_endpoint(is_server: bool, addr: &str, peer_addr: &str) -> u32 {
    // Never panic across the FFI: a wasm panic aborts and poisons REGISTRY for
    // every other live endpoint on the page.
    let (Ok(addr), Ok(peer)) = (addr.parse(), peer_addr.parse()) else {
        return 0;
    };
    let ep = WtEndpoint::new(is_server, addr, peer);
    let id = alloc_id();
    REGISTRY.with(|r| r.borrow_mut().insert(id, ep));
    id
}

/// Generate a self-signed P-256 cert. Returns JSON:
/// `{ "certPem": ..., "keyPem": ..., "certDerBase64": ..., "hashBase64": ... }`
/// where `hashBase64` is the `serverCertificateHashes` value (SHA-256 of DER).
#[wasm_bindgen]
pub fn wt_generate_cert(common_name: &str, validity_days: u32, not_before_unix: f64) -> String {
    match crate::cert::generate(common_name, validity_days, not_before_unix as i64) {
        Ok(g) => {
            use base64::Engine as _;
            let der_b64 = base64::engine::general_purpose::STANDARD.encode(&g.cert_der);
            let hash = crate::cert::sha256_base64(&g.cert_der);
            serde_json::json!({
                "certPem": g.cert_pem,
                "keyPem": g.key_pem,
                "certDerBase64": der_b64,
                "hashBase64": hash,
            })
            .to_string()
        }
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// Create a server endpoint with a freshly generated P-256 cert. Returns JSON:
/// `{ "eid": <number>, "hashBase64": ... }` for the client's serverCertificateHashes.
#[wasm_bindgen]
pub fn wt_new_server(
    addr: &str,
    peer_addr: &str,
    common_name: &str,
    validity_days: u32,
    not_before_unix: f64,
) -> String {
    let _ = addr;
    let peer = match peer_addr.parse() {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "error": format!("peer_addr: {e}") }).to_string(),
    };
    match WtEndpoint::new_with_generated_cert(
        peer,
        common_name,
        validity_days,
        not_before_unix as i64,
    ) {
        Ok((ep, hash)) => {
            let id = alloc_id();
            REGISTRY.with(|r| r.borrow_mut().insert(id, ep));
            serde_json::json!({ "eid": id, "hashBase64": hash }).to_string()
        }
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// Create a production CLIENT endpoint that pins the server certificate by
/// SHA-256(DER) — `cert_hashes_base64` is a comma-separated list of base64
/// hashes (the `hashBase64` values handed out by `wt_new_server` /
/// `wt_generate_cert`). Returns JSON `{ "eid": <number> }` or `{ "error": ... }`.
/// Unlike `wt_new_endpoint`, the TLS handshake FAILS against any other cert.
#[wasm_bindgen]
pub fn wt_new_client(addr: &str, peer_addr: &str, cert_hashes_base64: &str) -> String {
    let _ = addr;
    let peer = match peer_addr.parse() {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "error": format!("peer_addr: {e}") }).to_string(),
    };
    let hashes = match crate::verify::PinnedCertVerifier::parse_hashes(cert_hashes_base64) {
        Ok(h) => h,
        Err(e) => return serde_json::json!({ "error": e }).to_string(),
    };
    match WtEndpoint::new_client_pinned(peer, hashes) {
        Ok(ep) => {
            let id = alloc_id();
            REGISTRY.with(|r| r.borrow_mut().insert(id, ep));
            serde_json::json!({ "eid": id }).to_string()
        }
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// Close ONE connection with an application code + reason. The peer receives a
/// CONNECTION_CLOSE (pump transmits afterwards); other connections on the
/// endpoint are unaffected.
#[wasm_bindgen]
pub fn wt_close_conn(eid: u32, conn: u32, code: u32, reason: &str) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.close_conn(conn, code, reason.as_bytes(), Instant::now());
        }
    });
}

/// Close every connection on the endpoint (graceful shutdown). Pump transmits
/// afterwards, then call `wt_close_endpoint` to drop the state.
#[wasm_bindgen]
pub fn wt_close_all(eid: u32, code: u32, reason: &str) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.close_all(code, reason.as_bytes(), Instant::now());
        }
    });
}

/// Start a client connection. Returns the connection id, or -1 on error
/// (server endpoint, bad params, or unknown eid) — never panics.
#[wasm_bindgen]
pub fn wt_connect(eid: u32, authority: &str) -> f64 {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.connect(authority) as f64,
        None => -1.0,
    })
}

/// Feed an inbound UDP datagram. `source` is the remote "ip:port"; if it fails
/// to parse, the endpoint's configured peer address is used as a fallback.
#[wasm_bindgen]
pub fn wt_recv_packet(eid: u32, data: &[u8], source: &str) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            let src = source.parse().unwrap_or_else(|_| ep.peer_addr());
            ep.recv(Instant::now(), src, data);
        }
    });
}

/// Returns a flat buffer of outbound packets, each record:
/// `[dest_len:u8 | dest:utf8 "ip:port" | pkt_len:u32-le | pkt:bytes]`.
#[wasm_bindgen]
pub fn wt_poll_transmits(eid: u32) -> Vec<u8> {
    REGISTRY.with(|r| {
        let mut out = Vec::new();
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            let mut pkts = Vec::new();
            ep.poll_transmits(Instant::now(), &mut pkts);
            for (p, dest) in pkts {
                let dest = dest.to_string();
                let dest_bytes = dest.as_bytes();
                out.push(dest_bytes.len() as u8);
                out.extend_from_slice(dest_bytes);
                out.extend_from_slice(&(p.len() as u32).to_le_bytes());
                out.extend_from_slice(&p);
            }
        }
        out
    })
}

#[wasm_bindgen]
pub fn wt_next_timeout_ms(eid: u32) -> f64 {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.next_timeout_ms(),
        None => -1.0,
    })
}

#[wasm_bindgen]
pub fn wt_handle_timeout(eid: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.handle_timeout(Instant::now());
        }
    });
}

#[wasm_bindgen]
pub fn wt_poll_event(eid: u32) -> Option<Vec<u8>> {
    REGISTRY.with(|r| {
        r.borrow_mut()
            .get_mut(&eid)
            .and_then(|ep| ep.poll_event().map(|e| e.encode()))
    })
}

#[wasm_bindgen]
pub fn wt_send_datagram(eid: u32, conn: u32, data: &[u8]) -> bool {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.send_datagram(conn, data),
        None => false,
    })
}

#[wasm_bindgen]
pub fn wt_open_stream(eid: u32, conn: u32, bidi: bool) -> i32 {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.open_stream(conn, bidi),
        None => -1,
    })
}

#[wasm_bindgen]
pub fn wt_stream_write(eid: u32, stream: u32, data: &[u8]) -> f64 {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.stream_write(stream, data) as f64,
        None => -1.0,
    })
}

/// Pause reading a WT stream: data stays in quinn's recv buffer so QUIC flow
/// control throttles the sender. Call `wt_stream_resume` to drain.
#[wasm_bindgen]
pub fn wt_stream_pause(eid: u32, stream: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.stream_pause(stream);
        }
    });
}

/// Resume a paused WT stream. The caller should pump afterwards: buffered data
/// is surfaced as events and window updates as transmits.
#[wasm_bindgen]
pub fn wt_stream_resume(eid: u32, stream: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.stream_resume(stream);
        }
    });
}

#[wasm_bindgen]
pub fn wt_stream_finish(eid: u32, stream: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.stream_finish(stream);
        }
    });
}

#[wasm_bindgen]
pub fn wt_stream_reset(eid: u32, stream: u32, code: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.stream_reset(stream, code);
        }
    });
}

/// STOP_SENDING on a stream's recv half (cancel an incoming ReadableStream).
#[wasm_bindgen]
pub fn wt_stream_stop(eid: u32, stream: u32, code: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.stream_stop(stream, code);
        }
    });
}

#[wasm_bindgen]
pub fn wt_close_endpoint(eid: u32) {
    REGISTRY.with(|r| {
        r.borrow_mut().remove(&eid);
    });
}
