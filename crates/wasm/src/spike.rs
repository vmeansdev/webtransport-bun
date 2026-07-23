//! Phase-0 go/no-go spike: prove that quinn-proto + rustls(ring) + rcgen
//! compile to wasm32-unknown-unknown AND can complete a QUIC/TLS1.3 handshake
//! driven entirely by an in-memory loopback (no sockets, no tokio).
//!
//! Kept as a regression test of the QUIC core; the crypto helpers are reused by
//! the real endpoint state machine.

use std::sync::Arc;

#[cfg(all(test, not(target_arch = "wasm32")))]
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

#[cfg(all(test, not(target_arch = "wasm32")))]
use quinn_proto::{
    ClientConfig, ConnectionHandle, DatagramEvent, Endpoint, EndpointConfig, Event, ServerConfig,
};
#[cfg(all(test, not(target_arch = "wasm32")))]
use web_time::Instant;

#[cfg(all(test, not(target_arch = "wasm32")))]
const SERVER_ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 4433));
#[cfg(all(test, not(target_arch = "wasm32")))]
const CLIENT_ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 5544));

/// Build a rustls server config from DER cert + PKCS8 key, with the `h3` ALPN.
pub(crate) fn server_config_from_der(
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
) -> Result<rustls::ServerConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(
            vec![rustls::pki_types::CertificateDer::from(cert_der)],
            rustls::pki_types::PrivateKeyDer::try_from(key_der).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    Ok(cfg)
}

/// Generate a self-signed P-256 cert and build the rustls server config.
pub(crate) fn server_crypto() -> Result<(rustls::ServerConfig, Vec<u8>), String> {
    let mut params =
        rcgen::CertificateParams::new(vec!["localhost".to_string()]).map_err(|e| e.to_string())?;
    params.distinguished_name = rcgen::DistinguishedName::new();
    let key =
        rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    let cert_der = cert.der().to_vec();
    let key_der = key.serialize_der();
    let cfg = server_config_from_der(cert_der.clone(), key_der)?;
    Ok((cfg, cert_der))
}

/// Dangerous verifier: accept any cert. Spike only — the real backend pins by hash.
#[derive(Debug)]
pub(crate) struct AcceptAny;

impl rustls::client::danger::ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(crate) fn client_crypto() -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAny))
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    Ok(cfg)
}

/// Route every transmit a connection wants to send into a flat list of payloads.
#[cfg(all(test, not(target_arch = "wasm32")))]
fn drain_transmits(conn: &mut quinn_proto::Connection, now: Instant, out: &mut Vec<Vec<u8>>) {
    let max = conn.current_mtu() as usize;
    loop {
        let mut buf = Vec::with_capacity(max);
        match conn.poll_transmit(now, 1, &mut buf) {
            Some(_t) => out.push(buf),
            None => break,
        }
    }
}

/// Run a full in-memory client<->server QUIC handshake. Returns a status string.
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn run_handshake() -> Result<String, String> {
    let (server_cfg, _cert_der) = server_crypto()?;
    let server_crypto = quinn_proto::crypto::rustls::QuicServerConfig::try_from(server_cfg)
        .map_err(|e| format!("server quic cfg: {e}"))?;
    let server_config = ServerConfig::with_crypto(Arc::new(server_crypto));

    let client_crypto = quinn_proto::crypto::rustls::QuicClientConfig::try_from(client_crypto()?)
        .map_err(|e| format!("client quic cfg: {e}"))?;
    let client_config = ClientConfig::new(Arc::new(client_crypto));

    let ep_cfg = Arc::new(EndpointConfig::default());
    let mut server = Endpoint::new(ep_cfg.clone(), Some(Arc::new(server_config)), true, None);
    let mut client = Endpoint::new(ep_cfg, None, true, None);

    let now = Instant::now();
    let (client_ch, mut client_conn) = client
        .connect(now, client_config, SERVER_ADDR, "localhost")
        .map_err(|e| format!("connect: {e}"))?;

    let mut server_conns: std::collections::HashMap<ConnectionHandle, quinn_proto::Connection> =
        std::collections::HashMap::new();

    let mut to_server: Vec<Vec<u8>> = Vec::new();
    let mut to_client: Vec<Vec<u8>> = Vec::new();

    drain_transmits(&mut client_conn, now, &mut to_server);

    let mut client_connected = false;
    let mut server_connected = false;

    for step in 0..200 {
        let now = Instant::now();

        let inbound = std::mem::take(&mut to_server);
        for dgram in inbound {
            let mut resp_buf = Vec::new();
            let data = bytes::BytesMut::from(&dgram[..]);
            if let Some(ev) = server.handle(now, CLIENT_ADDR, None, None, data, &mut resp_buf) {
                match ev {
                    DatagramEvent::NewConnection(incoming) => {
                        let mut accept_buf = Vec::new();
                        match server.accept(incoming, now, &mut accept_buf, None) {
                            Ok((sch, sconn)) => {
                                server_conns.insert(sch, sconn);
                            }
                            Err(e) => return Err(format!("accept: {}", e.cause)),
                        }
                        if !accept_buf.is_empty() {
                            to_client.push(accept_buf);
                        }
                    }
                    DatagramEvent::ConnectionEvent(ch, ce) => {
                        if let Some(conn) = server_conns.get_mut(&ch) {
                            conn.handle_event(ce);
                        }
                    }
                    DatagramEvent::Response(_t) => {
                        if !resp_buf.is_empty() {
                            to_client.push(resp_buf);
                        }
                    }
                }
            }
        }

        let inbound = std::mem::take(&mut to_client);
        for dgram in inbound {
            let mut resp_buf = Vec::new();
            let data = bytes::BytesMut::from(&dgram[..]);
            if let Some(ev) = client.handle(now, SERVER_ADDR, None, None, data, &mut resp_buf) {
                match ev {
                    DatagramEvent::ConnectionEvent(_ch, ce) => client_conn.handle_event(ce),
                    DatagramEvent::Response(_t) => {
                        if !resp_buf.is_empty() {
                            to_server.push(resp_buf);
                        }
                    }
                    DatagramEvent::NewConnection(_) => {}
                }
            }
        }

        for conn in server_conns.values_mut() {
            while let Some(ev) = conn.poll() {
                if matches!(ev, Event::Connected) {
                    server_connected = true;
                }
            }
            drain_transmits(conn, now, &mut to_client);
        }
        while let Some(ev) = client_conn.poll() {
            if matches!(ev, Event::Connected) {
                client_connected = true;
            }
        }
        drain_transmits(&mut client_conn, now, &mut to_server);

        if client_connected && server_connected {
            return Ok(format!(
                "OK handshake complete in {step} steps; server_conns={}",
                server_conns.len()
            ));
        }

        let _ = client_ch;

        if to_server.is_empty() && to_client.is_empty() {
            let mut progressed = false;
            for conn in server_conns.values_mut() {
                if conn.poll_timeout().is_some() {
                    conn.handle_timeout(Instant::now());
                    drain_transmits(conn, Instant::now(), &mut to_client);
                    progressed = true;
                }
            }
            if client_conn.poll_timeout().is_some() {
                client_conn.handle_timeout(Instant::now());
                drain_transmits(&mut client_conn, Instant::now(), &mut to_server);
                progressed = true;
            }
            if !progressed {
                return Err(format!(
                    "stalled at step {step}: client_connected={client_connected} server_connected={server_connected}"
                ));
            }
        }
    }

    Err(format!(
        "did not converge: client_connected={client_connected} server_connected={server_connected}"
    ))
}
