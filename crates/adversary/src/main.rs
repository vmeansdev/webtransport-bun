//! Adversarial QUIC/H3 client for hardening the webtransport-bun addon server.
//!
//! Unlike the wtransport-based reference clients, this drives quinn directly so
//! it can send input the library client would never produce: malformed H3
//! control/request streams, invalid frame types, truncated CONNECTs, stream and
//! connection floods, and garbage datagrams. The goal is to prove the addon
//! server never panics, hangs, or leaks — it just rejects the junk and keeps
//! serving legitimate clients.
//!
//! Usage: `adversary <ip:port> [server_name]`. Exits 0 once all attacks are
//! sent (the server, not this process, is the system under test).

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ClientConfig, Connection, Endpoint};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::time::timeout;

/// wtransport / HTTP-3 ALPN. The addon server only advertises this token, so we
/// must offer it to complete the TLS handshake before abusing the H3 layer.
const ALPN_H3: &[u8] = b"h3";

// HTTP/3 stream and frame type codes (RFC 9114).
const H3_STREAM_CONTROL: u64 = 0x00;
const H3_FRAME_DATA: u64 = 0x00;
const H3_FRAME_HEADERS: u64 = 0x01;
const H3_FRAME_SETTINGS: u64 = 0x04;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut args = std::env::args().skip(1);
    let addr: SocketAddr = args
        .next()
        .unwrap_or_else(|| "127.0.0.1:4433".to_string())
        .parse()
        .expect("adversary: first arg must be <ip:port>");
    let server_name = args.next().unwrap_or_else(|| "localhost".to_string());

    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        // Another init already set the provider; harmless.
    }

    let endpoint = match build_endpoint() {
        Ok(ep) => ep,
        Err(e) => {
            eprintln!("adversary: failed to build endpoint: {e}");
            std::process::exit(2);
        }
    };

    // Attack 1: connection flood — many concurrent handshakes to trip the
    // handshake rate limiter without any well-formed H3 traffic.
    connection_flood(&endpoint, addr, &server_name, 40).await;

    // Attacks 2-6 run over a single "victim" connection that completes the
    // QUIC/TLS handshake but then sends only hostile H3.
    match timeout(
        Duration::from_secs(6),
        endpoint
            .connect_with(client_config(), addr, &server_name)
            .expect("adversary: invalid connect params"),
    )
    .await
    {
        Ok(Ok(conn)) => {
            malformed_h3_uni_streams(&conn).await;
            malformed_h3_request_streams(&conn).await;
            stream_flood(&conn, 400).await;
            datagram_abuse(&conn).await;
            reset_storm(&conn).await;
            // Give the server a beat to process buffered stream/datagram data
            // before we tear the connection down.
            tokio::time::sleep(Duration::from_millis(400)).await;
            conn.close(0u32.into(), b"adversary-done");
        }
        Ok(Err(e)) => eprintln!("adversary: victim connect failed: {e}"),
        Err(_) => eprintln!("adversary: victim connect timed out"),
    }

    // Attack 7: half-open handshakes — connect then immediately abandon.
    half_open_storm(&endpoint, addr, &server_name, 20).await;

    endpoint.wait_idle().await;
    println!("adversary: all attacks sent");
    std::process::exit(0);
}

fn build_endpoint() -> Result<Endpoint, Box<dyn std::error::Error>> {
    let bind: SocketAddr = (Ipv4Addr::UNSPECIFIED, 0).into();
    let mut endpoint = Endpoint::client(bind)?;
    endpoint.set_default_client_config(client_config());
    Ok(endpoint)
}

fn client_config() -> ClientConfig {
    let mut crypto = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
        .with_no_client_auth();
    crypto.alpn_protocols = vec![ALPN_H3.to_vec()];
    let quic = QuicClientConfig::try_from(crypto).expect("adversary: quic client config");
    ClientConfig::new(Arc::new(quic))
}

