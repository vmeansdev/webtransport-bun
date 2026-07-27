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
use crate::governor::{WasmLimits, WasmRateLimits};
use crate::h3;
use crate::handle::HandleAllocator;

thread_local! {
    static REGISTRY: RefCell<HashMap<u32, WtEndpoint>> = RefCell::new(HashMap::new());
    static NEXT: RefCell<HandleAllocator> = const { RefCell::new(HandleAllocator::new()) };
}

const REGISTRY_UNAVAILABLE: &str = "E_INTERNAL: endpoint registry unavailable";
const INVALID_OPTIONS_TIMESTAMP: &str = "E_INTERNAL: notBeforeUnix must be a finite integer";

fn register_endpoint(endpoint: WtEndpoint) -> Result<u32, String> {
    REGISTRY
        .try_with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| REGISTRY_UNAVAILABLE.to_string())?;
            let id = NEXT
                .try_with(|next| {
                    let mut next = next
                        .try_borrow_mut()
                        .map_err(|_| REGISTRY_UNAVAILABLE.to_string())?;
                    next.allocate().map_err(str::to_string)
                })
                .map_err(|_| REGISTRY_UNAVAILABLE.to_string())??;
            if registry.contains_key(&id) {
                return Err("E_INTERNAL: endpoint handle collision".to_string());
            }
            registry.insert(id, endpoint);
            Ok(id)
        })
        .map_err(|_| REGISTRY_UNAVAILABLE.to_string())?
}

fn with_endpoint_mut<R>(
    eid: u32,
    operation: impl FnOnce(&mut WtEndpoint) -> R,
) -> Result<Option<R>, &'static str> {
    REGISTRY
        .try_with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| REGISTRY_UNAVAILABLE)?;
            Ok(registry.get_mut(&eid).map(operation))
        })
        .map_err(|_| REGISTRY_UNAVAILABLE)?
}

fn with_endpoint<R>(
    eid: u32,
    operation: impl FnOnce(&WtEndpoint) -> R,
) -> Result<Option<R>, &'static str> {
    REGISTRY
        .try_with(|registry| {
            let registry = registry.try_borrow().map_err(|_| REGISTRY_UNAVAILABLE)?;
            Ok(registry.get(&eid).map(operation))
        })
        .map_err(|_| REGISTRY_UNAVAILABLE)?
}

fn parse_unix_seconds(value: f64) -> Result<i64, String> {
    if !value.is_finite() {
        return Err("E_INTERNAL: notBeforeUnix must be finite".to_string());
    }
    if value.fract() != 0.0 || value < i64::MIN as f64 || value >= i64::MAX as f64 {
        return Err("E_INTERNAL: notBeforeUnix must be an integer".to_string());
    }
    Ok(value as i64)
}

fn parse_options_unix_seconds(value: Option<&serde_json::Value>) -> Result<i64, String> {
    let value = value
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| INVALID_OPTIONS_TIMESTAMP.to_string())?;
    parse_unix_seconds(value).map_err(|_| INVALID_OPTIONS_TIMESTAMP.to_string())
}

fn parse_limits(value: &serde_json::Value) -> Result<WasmLimits, String> {
    let limits = value
        .get("limits")
        .ok_or_else(|| "limits missing".to_string())?;
    let as_usize = |key: &str| -> Result<usize, String> {
        limits
            .get(key)
            .and_then(|v| v.as_u64())
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| format!("invalid limits.{key}"))
    };
    let as_u64 = |key: &str| -> Result<u64, String> {
        limits
            .get(key)
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("invalid limits.{key}"))
    };
    Ok(WasmLimits {
        max_sessions: as_usize("maxSessions")?,
        max_handshakes_in_flight: as_usize("maxHandshakesInFlight")?,
        max_streams_per_session_bidi: as_usize("maxStreamsPerSessionBidi")?,
        max_streams_per_session_uni: as_usize("maxStreamsPerSessionUni")?,
        max_streams_global: as_usize("maxStreamsGlobal")?,
        max_datagram_size: as_usize("maxDatagramSize")?,
        max_queued_bytes_global: as_usize("maxQueuedBytesGlobal")?,
        max_queued_bytes_per_session: as_usize("maxQueuedBytesPerSession")?,
        max_queued_bytes_per_stream: as_usize("maxQueuedBytesPerStream")?,
        backpressure_timeout_ms: as_u64("backpressureTimeoutMs")?,
        handshake_timeout_ms: as_u64("handshakeTimeoutMs")?,
        idle_timeout_ms: as_u64("idleTimeoutMs")?,
    })
}

