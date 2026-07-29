//! Sans-IO TLS session ticket / resumption store for QUIC 0-RTT.
//!
//! Quinn-proto + rustls need a [`ClientSessionStore`] (client tickets) and a
//! [`StoresServerSessions`] (server stateful tickets). This module owns both
//! roles behind one in-memory type so Rust loopback tests can resume with
//! early data today. JS hosts hydrate/dump via opaque vault blobs
//! ([`export_client_tickets`] / [`import_client_tickets`]) — durable IndexedDB
//! serialization of rustls session values remains out of scope.
//!
//! Anti-replay (stateful path): server tickets are single-use via
//! [`StoresServerSessions::take`]. See SECURITY.md § "WASM 0-RTT / early data".

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use rustls::client::ClientSessionStore;
use rustls::pki_types::ServerName;
use rustls::server::StoresServerSessions;
use rustls::{client as rustls_client, NamedGroup};

/// Opaque blob magic for process-local client-ticket vault entries (`WT0T`).
const CLIENT_TICKET_BLOB_MAGIC: &[u8; 4] = b"WT0T";
/// Cryptographically random vault token length (unguessable; not sequential).
const CLIENT_TICKET_TOKEN_LEN: usize = 32;
const CLIENT_TICKET_BLOB_LEN: usize = 4 + CLIENT_TICKET_TOKEN_LEN;
/// Max in-process vault entries; oldest dropped on overflow (SEC-11).
const MAX_CLIENT_TICKET_VAULT_ENTRIES: usize = 64;

/// Bound TLS 1.3 tickets retained per server name (matches rustls handy cache).
const MAX_TLS13_TICKETS_PER_SERVER: usize = 8;

/// Host-facing ticket persistence contract.
///
/// The wasm core never opens storage itself. Rust tests use
/// [`InMemoryTicketStore`]. A JS host can later drive the same semantics by
/// replacing the store (or wrapping callbacks) at endpoint construction.
pub trait TicketStore: ClientSessionStore + StoresServerSessions {}

impl<T> TicketStore for T where T: ClientSessionStore + StoresServerSessions {}

#[derive(Debug)]
struct ClientServerData {
    kx_hint: Option<NamedGroup>,
    tls13: VecDeque<rustls::client::Tls13ClientSessionValue>,
}

impl Default for ClientServerData {
    fn default() -> Self {
        Self {
            kx_hint: None,
            tls13: VecDeque::with_capacity(MAX_TLS13_TICKETS_PER_SERVER),
        }
    }
}

/// In-memory client + server ticket store for tests and default wasm 0-RTT.
#[derive(Debug)]
pub struct InMemoryTicketStore {
    max_servers: usize,
    client: Mutex<HashMap<ServerName<'static>, ClientServerData>>,
    /// Insertion order for crude LRU eviction of client server-name entries.
    client_order: Mutex<VecDeque<ServerName<'static>>>,
    server: Mutex<HashMap<Vec<u8>, Vec<u8>>>,
    server_order: Mutex<VecDeque<Vec<u8>>>,
    max_server_entries: usize,
}