/// Opens `count` connections as fast as possible, then drops them. Exercises the
/// handshake rate limiter / per-prefix burst caps with non-library traffic.
async fn connection_flood(endpoint: &Endpoint, addr: SocketAddr, name: &str, count: usize) {
    let mut tasks = Vec::with_capacity(count);
    for _ in 0..count {
        let ep = endpoint.clone();
        let name = name.to_string();
        tasks.push(tokio::spawn(async move {
            if let Ok(connecting) = ep.connect_with(client_config(), addr, &name) {
                if let Ok(Ok(conn)) = timeout(Duration::from_secs(3), connecting).await {
                    conn.close(0u32.into(), b"flood");
                }
            }
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
}

/// Malformed HTTP/3 unidirectional (control) streams.
async fn malformed_h3_uni_streams(conn: &Connection) {
    // (a) Control stream announcing a SETTINGS frame with an enormous declared
    // length but a truncated body, then finished — the server must not
    // over-allocate or block forever waiting for the missing bytes.
    let mut a = vec![];
    put_varint(&mut a, H3_STREAM_CONTROL);
    put_varint(&mut a, H3_FRAME_SETTINGS);
    put_varint(&mut a, (1u64 << 30) - 1); // absurd frame length
    a.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
    send_uni(conn, &a).await;

    // (b) Control stream with garbage/reserved SETTINGS identifiers and values.
    let mut b = vec![];
    put_varint(&mut b, H3_STREAM_CONTROL);
    put_varint(&mut b, H3_FRAME_SETTINGS);
    let mut settings = vec![];
    for id in [0x06u64, 0xffff_ffff, 0x21, 0x1f * 0x1f + 0x21] {
        put_varint(&mut settings, id);
        put_varint(&mut settings, u32::MAX as u64);
    }
    put_varint(&mut b, settings.len() as u64);
    b.extend_from_slice(&settings);
    send_uni(conn, &b).await;

    // (c) A SECOND control stream. RFC 9114 makes a duplicate control stream a
    // connection error; the server must reject the connection cleanly.
    let mut c = vec![];
    put_varint(&mut c, H3_STREAM_CONTROL);
    put_varint(&mut c, H3_FRAME_SETTINGS);
    put_varint(&mut c, 0);
    send_uni(conn, &c).await;

    // (d) Unknown/reserved stream type followed by junk (should be ignored).
    let mut d = vec![];
    put_varint(&mut d, 0x1f * 5 + 0x21); // reserved "grease" stream type
    d.extend_from_slice(&garbage(64, 0x1234_5678));
    send_uni(conn, &d).await;

    // (e) Pure garbage — not even a valid stream-type varint prefix in spirit.
    send_uni(conn, &garbage(256, 0x9e37_79b9)).await;
}

/// Malformed HTTP/3 bidirectional (request) streams.
async fn malformed_h3_request_streams(conn: &Connection) {
    // (f) Truncated CONNECT: a HEADERS frame declaring more bytes than are
    // actually sent, then finished.
    let mut f = vec![];
    put_varint(&mut f, H3_FRAME_HEADERS);
    put_varint(&mut f, 1000); // claims 1000 bytes of QPACK
    f.extend_from_slice(&garbage(12, 0xa5a5_a5a5));
    send_bi(conn, &f).await;

    // (g) Reserved/invalid frame type with a huge declared length.
    let mut g = vec![];
    put_varint(&mut g, 0x1f * 3 + 0x21);
    put_varint(&mut g, u32::MAX as u64);
    g.extend_from_slice(&[0x00, 0x01, 0x02, 0x03]);
    send_bi(conn, &g).await;

    // (h) DATA frame before any HEADERS — illegal frame sequencing.
    let mut h = vec![];
    put_varint(&mut h, H3_FRAME_DATA);
    put_varint(&mut h, 8);
    h.extend_from_slice(&garbage(8, 0x0f0f_0f0f));
    send_bi(conn, &h).await;
}

/// Opens far more streams than the app's per-session cap, writing a little junk
/// on each. The server should apply MAX_STREAMS flow control (blocking further
/// opens) rather than accepting unbounded streams — we bound each open so a
/// correctly-defending server ends the flood via backpressure, not a hang.
async fn stream_flood(conn: &Connection, target: usize) {
    let mut opened_uni = 0usize;
    for i in 0..target {
        match timeout(Duration::from_millis(150), conn.open_uni()).await {
            Ok(Ok(mut s)) => {
                let _ = s.write_all(&garbage(16, 0x100 + i as u64)).await;
                let _ = s.finish();
                opened_uni += 1;
            }
            // Backpressure (server enforcing the cap) or error: stop flooding.
            _ => break,
        }
    }
    let mut opened_bi = 0usize;
    for i in 0..target {
        match timeout(Duration::from_millis(150), conn.open_bi()).await {
            Ok(Ok((mut send, _recv))) => {
                let _ = send.write_all(&garbage(16, 0x2000 + i as u64)).await;
                let _ = send.finish();
                opened_bi += 1;
            }
            _ => break,
        }
    }
    eprintln!("adversary: stream_flood opened uni={opened_uni} bi={opened_bi}");
}

/// Floods datagrams: many small garbage ones plus an attempt at an oversized
/// datagram (larger than the app's max_datagram_size). Garbage payloads are not
/// valid WebTransport datagrams, so the server's datagram parser must reject
/// them without dropping the connection.
async fn datagram_abuse(conn: &Connection) {
    let max = conn.max_datagram_size().unwrap_or(1200);
    for i in 0..200u64 {
        let payload = garbage(64, 0xd00d + i);
        let _ = conn.send_datagram(payload.into());
    }
    // Oversized attempt — quinn may reject client-side with TooLarge, which is
    // fine; if it fits the QUIC path it still stresses the app-level size cap.
    let big = garbage(max.saturating_add(512), 0xbeef);
    let _ = conn.send_datagram(big.into());
}

/// Opens bidi streams and resets them immediately with random error codes.
async fn reset_storm(conn: &Connection) {
    for i in 0..30u64 {
        if let Ok(Ok((mut send, _recv))) = timeout(Duration::from_millis(150), conn.open_bi()).await
        {
            let _ = send.write_all(&garbage(8, i)).await;
            let _ = send
                .reset(quinn::VarInt::from_u64(0x1000 + i).unwrap_or(quinn::VarInt::from_u32(1)));
        } else {
            break;
        }
    }
}

/// Connects and immediately abandons the handshake / connection.
async fn half_open_storm(endpoint: &Endpoint, addr: SocketAddr, name: &str, count: usize) {
    for _ in 0..count {
        if let Ok(connecting) = endpoint.connect_with(client_config(), addr, name) {
            // Drop the Connecting future right away — abandons the handshake.
            drop(connecting);
        }
    }
}

async fn send_uni(conn: &Connection, bytes: &[u8]) {
    if let Ok(Ok(mut s)) = timeout(Duration::from_secs(2), conn.open_uni()).await {
        let _ = s.write_all(bytes).await;
        let _ = s.finish();
    }
}

async fn send_bi(conn: &Connection, bytes: &[u8]) {
    if let Ok(Ok((mut send, _recv))) = timeout(Duration::from_secs(2), conn.open_bi()).await {
        let _ = send.write_all(bytes).await;
        let _ = send.finish();
    }
}

/// Minimal QUIC variable-length integer encoder (RFC 9000 §16).
fn put_varint(buf: &mut Vec<u8>, v: u64) {
    if v < 1 << 6 {
        buf.push(v as u8);
    } else if v < 1 << 14 {
        buf.extend_from_slice(&((v as u16) | 0x4000).to_be_bytes());
    } else if v < 1 << 30 {
        buf.extend_from_slice(&((v as u32) | 0x8000_0000).to_be_bytes());
    } else {
        buf.extend_from_slice(&(v | 0xC000_0000_0000_0000).to_be_bytes());
    }
}

/// Deterministic pseudo-random bytes (xorshift) — no `rand` dependency.
fn garbage(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    let mut out = Vec::with_capacity(len);
    for _ in 0..len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.push((state & 0xff) as u8);
    }
    out
}

/// Accepts any server certificate. This client is only ever pointed at a
/// loopback test server; it must complete the handshake to reach the H3 layer.
#[derive(Debug)]
struct SkipServerVerification;

impl ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ED25519,
        ]
    }
}