fn parse_rate_limits(value: &serde_json::Value) -> Result<WasmRateLimits, String> {
    let limits = value
        .get("rateLimits")
        .ok_or_else(|| "rateLimits missing".to_string())?;
    let as_u32 = |key: &str| -> Result<u32, String> {
        limits
            .get(key)
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| format!("invalid rateLimits.{key}"))
    };
    Ok(WasmRateLimits {
        handshakes_per_sec: as_u32("handshakesPerSec")?,
        handshakes_burst: as_u32("handshakesBurst")?,
        stream_opens_per_sec: as_u32("streamOpensPerSec")?,
        stream_opens_burst: as_u32("streamOpensBurst")?,
        datagrams_ingress_per_sec: as_u32("datagramsIngressPerSec")?,
        datagrams_ingress_burst: as_u32("datagramsIngressBurst")?,
    })
}

/// Optional `wtMaxSessions` (SETTINGS_WT_MAX_SESSIONS per QUIC connection).
/// When omitted, the Rust default (`WT_MAX_SESSIONS_DEFAULT`, currently 2) applies.
fn apply_optional_wt_max_sessions(ep: &mut WtEndpoint, parsed: &serde_json::Value) {
    if let Some(n) = parsed.get("wtMaxSessions").and_then(|v| v.as_u64()) {
        ep.set_wt_max_sessions(n);
    }
}