impl InMemoryTicketStore {
    /// `capacity` bounds distinct server names (client) and server session keys.
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            max_servers: capacity,
            client: Mutex::new(HashMap::new()),
            client_order: Mutex::new(VecDeque::new()),
            server: Mutex::new(HashMap::new()),
            server_order: Mutex::new(VecDeque::new()),
            max_server_entries: capacity,
        }
    }

    pub fn client_ticket_count(&self, server_name: &str) -> usize {
        let Ok(name) = ServerName::try_from(server_name.to_string()) else {
            return 0;
        };
        self.client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&name)
            .map(|d| d.tls13.len())
            .unwrap_or(0)
    }

    pub fn server_entry_count(&self) -> usize {
        self.server.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Drain all TLS 1.3 client tickets (+ kx hint) for `server_name` into an
    /// opaque process-local vault blob for JS [`TicketStoreHost`] persistence.
    ///
    /// Full `Tls13ClientSessionValue` serialization is not public in rustls;
    /// the blob is an in-process vault key (not durable across wasm reloads).
    pub fn export_client_tickets(&self, server_name: &str) -> Option<Vec<u8>> {
        let name = ServerName::try_from(server_name.to_string()).ok()?;
        let mut map = self.client.lock().unwrap_or_else(|e| e.into_inner());
        let data = map.remove(&name)?;
        let mut order = self.client_order.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(idx) = order.iter().position(|n| n == &name) {
            order.remove(idx);
        }
        if data.tls13.is_empty() && data.kx_hint.is_none() {
            return None;
        }
        Some(client_ticket_vault_put(ExportedClientTickets {
            server_name: name,
            kx_hint: data.kx_hint,
            tls13: data.tls13.into_iter().collect(),
        }))
    }

    /// Import opaque vault blob tickets into this store (hydrate before connect).
    pub fn import_client_tickets(&self, server_name: &str, blob: &[u8]) -> bool {
        let Ok(expected) = ServerName::try_from(server_name.to_string()) else {
            return false;
        };
        let Some(token) = parse_client_ticket_blob_token(blob) else {
            return false;
        };
        let Some(exported) = client_ticket_vault_take(&token) else {
            return false;
        };
        if exported.server_name != expected {
            // Put back under the same token so the caller's blob stays valid.
            client_ticket_vault_restore(token, exported);
            return false;
        }
        if let Some(group) = exported.kx_hint {
            self.set_kx_hint(exported.server_name.clone(), group);
        }
        for ticket in exported.tls13 {
            self.insert_tls13_ticket(exported.server_name.clone(), ticket);
        }
        true
    }

    fn touch_client_name(order: &mut VecDeque<ServerName<'static>>, name: &ServerName<'static>) {
        if let Some(idx) = order.iter().position(|n| n == name) {
            order.remove(idx);
        }
        order.push_back(name.clone());
    }
}

struct ExportedClientTickets {
    server_name: ServerName<'static>,
    kx_hint: Option<NamedGroup>,
    tls13: Vec<rustls_client::Tls13ClientSessionValue>,
}

struct ClientTicketVault {
    entries: HashMap<[u8; CLIENT_TICKET_TOKEN_LEN], ExportedClientTickets>,
    /// Insertion order for LRU eviction when at capacity.
    order: VecDeque<[u8; CLIENT_TICKET_TOKEN_LEN]>,
}