/// Optional `enable0Rtt` (QUIC TLS 1.3 early data). Default false.
fn parse_enable_0rtt(parsed: &serde_json::Value) -> bool {
    parsed
        .get("enable0Rtt")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Opt-in process-shared 0-RTT ticket store (loopback). Default false = per-endpoint.
fn parse_share_process_0rtt_ticket_store(parsed: &serde_json::Value) -> bool {
    parsed
        .get("shareProcess0RttTicketStore")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Opt-in dynamic QPACK SETTINGS. Default disabled (0/0).
/// `enableDynamicQpack: true` aliases `{4096, 16}`.
/// Capacity/blocked streams are hard-capped to bound allocator abuse.
const QPACK_MAX_TABLE_CAPACITY_HARD_CAP: u64 = 65_536;
const QPACK_MAX_BLOCKED_STREAMS_HARD_CAP: u64 = 128;

fn parse_qpack_settings(parsed: &serde_json::Value) -> h3::QpackLocalSettings {
    if parsed
        .get("enableDynamicQpack")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return h3::QpackLocalSettings::default();
    }
    let capacity = parsed
        .get("qpackMaxTableCapacity")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(QPACK_MAX_TABLE_CAPACITY_HARD_CAP);
    let blocked = if capacity > 0 {
        parsed
            .get("qpackBlockedStreams")
            .and_then(|v| v.as_u64())
            .unwrap_or(16)
            .min(QPACK_MAX_BLOCKED_STREAMS_HARD_CAP)
    } else {
        parsed
            .get("qpackBlockedStreams")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(QPACK_MAX_BLOCKED_STREAMS_HARD_CAP)
    };
    h3::QpackLocalSettings {
        max_table_capacity: capacity,
        max_blocked_streams: blocked,
    }
}

/// Create an endpoint. Returns the numeric eid on success, or 0 on a bad
/// address (0 is never a valid eid — allocation starts at 1).
///
/// SECURITY: a CLIENT endpoint (`is_server == false`) created here uses the
/// accept-any TLS verifier. That path is compiled ONLY when the `dev-insecure`
/// cargo feature is enabled (pkg/test builds). A production/dist build returns
/// 0 for `is_server == false`; callers must use `wt_new_client` (hash pinning).
/// Dist builds also set `RUSTFLAGS=--cfg wt_ship_production`, which
/// `compile_error!`s if combined with `--features dev-insecure`.
/// Server endpoints are always available.
#[wasm_bindgen]
pub fn wt_new_endpoint(is_server: bool, addr: &str, peer_addr: &str) -> u32 {
    // Never panic across the FFI: a wasm panic aborts and poisons REGISTRY for
    // every other live endpoint on the page.
    let (Ok(addr), Ok(peer)) = (addr.parse(), peer_addr.parse()) else {
        return 0;
    };
    if !is_server && !cfg!(feature = "dev-insecure") {
        // Accept-any client is not available in a production build.
        return 0;
    }
    let ep = match WtEndpoint::new_with_limits(is_server, addr, peer, WasmLimits::default()) {
        Ok(ep) => ep,
        Err(_) => return 0,
    };
    register_endpoint(ep).unwrap_or(0)
}

/// Create an endpoint from one normalized JSON config object:
/// `{ isServer, addr, peerAddr, limits }`.
#[wasm_bindgen]
pub fn wt_new_endpoint_with_options(config_json: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(config_json) {
        Ok(value) => value,
        Err(err) => {
            return serde_json::json!({ "error": format!("config json: {err}") }).to_string()
        }
    };
    let is_server = parsed
        .get("isServer")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let addr = match parsed.get("addr").and_then(|v| v.as_str()) {
        Some(addr) => addr,
        None => return serde_json::json!({ "error": "addr missing" }).to_string(),
    };
    let peer_addr = match parsed.get("peerAddr").and_then(|v| v.as_str()) {
        Some(peer_addr) => peer_addr,
        None => return serde_json::json!({ "error": "peerAddr missing" }).to_string(),
    };
    let (Ok(addr), Ok(peer)) = (addr.parse(), peer_addr.parse()) else {
        return serde_json::json!({ "error": "invalid addr or peerAddr" }).to_string();
    };
    let limits = match parse_limits(&parsed) {
        Ok(limits) => limits,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let rate_limits = match parse_rate_limits(&parsed) {
        Ok(rate_limits) => rate_limits,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    if !is_server && !cfg!(feature = "dev-insecure") {
        return serde_json::json!({ "error": "accept-any client path unavailable" }).to_string();
    }
    let enable_0rtt = parse_enable_0rtt(&parsed);
    let share_tickets = parse_share_process_0rtt_ticket_store(&parsed);
    let mut ep = match WtEndpoint::new_with_limits_rate_limits_0rtt_and_ticket_share(
        is_server,
        addr,
        peer,
        limits,
        rate_limits,
        enable_0rtt,
        share_tickets,
    ) {
        Ok(ep) => ep,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    apply_optional_wt_max_sessions(&mut ep, &parsed);
    ep.set_qpack_settings(parse_qpack_settings(&parsed));
    match register_endpoint(ep) {
        Ok(id) => serde_json::json!({ "eid": id }).to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

/// Generate a self-signed P-256 cert. Returns JSON:
/// `{ "certPem": ..., "keyPem": ..., "certDerBase64": ..., "hashBase64": ... }`
/// where `hashBase64` is the `serverCertificateHashes` value (SHA-256 of DER).
#[wasm_bindgen]
pub fn wt_generate_cert(common_name: &str, validity_days: u32, not_before_unix: f64) -> String {
    let not_before_unix = match parse_unix_seconds(not_before_unix) {
        Ok(value) => value,
        Err(error) => return serde_json::json!({ "error": error }).to_string(),
    };
    match crate::cert::generate(common_name, validity_days, not_before_unix) {
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
    let not_before_unix = match parse_unix_seconds(not_before_unix) {
        Ok(value) => value,
        Err(error) => return serde_json::json!({ "error": error }).to_string(),
    };
    match WtEndpoint::new_with_generated_cert_with_limits(
        peer,
        common_name,
        validity_days,
        not_before_unix,
        WasmLimits::default(),
    ) {
        Ok((ep, hash)) => match register_endpoint(ep) {
            Ok(id) => serde_json::json!({ "eid": id, "hashBase64": hash }).to_string(),
            Err(error) => serde_json::json!({ "error": error }).to_string(),
        },
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// Create a server endpoint from one normalized JSON config object:
/// `{ addr, peerAddr, commonName, validityDays, notBeforeUnix, limits }`.
#[wasm_bindgen]
pub fn wt_new_server_with_options(config_json: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(config_json) {
        Ok(value) => value,
        Err(err) => {
            return serde_json::json!({ "error": format!("config json: {err}") }).to_string()
        }
    };
    let peer_addr = match parsed.get("peerAddr").and_then(|v| v.as_str()) {
        Some(peer_addr) => peer_addr,
        None => return serde_json::json!({ "error": "peerAddr missing" }).to_string(),
    };
    let common_name = parsed
        .get("commonName")
        .and_then(|v| v.as_str())
        .unwrap_or("localhost");
    let validity_days = parsed
        .get("validityDays")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(14);
    let not_before_unix = match parse_options_unix_seconds(parsed.get("notBeforeUnix")) {
        Ok(value) => value,
        Err(error) => return serde_json::json!({ "error": error }).to_string(),
    };
    let peer = match peer_addr.parse() {
        Ok(peer) => peer,
        Err(err) => return serde_json::json!({ "error": format!("peer_addr: {err}") }).to_string(),
    };
    let limits = match parse_limits(&parsed) {
        Ok(limits) => limits,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let rate_limits = match parse_rate_limits(&parsed) {
        Ok(rate_limits) => rate_limits,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let enable_0rtt = parse_enable_0rtt(&parsed);
    let share_tickets = parse_share_process_0rtt_ticket_store(&parsed);
    match WtEndpoint::new_with_generated_cert_with_limits_rate_limits_0rtt_and_ticket_share(
        peer,
        common_name,
        validity_days,
        not_before_unix,
        limits,
        rate_limits,
        enable_0rtt,
        share_tickets,
    ) {
        Ok((mut ep, hash)) => {
            apply_optional_wt_max_sessions(&mut ep, &parsed);
            ep.set_qpack_settings(parse_qpack_settings(&parsed));
            match register_endpoint(ep) {
                Ok(id) => serde_json::json!({ "eid": id, "hashBase64": hash }).to_string(),
                Err(error) => serde_json::json!({ "error": error }).to_string(),
            }
        }
        Err(err) => serde_json::json!({ "error": err }).to_string(),
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
    match WtEndpoint::new_client_pinned_with_limits(peer, hashes, WasmLimits::default()) {
        Ok(ep) => match register_endpoint(ep) {
            Ok(id) => serde_json::json!({ "eid": id }).to_string(),
            Err(error) => serde_json::json!({ "error": error }).to_string(),
        },
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// Create a pinned client endpoint from one normalized JSON config object:
/// `{ addr, peerAddr, certHashesBase64, limits }`.
#[wasm_bindgen]
pub fn wt_new_client_with_options(config_json: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(config_json) {
        Ok(value) => value,
        Err(err) => {
            return serde_json::json!({ "error": format!("config json: {err}") }).to_string()
        }
    };
    let peer_addr = match parsed.get("peerAddr").and_then(|v| v.as_str()) {
        Some(peer_addr) => peer_addr,
        None => return serde_json::json!({ "error": "peerAddr missing" }).to_string(),
    };
    let cert_hashes_base64 = match parsed.get("certHashesBase64").and_then(|v| v.as_str()) {
        Some(cert_hashes_base64) => cert_hashes_base64,
        None => return serde_json::json!({ "error": "certHashesBase64 missing" }).to_string(),
    };
    let peer = match peer_addr.parse() {
        Ok(peer) => peer,
        Err(err) => return serde_json::json!({ "error": format!("peer_addr: {err}") }).to_string(),
    };
    let hashes = match crate::verify::PinnedCertVerifier::parse_hashes(cert_hashes_base64) {
        Ok(hashes) => hashes,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let limits = match parse_limits(&parsed) {
        Ok(limits) => limits,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let rate_limits = match parse_rate_limits(&parsed) {
        Ok(rate_limits) => rate_limits,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let enable_0rtt = parse_enable_0rtt(&parsed);
    let share_tickets = parse_share_process_0rtt_ticket_store(&parsed);
    match WtEndpoint::new_client_pinned_with_limits_rate_limits_0rtt_and_ticket_share(
        peer,
        hashes,
        limits,
        rate_limits,
        enable_0rtt,
        share_tickets,
    ) {
        Ok(mut ep) => {
            apply_optional_wt_max_sessions(&mut ep, &parsed);
            ep.set_qpack_settings(parse_qpack_settings(&parsed));
            match register_endpoint(ep) {
                Ok(id) => serde_json::json!({ "eid": id }).to_string(),
                Err(error) => serde_json::json!({ "error": error }).to_string(),
            }
        }
        Err(err) => serde_json::json!({ "error": err }).to_string(),
    }
}

/// Close ONE connection with an application code + reason. The peer receives a
/// CONNECTION_CLOSE (pump transmits afterwards); other connections on the
/// endpoint are unaffected.
#[wasm_bindgen]
pub fn wt_close_conn(eid: u32, conn: u32, code: u32, reason: &str) {
    let _ = with_endpoint_mut(eid, |endpoint| {
        endpoint.close_conn(conn, code, reason.as_bytes(), Instant::now());
    });
}

/// Close every connection on the endpoint (graceful shutdown). Pump transmits
/// afterwards, then call `wt_close_endpoint` to drop the state.
#[wasm_bindgen]
pub fn wt_close_all(eid: u32, code: u32, reason: &str) {
    let _ = with_endpoint_mut(eid, |endpoint| {
        endpoint.close_all(code, reason.as_bytes(), Instant::now());
    });
}

/// Start a client connection. Returns the connection id, or -1 on error
/// (server endpoint, bad params, or unknown eid) — never panics.
#[wasm_bindgen]
pub fn wt_connect(eid: u32, authority: &str) -> f64 {
    with_endpoint_mut(eid, |endpoint| endpoint.connect(authority) as f64)
        .ok()
        .flatten()
        .unwrap_or(-1.0)
}

/// Feed an inbound UDP datagram. `source` must be the real remote "ip:port";
/// malformed source metadata is rejected rather than collapsed onto a trusted
/// fallback address.
#[wasm_bindgen]
pub fn wt_recv_packet(eid: u32, data: &[u8], source: &str) {
    let _ = with_endpoint_mut(eid, |endpoint| {
        let Ok(src) = source.parse() else {
            endpoint.set_last_error("E_INTERNAL: invalid source address");
            return;
        };
        endpoint.recv(Instant::now(), src, data);
    });
}

/// Returns a flat buffer of outbound packets, each record:
/// `[dest_len:u8 | dest:utf8 "ip:port" | pkt_len:u32-le | pkt:bytes]`.
#[wasm_bindgen]
pub fn wt_poll_transmits(eid: u32) -> Vec<u8> {
    with_endpoint_mut(eid, |endpoint| {
        let mut out = Vec::new();
        let mut packets = Vec::new();
        endpoint.poll_transmits(Instant::now(), &mut packets);
        for (packet, destination) in packets {
            let destination = destination.to_string();
            let destination_bytes = destination.as_bytes();
            out.push(destination_bytes.len() as u8);
            out.extend_from_slice(destination_bytes);
            out.extend_from_slice(&(packet.len() as u32).to_le_bytes());
            out.extend_from_slice(&packet);
        }
        out
    })
    .ok()
    .flatten()
    .unwrap_or_default()
}

#[wasm_bindgen]
pub fn wt_next_timeout_ms(eid: u32) -> f64 {
    with_endpoint_mut(eid, WtEndpoint::next_timeout_ms)
        .ok()
        .flatten()
        .unwrap_or(-1.0)
}

#[wasm_bindgen]
pub fn wt_handle_timeout(eid: u32) {
    let _ = with_endpoint_mut(eid, |endpoint| endpoint.handle_timeout(Instant::now()));
}

#[wasm_bindgen]
pub fn wt_poll_event(eid: u32) -> Option<Vec<u8>> {
    with_endpoint_mut(eid, WtEndpoint::poll_event_encoded)
        .ok()
        .flatten()
        .flatten()
}

#[wasm_bindgen]
pub fn wt_release_host_reservation(eid: u32, token: u32) -> bool {
    with_endpoint_mut(eid, |endpoint| endpoint.release_host_token(token))
        .ok()
        .flatten()
        .unwrap_or(false)
}

#[wasm_bindgen]
pub fn wt_take_last_error(eid: u32) -> String {
    match with_endpoint_mut(eid, WtEndpoint::take_last_error) {
        Ok(Some(error)) => error.unwrap_or_default(),
        Ok(None) => String::new(),
        Err(error) => error.to_string(),
    }
}

#[wasm_bindgen]
pub fn wt_governor_snapshot(eid: u32) -> String {
    match with_endpoint(eid, WtEndpoint::governor_snapshot_json) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => "{}".to_string(),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[wasm_bindgen]
pub fn wt_send_datagram(eid: u32, conn: u32, session_id: u64, data: &[u8]) -> bool {
    with_endpoint_mut(eid, |endpoint| {
        endpoint.send_datagram(conn, session_id, data)
    })
    .ok()
    .flatten()
    .unwrap_or(false)
}

#[wasm_bindgen]
pub fn wt_max_datagram_size(eid: u32, conn: u32, session_id: u64) -> f64 {
    with_endpoint_mut(eid, |endpoint| endpoint.max_datagram_size(conn, session_id))
        .ok()
        .flatten()
        .flatten()
        .map_or(-1.0, |size| size as f64)
}

#[wasm_bindgen]
pub fn wt_open_stream(eid: u32, conn: u32, session_id: u64, bidi: bool) -> i32 {
    with_endpoint_mut(eid, |endpoint| endpoint.open_stream(conn, session_id, bidi))
        .ok()
        .flatten()
        .unwrap_or(-1)
}

#[wasm_bindgen]
pub fn wt_open_session(eid: u32, conn: u32) -> f64 {
    with_endpoint_mut(eid, |endpoint| endpoint.open_wt_session(conn) as f64)
        .ok()
        .flatten()
        .unwrap_or(-1.0)
}

#[wasm_bindgen]
pub fn wt_close_session(eid: u32, conn: u32, session_id: u64, code: u32, reason: &str) -> bool {
    with_endpoint_mut(eid, |endpoint| {
        endpoint.close_wt_session(conn, session_id, code, reason.as_bytes())
    })
    .ok()
    .flatten()
    .unwrap_or(false)
}

#[wasm_bindgen]
pub fn wt_stream_write(eid: u32, stream: u32, data: &[u8]) -> f64 {
    with_endpoint_mut(eid, |endpoint| endpoint.stream_write(stream, data) as f64)
        .ok()
        .flatten()
        .unwrap_or(-1.0)
}

/// Pause reading a WT stream: data stays in quinn's recv buffer so QUIC flow
/// control throttles the sender. Call `wt_stream_resume` to drain.
#[wasm_bindgen]
pub fn wt_stream_pause(eid: u32, stream: u32) {
    let _ = with_endpoint_mut(eid, |endpoint| endpoint.stream_pause(stream));
}

/// Resume a paused WT stream. The caller should pump afterwards: buffered data
/// is surfaced as events and window updates as transmits.
#[wasm_bindgen]
pub fn wt_stream_resume(eid: u32, stream: u32) {
    let _ = with_endpoint_mut(eid, |endpoint| endpoint.stream_resume(stream));
}

#[wasm_bindgen]
pub fn wt_stream_finish(eid: u32, stream: u32) {
    let _ = with_endpoint_mut(eid, |endpoint| endpoint.stream_finish(stream));
}

#[wasm_bindgen]
pub fn wt_stream_reset(eid: u32, stream: u32, code: u32) {
    let _ = with_endpoint_mut(eid, |endpoint| endpoint.stream_reset(stream, code));
}

/// STOP_SENDING on a stream's recv half (cancel an incoming ReadableStream).
#[wasm_bindgen]
pub fn wt_stream_stop(eid: u32, stream: u32, code: u32) {
    let _ = with_endpoint_mut(eid, |endpoint| endpoint.stream_stop(stream, code));
}

#[wasm_bindgen]
pub fn wt_conn_has_0rtt(eid: u32, conn: u32) -> bool {
    with_endpoint_mut(eid, |endpoint| endpoint.conn_has_0rtt(conn))
        .ok()
        .flatten()
        .unwrap_or(false)
}

#[wasm_bindgen]
pub fn wt_conn_accepted_0rtt(eid: u32, conn: u32) -> bool {
    with_endpoint_mut(eid, |endpoint| endpoint.conn_accepted_0rtt(conn))
        .ok()
        .flatten()
        .unwrap_or(false)
}

#[wasm_bindgen]
pub fn wt_enable_0rtt(eid: u32) -> bool {
    with_endpoint_mut(eid, |endpoint| endpoint.enable_0rtt())
        .ok()
        .flatten()
        .unwrap_or(false)
}

/// Dump client TLS tickets for `server_name` into an opaque process-local blob.
/// Empty vector when no tickets / no 0-RTT store.
#[wasm_bindgen]
pub fn wt_dump_client_ticket(eid: u32, server_name: &str) -> Vec<u8> {
    with_endpoint_mut(eid, |endpoint| endpoint.dump_client_ticket(server_name))
        .ok()
        .flatten()
        .flatten()
        .unwrap_or_default()
}

/// Hydrate opaque client-ticket blob into the endpoint store before connect.
#[wasm_bindgen]
pub fn wt_import_client_ticket(eid: u32, server_name: &str, blob: &[u8]) -> bool {
    with_endpoint_mut(eid, |endpoint| {
        endpoint.import_client_ticket(server_name, blob)
    })
    .ok()
    .flatten()
    .unwrap_or(false)
}

#[wasm_bindgen]
pub fn wt_close_endpoint(eid: u32) {
    let _ = REGISTRY.try_with(|registry| {
        if let Ok(mut registry) = registry.try_borrow_mut() {
            registry.remove(&eid);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        wt_close_endpoint, wt_new_endpoint_with_options, wt_recv_packet, wt_take_last_error,
        REGISTRY,
    };

    #[test]
    fn recv_packet_rejects_invalid_source_without_peer_fallback() {
        let config = serde_json::json!({
            "isServer": true,
            "addr": "127.0.0.1:4433",
            "peerAddr": "127.0.0.1:5544",
            "limits": {
                "maxSessions": 2000,
                "maxHandshakesInFlight": 200,
                "maxStreamsPerSessionBidi": 200,
                "maxStreamsPerSessionUni": 200,
                "maxStreamsGlobal": 50000,
                "maxDatagramSize": 1200,
                "maxQueuedBytesGlobal": 512 * 1024 * 1024,
                "maxQueuedBytesPerSession": 2 * 1024 * 1024,
                "maxQueuedBytesPerStream": 256 * 1024,
                "backpressureTimeoutMs": 5000,
                "handshakeTimeoutMs": 10000,
                "idleTimeoutMs": 60000
            },
            "rateLimits": {
                "handshakesPerSec": 20,
                "handshakesBurst": 40,
                "streamOpensPerSec": 200,
                "streamOpensBurst": 400,
                "datagramsIngressPerSec": 2000,
                "datagramsIngressBurst": 5000
            }
        })
        .to_string();
        let created: serde_json::Value =
            serde_json::from_str(&wt_new_endpoint_with_options(&config)).expect("endpoint json");
        let eid = created
            .get("eid")
            .and_then(|value| value.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .expect("endpoint id");

        wt_recv_packet(eid, b"ignored", "not-a-socket-address");

        let error = wt_take_last_error(eid);
        assert_eq!(error, "E_INTERNAL: invalid source address");
        assert!(!error.contains("127.0.0.1"));
        assert!(!error.contains("5544"));

        REGISTRY.with(|registry| {
            let registry = registry.borrow();
            let endpoint = registry.get(&eid).expect("endpoint still registered");
            let snapshot: serde_json::Value =
                serde_json::from_str(&endpoint.governor_snapshot_json()).expect("snapshot json");
            assert_eq!(
                snapshot,
                serde_json::json!({
                    "sessionsActive": 0,
                    "handshakesInFlight": 0,
                    "streamsActiveGlobal": 0,
                    "queuedBytesGlobal": 0,
                    "hostTokensActive": 0,
                    "rateLimitBucketCount": 0,
                    "rateLimitedHandshakeCount": 0,
                    "rateLimitedStreamOpenCount": 0,
                    "rateLimitedDatagramIngressCount": 0,
                    "handshakeTimeoutMs": 10000,
                    "idleTimeoutMs": 60000,
                })
            );
        });

        wt_close_endpoint(eid);
    }
}