fn client_ticket_vault() -> &'static Mutex<ClientTicketVault> {
    static VAULT: OnceLock<Mutex<ClientTicketVault>> = OnceLock::new();
    VAULT.get_or_init(|| {
        Mutex::new(ClientTicketVault {
            entries: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

fn encode_client_ticket_blob(token: &[u8; CLIENT_TICKET_TOKEN_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CLIENT_TICKET_BLOB_LEN);
    out.extend_from_slice(CLIENT_TICKET_BLOB_MAGIC);
    out.extend_from_slice(token);
    out
}

fn parse_client_ticket_blob_token(blob: &[u8]) -> Option<[u8; CLIENT_TICKET_TOKEN_LEN]> {
    if blob.len() != CLIENT_TICKET_BLOB_LEN || &blob[..4] != CLIENT_TICKET_BLOB_MAGIC {
        return None;
    }
    let mut token = [0u8; CLIENT_TICKET_TOKEN_LEN];
    token.copy_from_slice(&blob[4..]);
    Some(token)
}

fn random_vault_token() -> [u8; CLIENT_TICKET_TOKEN_LEN] {
    let mut token = [0u8; CLIENT_TICKET_TOKEN_LEN];
    getrandom::getrandom(&mut token).expect("getrandom for ticket vault token");
    token
}

fn client_ticket_vault_put(exported: ExportedClientTickets) -> Vec<u8> {
    let mut vault = client_ticket_vault()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    while vault.entries.len() >= MAX_CLIENT_TICKET_VAULT_ENTRIES {
        if let Some(old) = vault.order.pop_front() {
            vault.entries.remove(&old);
        } else {
            break;
        }
    }
    let mut token = random_vault_token();
    // Extremely unlikely collision; regenerate rather than overwrite.
    while vault.entries.contains_key(&token) {
        token = random_vault_token();
    }
    vault.order.push_back(token);
    vault.entries.insert(token, exported);
    encode_client_ticket_blob(&token)
}

fn client_ticket_vault_restore(
    token: [u8; CLIENT_TICKET_TOKEN_LEN],
    exported: ExportedClientTickets,
) {
    let mut vault = client_ticket_vault()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !vault.entries.contains_key(&token) {
        vault.order.push_back(token);
    }
    vault.entries.insert(token, exported);
    while vault.entries.len() > MAX_CLIENT_TICKET_VAULT_ENTRIES {
        if let Some(old) = vault.order.pop_front() {
            if old != token {
                vault.entries.remove(&old);
            } else {
                vault.order.push_back(old);
                break;
            }
        } else {
            break;
        }
    }
}

fn client_ticket_vault_take(
    token: &[u8; CLIENT_TICKET_TOKEN_LEN],
) -> Option<ExportedClientTickets> {
    let mut vault = client_ticket_vault()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let exported = vault.entries.remove(token)?;
    if let Some(idx) = vault.order.iter().position(|t| t == token) {
        vault.order.remove(idx);
    }
    Some(exported)
}

#[cfg(test)]
fn client_ticket_vault_clear_for_test() {
    let mut vault = client_ticket_vault()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    vault.entries.clear();
    vault.order.clear();
}

#[cfg(test)]
fn client_ticket_vault_len_for_test() -> usize {
    client_ticket_vault()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entries
        .len()
}

impl ClientSessionStore for InMemoryTicketStore {
    fn set_kx_hint(&self, server_name: ServerName<'static>, group: NamedGroup) {
        let mut map = self.client.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.client_order.lock().unwrap_or_else(|e| e.into_inner());
        Self::touch_client_name(&mut order, &server_name);
        map.entry(server_name).or_default().kx_hint = Some(group);
        while map.len() > self.max_servers {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            } else {
                break;
            }
        }
    }

    fn kx_hint(&self, server_name: &ServerName<'_>) -> Option<NamedGroup> {
        self.client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(server_name)
            .and_then(|d| d.kx_hint)
    }

    fn set_tls12_session(
        &self,
        _server_name: ServerName<'static>,
        _value: rustls_client::Tls12ClientSessionValue,
    ) {
        // TLS 1.2 is not enabled in this crate's rustls feature set.
    }

    fn tls12_session(
        &self,
        _server_name: &ServerName<'_>,
    ) -> Option<rustls_client::Tls12ClientSessionValue> {
        None
    }

    fn remove_tls12_session(&self, _server_name: &ServerName<'static>) {}

    fn insert_tls13_ticket(
        &self,
        server_name: ServerName<'static>,
        value: rustls_client::Tls13ClientSessionValue,
    ) {
        let mut map = self.client.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.client_order.lock().unwrap_or_else(|e| e.into_inner());
        Self::touch_client_name(&mut order, &server_name);
        let data = map.entry(server_name).or_default();
        if data.tls13.len() >= MAX_TLS13_TICKETS_PER_SERVER {
            data.tls13.pop_front();
        }
        data.tls13.push_back(value);
        while map.len() > self.max_servers {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            } else {
                break;
            }
        }
    }

    fn take_tls13_ticket(
        &self,
        server_name: &ServerName<'static>,
    ) -> Option<rustls_client::Tls13ClientSessionValue> {
        self.client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(server_name)
            .and_then(|d| d.tls13.pop_back())
    }
}

impl StoresServerSessions for InMemoryTicketStore {
    fn put(&self, key: Vec<u8>, value: Vec<u8>) -> bool {
        let mut map = self.server.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.server_order.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(idx) = order.iter().position(|k| k == &key) {
            order.remove(idx);
        }
        order.push_back(key.clone());
        map.insert(key, value);
        while map.len() > self.max_server_entries {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            } else {
                break;
            }
        }
        true
    }

    fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.server
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
    }

    fn take(&self, key: &[u8]) -> Option<Vec<u8>> {
        let mut map = self.server.lock().unwrap_or_else(|e| e.into_inner());
        let mut order = self.server_order.lock().unwrap_or_else(|e| e.into_inner());
        let value = map.remove(key)?;
        if let Some(idx) = order.iter().position(|k| k.as_slice() == key) {
            order.remove(idx);
        }
        Some(value)
    }

    fn can_cache(&self) -> bool {
        true
    }
}

/// Enable QUIC-compatible early data on a rustls server config.
///
/// Quinn requires `max_early_data_size == u32::MAX` (or 0). Early data with
/// rustls TLS 1.3 also requires a **stateful** session store and a disabled
/// ticketer (`NeverProducesTickets` is the rustls default when `std` is on).
pub fn configure_server_early_data(
    cfg: &mut rustls::ServerConfig,
    enable: bool,
    store: std::sync::Arc<InMemoryTicketStore>,
) {
    if enable {
        cfg.max_early_data_size = u32::MAX;
        cfg.session_storage = store;
    } else {
        cfg.max_early_data_size = 0;
    }
}

/// Enable client 0-RTT offering when a ticket is available in `store`.
///
/// When `enable` is false, early data is not offered; the default rustls
/// resumption policy is left unchanged (tickets may still be cached, but
/// `enable_early_data` stays false so quinn will not send 0-RTT).
pub fn configure_client_early_data(
    cfg: &mut rustls::ClientConfig,
    enable: bool,
    store: std::sync::Arc<InMemoryTicketStore>,
) {
    cfg.enable_early_data = enable;
    if enable {
        cfg.resumption = rustls_client::Resumption::store(store);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use std::collections::HashMap;
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
    use std::sync::Arc;

    use bytes::BytesMut;
    use quinn_proto::{
        ClientConfig, ConnectionHandle, DatagramEvent, Endpoint, EndpointConfig, Event,
        ServerConfig, VarInt,
    };
    use web_time::Instant;

    use super::{configure_client_early_data, configure_server_early_data, InMemoryTicketStore};
    use crate::spike::{client_crypto, server_crypto};

    const SERVER_ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 4433));
    const CLIENT_ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 5544));

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

    struct Pair {
        server_ep: Endpoint,
        client_ep: Endpoint,
        server_conns: HashMap<ConnectionHandle, quinn_proto::Connection>,
        client_conns: HashMap<ConnectionHandle, quinn_proto::Connection>,
        to_server: Vec<Vec<u8>>,
        to_client: Vec<Vec<u8>>,
        client_config: ClientConfig,
        now: Instant,
    }

    impl Pair {
        fn new(
            server_cfg: rustls::ServerConfig,
            client_cfg: rustls::ClientConfig,
        ) -> Result<Self, String> {
            let qcc = quinn_proto::crypto::rustls::QuicClientConfig::try_from(client_cfg)
                .map_err(|e| format!("client quic cfg: {e}"))?;
            Self::new_with_client_config(server_cfg, ClientConfig::new(Arc::new(qcc)))
        }

        fn new_with_client_config(
            server_cfg: rustls::ServerConfig,
            client_config: ClientConfig,
        ) -> Result<Self, String> {
            let qsc = quinn_proto::crypto::rustls::QuicServerConfig::try_from(server_cfg)
                .map_err(|e| format!("server quic cfg: {e}"))?;
            let server_config = ServerConfig::with_crypto(Arc::new(qsc));
            let ep_cfg = Arc::new(EndpointConfig::default());
            Ok(Self {
                server_ep: Endpoint::new(ep_cfg.clone(), Some(Arc::new(server_config)), true, None),
                client_ep: Endpoint::new(ep_cfg, None, true, None),
                server_conns: HashMap::new(),
                client_conns: HashMap::new(),
                to_server: Vec::new(),
                to_client: Vec::new(),
                client_config,
                now: Instant::now(),
            })
        }

        fn begin_connect(&mut self) -> Result<ConnectionHandle, String> {
            let (ch, mut conn) = self
                .client_ep
                .connect(
                    self.now,
                    self.client_config.clone(),
                    SERVER_ADDR,
                    "localhost",
                )
                .map_err(|e| format!("connect: {e}"))?;
            drain_transmits(&mut conn, self.now, &mut self.to_server);
            self.client_conns.insert(ch, conn);
            Ok(ch)
        }

        fn drive_once(&mut self) -> Result<(), String> {
            let inbound = std::mem::take(&mut self.to_server);
            for dgram in inbound {
                let mut resp_buf = Vec::new();
                let data = BytesMut::from(&dgram[..]);
                if let Some(ev) =
                    self.server_ep
                        .handle(self.now, CLIENT_ADDR, None, None, data, &mut resp_buf)
                {
                    match ev {
                        DatagramEvent::NewConnection(incoming) => {
                            let mut accept_buf = Vec::new();
                            match self
                                .server_ep
                                .accept(incoming, self.now, &mut accept_buf, None)
                            {
                                Ok((sch, sconn)) => {
                                    self.server_conns.insert(sch, sconn);
                                }
                                Err(e) => return Err(format!("accept: {}", e.cause)),
                            }
                            if !accept_buf.is_empty() {
                                self.to_client.push(accept_buf);
                            }
                        }
                        DatagramEvent::ConnectionEvent(ch, ce) => {
                            if let Some(conn) = self.server_conns.get_mut(&ch) {
                                conn.handle_event(ce);
                            }
                        }
                        DatagramEvent::Response(_t) => {
                            if !resp_buf.is_empty() {
                                self.to_client.push(resp_buf);
                            }
                        }
                    }
                }
            }

            let inbound = std::mem::take(&mut self.to_client);
            for dgram in inbound {
                let mut resp_buf = Vec::new();
                let data = BytesMut::from(&dgram[..]);
                if let Some(ev) =
                    self.client_ep
                        .handle(self.now, SERVER_ADDR, None, None, data, &mut resp_buf)
                {
                    match ev {
                        DatagramEvent::ConnectionEvent(ch, ce) => {
                            if let Some(conn) = self.client_conns.get_mut(&ch) {
                                conn.handle_event(ce);
                            }
                        }
                        DatagramEvent::Response(_t) => {
                            if !resp_buf.is_empty() {
                                self.to_server.push(resp_buf);
                            }
                        }
                        DatagramEvent::NewConnection(_) => {}
                    }
                }
            }

            for conn in self.server_conns.values_mut() {
                drain_transmits(conn, self.now, &mut self.to_client);
            }
            for conn in self.client_conns.values_mut() {
                drain_transmits(conn, self.now, &mut self.to_server);
            }

            if self.to_server.is_empty() && self.to_client.is_empty() {
                let mut progressed = false;
                for conn in self.server_conns.values_mut() {
                    if conn.poll_timeout().is_some() {
                        conn.handle_timeout(self.now);
                        drain_transmits(conn, self.now, &mut self.to_client);
                        progressed = true;
                    }
                }
                for conn in self.client_conns.values_mut() {
                    if conn.poll_timeout().is_some() {
                        conn.handle_timeout(self.now);
                        drain_transmits(conn, self.now, &mut self.to_server);
                        progressed = true;
                    }
                }
                let _ = progressed;
            }
            Ok(())
        }

        fn drive_until_connected(&mut self, client_ch: ConnectionHandle) -> Result<(), String> {
            let mut client_ok = false;
            let mut server_ok = false;
            for step in 0..400 {
                self.drive_once()?;
                if let Some(conn) = self.client_conns.get_mut(&client_ch) {
                    while let Some(ev) = conn.poll() {
                        if matches!(ev, Event::Connected) {
                            client_ok = true;
                        }
                    }
                    drain_transmits(conn, self.now, &mut self.to_server);
                }
                for conn in self.server_conns.values_mut() {
                    while let Some(ev) = conn.poll() {
                        if matches!(ev, Event::Connected) {
                            server_ok = true;
                        }
                    }
                    drain_transmits(conn, self.now, &mut self.to_client);
                }
                if client_ok && server_ok {
                    // Flush NewSessionTicket / tickets into stores.
                    for _ in 0..64 {
                        self.drive_once()?;
                        if let Some(conn) = self.client_conns.get_mut(&client_ch) {
                            while conn.poll().is_some() {}
                            drain_transmits(conn, self.now, &mut self.to_server);
                        }
                        for conn in self.server_conns.values_mut() {
                            while conn.poll().is_some() {}
                            drain_transmits(conn, self.now, &mut self.to_client);
                        }
                    }
                    return Ok(());
                }
                if step == 399 {
                    return Err(format!(
                        "did not connect: client={client_ok} server={server_ok}"
                    ));
                }
            }
            Ok(())
        }

        fn close_client(&mut self, ch: ConnectionHandle) {
            if let Some(conn) = self.client_conns.get_mut(&ch) {
                conn.close(self.now, VarInt::from_u32(0), bytes::Bytes::new());
            }
            for _ in 0..64 {
                let _ = self.drive_once();
            }
            self.client_conns.clear();
            self.server_conns.clear();
            self.to_server.clear();
            self.to_client.clear();
        }
    }

    fn configs_with_early_data(
        enable: bool,
        alpn: &[&[u8]],
        client_store: Arc<InMemoryTicketStore>,
        server_store: Arc<InMemoryTicketStore>,
    ) -> Result<(rustls::ServerConfig, rustls::ClientConfig), String> {
        let (mut server_cfg, _cert) = server_crypto()?;
        server_cfg.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        configure_server_early_data(&mut server_cfg, enable, server_store);

        let mut client_cfg = client_crypto()?;
        client_cfg.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        configure_client_early_data(&mut client_cfg, enable, client_store);
        Ok((server_cfg, client_cfg))
    }

    #[test]
    fn zero_rtt_resumes_when_tickets_available() {
        let client_store = Arc::new(InMemoryTicketStore::new(64));
        let server_store = Arc::new(InMemoryTicketStore::new(64));
        let (server_cfg, client_cfg) =
            configs_with_early_data(true, &[b"h3"], client_store.clone(), server_store.clone())
                .expect("crypto");
        let mut pair = Pair::new(server_cfg, client_cfg).expect("pair");

        let ch1 = pair.begin_connect().expect("connect1");
        assert!(
            !pair.client_conns[&ch1].has_0rtt(),
            "first connection has no ticket yet"
        );
        pair.drive_until_connected(ch1).expect("handshake1");
        assert!(
            client_store.client_ticket_count("localhost") > 0,
            "server must mint a TLS 1.3 ticket into the client store"
        );
        assert!(
            server_store.server_entry_count() > 0,
            "server stateful session cache must retain resumption state"
        );
        pair.close_client(ch1);

        let ch2 = pair.begin_connect().expect("connect2");
        assert!(
            pair.client_conns[&ch2].has_0rtt(),
            "second connect must offer 0-RTT when tickets exist"
        );
        // Send early application data before the handshake finishes.
        let stream = pair
            .client_conns
            .get_mut(&ch2)
            .unwrap()
            .streams()
            .open(quinn_proto::Dir::Uni)
            .expect("0-rtt open uni");
        pair.client_conns
            .get_mut(&ch2)
            .unwrap()
            .send_stream(stream)
            .write(b"early-hello")
            .expect("0-rtt write");
        pair.drive_until_connected(ch2).expect("handshake2");
        assert!(
            pair.client_conns[&ch2].accepted_0rtt(),
            "server must accept 0-RTT on matching ALPN / transport params"
        );
    }

    #[test]
    fn zero_rtt_rejected_when_server_disables_early_data() {
        let client_store = Arc::new(InMemoryTicketStore::new(64));
        let server_store = Arc::new(InMemoryTicketStore::new(64));

        // Mint tickets with early data enabled on both sides.
        let (server_cfg, client_cfg) =
            configs_with_early_data(true, &[b"h3"], client_store.clone(), server_store.clone())
                .expect("crypto");
        let mut pair = Pair::new(server_cfg, client_cfg).expect("pair");
        let ch1 = pair.begin_connect().expect("connect1");
        pair.drive_until_connected(ch1).expect("handshake1");
        assert!(
            client_store.client_ticket_count("localhost") > 0,
            "expected client tickets after first handshake"
        );
        let client_config = pair.client_config.clone();
        pair.close_client(ch1);

        // Reuse the same client config (ticket store + enable_early_data). Rebuild
        // only the server with early data disabled so 0-RTT is offered then rejected.
        let (mut server_cfg2, _ignored_client) =
            configs_with_early_data(true, &[b"h3"], client_store.clone(), server_store.clone())
                .expect("crypto2");
        configure_server_early_data(&mut server_cfg2, false, server_store);
        let mut pair2 = Pair::new_with_client_config(server_cfg2, client_config).expect("pair2");
        let ch2 = pair2.begin_connect().expect("connect2");
        assert!(
            pair2.client_conns[&ch2].has_0rtt(),
            "client still attempts 0-RTT with cached ticket"
        );
        let stream = pair2
            .client_conns
            .get_mut(&ch2)
            .unwrap()
            .streams()
            .open(quinn_proto::Dir::Uni)
            .expect("open");
        let _ = pair2
            .client_conns
            .get_mut(&ch2)
            .unwrap()
            .send_stream(stream)
            .write(b"early-reject-me");
        pair2.drive_until_connected(ch2).expect("handshake2");
        assert!(
            !pair2.client_conns[&ch2].accepted_0rtt(),
            "server max_early_data_size=0 must reject 0-RTT (fallback to 1-RTT)"
        );
    }

    #[test]
    fn early_data_disabled_skips_0rtt_even_with_shared_store() {
        let store = Arc::new(InMemoryTicketStore::new(16));
        // Establish with early data so tickets exist...
        let (server_on, client_on) =
            configs_with_early_data(true, &[b"h3"], store.clone(), store.clone()).expect("on");
        let mut pair = Pair::new(server_on, client_on).expect("pair");
        let ch1 = pair.begin_connect().expect("c1");
        pair.drive_until_connected(ch1).expect("hs1");
        pair.close_client(ch1);

        // ...then rebuild configs with enable=false but the same ticket store.
        let (server_off, client_off) =
            configs_with_early_data(false, &[b"h3"], store.clone(), store).expect("off");
        let mut pair2 = Pair::new(server_off, client_off).expect("pair2");
        let ch2 = pair2.begin_connect().expect("c2");
        assert!(
            !pair2.client_conns[&ch2].has_0rtt(),
            "enable_early_data=false must not offer 0-RTT"
        );
        pair2.drive_until_connected(ch2).expect("hs2");
        assert!(!pair2.client_conns[&ch2].accepted_0rtt());
    }

    #[test]
    fn export_import_client_tickets_round_trips_across_stores() {
        let client_store = Arc::new(InMemoryTicketStore::new(64));
        let server_store = Arc::new(InMemoryTicketStore::new(64));
        let (server_cfg, client_cfg) =
            configs_with_early_data(true, &[b"h3"], client_store.clone(), server_store.clone())
                .expect("crypto");
        let mut pair = Pair::new(server_cfg, client_cfg).expect("pair");
        let ch1 = pair.begin_connect().expect("connect1");
        pair.drive_until_connected(ch1).expect("handshake1");
        assert!(client_store.client_ticket_count("localhost") > 0);
        pair.close_client(ch1);

        let blob = client_store
            .export_client_tickets("localhost")
            .expect("export");
        assert_eq!(client_store.client_ticket_count("localhost"), 0);

        // Fresh store + ClientConfig sharing the same crypto base would be
        // required for quinn has_0rtt; here we only assert vault hydrate.
        let hydrated = Arc::new(InMemoryTicketStore::new(64));
        assert!(hydrated.import_client_tickets("localhost", &blob));
        assert!(hydrated.client_ticket_count("localhost") > 0);
        assert!(!hydrated.import_client_tickets("localhost", &blob));
    }

    #[test]
    fn vault_blob_rejects_sequential_u64_forge() {
        super::client_ticket_vault_clear_for_test();
        let client_store = Arc::new(InMemoryTicketStore::new(64));
        let server_store = Arc::new(InMemoryTicketStore::new(64));
        let (server_cfg, client_cfg) =
            configs_with_early_data(true, &[b"h3"], client_store.clone(), server_store)
                .expect("crypto");
        let mut pair = Pair::new(server_cfg, client_cfg).expect("pair");
        let ch1 = pair.begin_connect().expect("connect1");
        pair.drive_until_connected(ch1).expect("handshake1");
        pair.close_client(ch1);

        let blob = client_store
            .export_client_tickets("localhost")
            .expect("export");
        assert_eq!(blob.len(), super::CLIENT_TICKET_BLOB_LEN);
        assert_eq!(&blob[..4], super::CLIENT_TICKET_BLOB_MAGIC);

        // Legacy sequential forge: WT0T + u64 LE id — wrong length / not in vault.
        let mut forged = Vec::from(*super::CLIENT_TICKET_BLOB_MAGIC);
        forged.extend_from_slice(&1u64.to_le_bytes());
        let hydrated = Arc::new(InMemoryTicketStore::new(64));
        assert!(!hydrated.import_client_tickets("localhost", &forged));

        // Random token of wrong length rejected.
        assert!(!hydrated.import_client_tickets("localhost", &[0u8; 12]));
        // Correct-length garbage token rejected.
        let mut garbage = Vec::from(*super::CLIENT_TICKET_BLOB_MAGIC);
        garbage.extend_from_slice(&[0xAAu8; super::CLIENT_TICKET_TOKEN_LEN]);
        assert!(!hydrated.import_client_tickets("localhost", &garbage));

        // Real blob still works once.
        assert!(hydrated.import_client_tickets("localhost", &blob));
    }

    #[test]
    fn vault_evicts_oldest_when_at_capacity() {
        super::client_ticket_vault_clear_for_test();
        let mut blobs = Vec::new();
        for i in 0..(super::MAX_CLIENT_TICKET_VAULT_ENTRIES + 2) {
            let name = format!("host{i}.example");
            let blob = super::client_ticket_vault_put(super::ExportedClientTickets {
                server_name: rustls::pki_types::ServerName::try_from(name).expect("name"),
                kx_hint: None,
                tls13: vec![],
            });
            blobs.push(blob);
        }
        assert_eq!(
            super::client_ticket_vault_len_for_test(),
            super::MAX_CLIENT_TICKET_VAULT_ENTRIES
        );
        let probe = Arc::new(InMemoryTicketStore::new(8));
        assert!(
            !probe.import_client_tickets("host0.example", &blobs[0]),
            "oldest vault entry must be gone after overflow"
        );
        assert!(
            !probe.import_client_tickets("host1.example", &blobs[1]),
            "second-oldest must also be gone"
        );
        let newest_name = format!("host{}.example", super::MAX_CLIENT_TICKET_VAULT_ENTRIES + 1);
        assert!(probe.import_client_tickets(&newest_name, blobs.last().unwrap()));
    }
}
