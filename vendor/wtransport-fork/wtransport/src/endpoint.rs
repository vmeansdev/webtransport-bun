use crate::config::ClientConfig;
use crate::config::DnsResolver;
use crate::config::ServerConfig;
use crate::connection::Connection;
use crate::driver::streams::session::StreamSession;
use crate::driver::streams::ProtoReadError;
use crate::driver::streams::ProtoWriteError;
use crate::driver::utils::varint_w2q;
use crate::driver::Driver;
use crate::error::ConnectingError;
use crate::error::ConnectionError;
use crate::zerortt::ZeroRtt;
use crate::SessionId;
use crate::VarInt;
use quinn::TokioRuntime;
use std::collections::HashMap;
use std::future::Future;
use std::future::IntoFuture;
use std::marker::PhantomData;
use std::net::SocketAddr;
use std::net::SocketAddrV4;
use std::net::SocketAddrV6;
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::Context;
use std::task::Poll;
use tracing::debug;
use url::Host;
use url::Url;
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::Frame;
use wtransport_proto::frame::FrameKind;
use wtransport_proto::session::ReservedHeader;
use wtransport_proto::session::SessionRequest as SessionRequestProto;
use wtransport_proto::session::SessionResponse as SessionResponseProto;

/// Helper structure for Endpoint types.
pub mod endpoint_side {
    use super::*;

    /// Type of endpoint accepting multiple WebTransport connections.
    ///
    /// Use [`Endpoint::server`] to create and server-endpoint.
    pub struct Server {
        pub(super) zero_rtt: AtomicBool,
        pub(super) qpack_max_table_capacity: AtomicU64,
        pub(super) _marker: PhantomData<()>,
    }

    /// Type of endpoint opening a WebTransport connection.
    ///
    /// Use [`Endpoint::client`] to create and client-endpoint.
    pub struct Client {
        pub(super) dns_resolver: Arc<dyn DnsResolver + Send + Sync>,
        pub(super) qpack_max_table_capacity: u64,
    }
}

/// Entrypoint for creating client or server connections.
///
/// A single endpoint can be used to accept or connect multiple connections.
/// Each endpoint internally binds an UDP socket.
///
/// # Server
/// Use [`Endpoint::server`] for creating a server-side endpoint.
/// Afterwards use the method [`Endpoint::accept`] for awaiting on incoming session request.
///
/// ```no_run
/// # use anyhow::Result;
/// # use wtransport::ServerConfig;
/// # use wtransport::Identity;
/// use wtransport::Endpoint;
///
/// # async fn run() -> Result<()> {
/// # let config = ServerConfig::builder()
/// #       .with_bind_default(4433)
/// #       .with_identity(Identity::self_signed(["doc"]).unwrap())
/// #       .build();
/// let server = Endpoint::server(config)?;
/// loop {
///     let incoming_session = server.accept().await;
///     // Spawn task that handles client incoming session...
/// }
/// # Ok(())
/// # }
/// ```
///
/// # Client
/// Use [`Endpoint::client`] for creating a client-side endpoint and use [`Endpoint::connect`]
/// to connect to a server specifying the URL.
///
/// ```no_run
/// # use anyhow::Result;
/// use wtransport::ClientConfig;
/// use wtransport::Endpoint;
///
/// # async fn run() -> Result<()> {
/// let connection = Endpoint::client(ClientConfig::default())?
///     .connect("https://localhost:4433")
///     .await?;
/// # Ok(())
/// # }
/// ```
pub struct Endpoint<Side> {
    endpoint: quinn::Endpoint,
    side: Side,
}

impl<Side> Endpoint<Side> {
    /// Closes all of this endpoint's connections immediately and cease accepting new connections.
    pub fn close(&self, error_code: VarInt, reason: &[u8]) {
        self.endpoint.close(varint_w2q(error_code), reason);
    }

    /// Waits for all connections on the endpoint to be cleanly shut down.
    pub async fn wait_idle(&self) {
        self.endpoint.wait_idle().await;
    }

    /// Gets the local [`SocketAddr`] the underlying socket is bound to.
    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.endpoint.local_addr()
    }

    /// Get the number of connections that are currently open.
    pub fn open_connections(&self) -> usize {
        self.endpoint.open_connections()
    }
}

impl Endpoint<endpoint_side::Server> {
    /// Constructs a *server* endpoint.
    pub fn server(server_config: ServerConfig) -> std::io::Result<Self> {
        Self::server_with_runtime(server_config, Arc::new(TokioRuntime))
    }

    /// Constructs a *server* endpoint whose quinn tasks (the endpoint driver and every
    /// connection driver) are spawned through `runtime` instead of the current Tokio
    /// runtime. Lets a caller place the endpoint's receive loop on a dedicated executor.
    pub fn server_with_runtime(
        server_config: ServerConfig,
        runtime: Arc<dyn quinn::Runtime>,
    ) -> std::io::Result<Self> {
        let endpoint_config = server_config.endpoint_config;
        let quic_config = server_config.quic_config;
        let zero_rtt = server_config.zero_rtt;
        let qpack_max_table_capacity = server_config.qpack_max_table_capacity;
        let socket = server_config.bind_address_config.bind_socket()?;

        let endpoint = quinn::Endpoint::new(endpoint_config, Some(quic_config), socket, runtime)?;

        Ok(Self {
            endpoint,
            side: endpoint_side::Server {
                zero_rtt: AtomicBool::new(zero_rtt),
                qpack_max_table_capacity: AtomicU64::new(qpack_max_table_capacity),
                _marker: PhantomData,
            },
        })
    }

    /// Get the next incoming connection attempt from a client.
    pub async fn accept(&self) -> IncomingSession {
        let quic_incoming = self
            .endpoint
            .accept()
            .await
            .expect("Endpoint cannot be closed");

        debug!("New incoming QUIC connection");

        IncomingSession {
            quic_incoming,
            zero_rtt: self.side.zero_rtt.load(Ordering::Relaxed),
            qpack_max_table_capacity: self.side.qpack_max_table_capacity.load(Ordering::Relaxed),
        }
    }

    /// Reloads the server configuration.
    ///
    /// Useful for e.g. refreshing TLS certificates without disrupting existing connections.
    ///
    /// # Arguments
    ///
    /// * `server_config` - The new configuration for the server.
    /// * `rebind` - A boolean indicating whether the server should rebind its socket.
    ///   If `true`, the server will bind to a new socket with the provided configuration.
    ///   If `false`, the bind address configuration will be ignored.
    pub fn reload_config(&self, server_config: ServerConfig, rebind: bool) -> std::io::Result<()> {
        if rebind {
            let socket = server_config.bind_address_config.bind_socket()?;
            self.endpoint.rebind(socket)?;
        }

        let quic_config = server_config.quic_config;
        self.endpoint.set_server_config(Some(quic_config));
        self.side
            .zero_rtt
            .store(server_config.zero_rtt, Ordering::Relaxed);
        self.side
            .qpack_max_table_capacity
            .store(server_config.qpack_max_table_capacity, Ordering::Relaxed);

        Ok(())
    }
}

impl Endpoint<endpoint_side::Client> {
    /// Constructs a *client* endpoint.
    pub fn client(client_config: ClientConfig) -> std::io::Result<Self> {
        let endpoint_config = client_config.endpoint_config;
        let quic_config = client_config.quic_config;
        let socket = client_config.bind_address_config.bind_socket()?;
        let runtime = Arc::new(TokioRuntime);

        let mut endpoint = quinn::Endpoint::new(endpoint_config, None, socket, runtime)?;

        endpoint.set_default_client_config(quic_config);

        Ok(Self {
            endpoint,
            side: endpoint_side::Client {
                dns_resolver: client_config.dns_resolver,
                qpack_max_table_capacity: client_config.qpack_max_table_capacity,
            },
        })
    }

    /// Establishes a WebTransport connection to a specified URL.
    ///
    /// This method initiates a WebTransport connection to the specified URL.
    /// It validates the URL, and performs necessary steps to establish a secure connection.
    ///
    /// # Arguments
    ///
    /// * `options` - Connection options specifying the URL and additional headers.
    ///   It can be simply an [URL](https://en.wikipedia.org/wiki/URL) string representing
    ///   the WebTransport endpoint to connect to. It must have an `https` scheme.
    ///   The URL can specify either an IP address or a hostname.
    ///   When specifying a hostname, the method will internally perform DNS resolution,
    ///   configured with
    ///   [`ClientConfigBuilder::dns_resolver`](crate::config::ClientConfigBuilder::dns_resolver).
    ///
    /// # Examples
    ///
    /// Connect using a URL with a hostname (DNS resolution is performed):
    ///
    /// ```no_run
    /// # use anyhow::Result;
    /// # use wtransport::endpoint::endpoint_side::Client;
    /// # async fn example(endpoint: wtransport::Endpoint<Client>) -> Result<()> {
    /// let url = "https://example.com:4433/webtransport";
    /// let connection = endpoint.connect(url).await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// Connect using a URL with an IP address:
    ///
    /// ```no_run
    /// # use anyhow::Result;
    /// # use wtransport::endpoint::endpoint_side::Client;
    /// # async fn example(endpoint: wtransport::Endpoint<Client>) -> Result<()> {
    /// let url = "https://127.0.0.1:4343/webtransport";
    /// let connection = endpoint.connect(url).await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// Connect adding an additional header:
    ///
    /// ```no_run
    /// # use anyhow::Result;
    /// # use wtransport::endpoint::endpoint_side::Client;
    /// # use wtransport::endpoint::ConnectOptions;
    /// # async fn example(endpoint: wtransport::Endpoint<Client>) -> Result<()> {
    /// let options = ConnectOptions::builder("https://example.com:4433/webtransport")
    ///     .add_header("Authorization", "AuthToken")
    ///     .build();
    /// let connection = endpoint.connect(options).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn connect<O>(&self, options: O) -> Result<Connection, ConnectingError>
    where
        O: IntoConnectOptions,
    {
        self.connect_impl(options.into_options(), false).await
    }

    /// Establishes a WebTransport connection, sending the request as *0-RTT* data.
    ///
    /// Behaves exactly like [`connect`](Self::connect), except that when a previous TLS
    /// session with the server can be resumed the `CONNECT` request travels in the very
    /// first flight, saving a full round trip. When there is nothing to resume — a first
    /// connection, an expired ticket, a restarted server — this transparently falls back
    /// to the ordinary handshake.
    ///
    /// Requires
    /// [`ClientConfigBuilder::enable_0rtt`](crate::config::ClientConfigBuilder::enable_0rtt),
    /// whose documentation also covers what a program must share between configurations
    /// for there to be anything to resume.
    ///
    /// # Replay
    ///
    /// The returned [`Connection`] may be in use before the handshake completes, and
    /// everything sent up to that point is replayable: the server may observe the session
    /// request more than once. Use
    /// [`Connection::handshake_confirmed`](crate::Connection::handshake_confirmed) to wait
    /// for full cryptographic guarantees, and to learn whether the server accepted the
    /// early data at all.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// # use anyhow::Result;
    /// # use wtransport::endpoint::endpoint_side::Client;
    /// # async fn example(endpoint: wtransport::Endpoint<Client>) -> Result<()> {
    /// let connection = endpoint.connect_0rtt("https://example.com:4433/wt").await?;
    ///
    /// if !connection.handshake_confirmed().await {
    ///     // The server declined the early data; the connection completed a full
    ///     // handshake instead and is usable either way.
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn connect_0rtt<O>(&self, options: O) -> Result<Connection, ConnectingError>
    where
        O: IntoConnectOptions,
    {
        self.connect_impl(options.into_options(), true).await
    }

    async fn connect_impl(
        &self,
        options: ConnectOptions,
        zero_rtt: bool,
    ) -> Result<Connection, ConnectingError> {
        let url = Url::parse(&options.url)
            .map_err(|parse_error| ConnectingError::InvalidUrl(parse_error.to_string()))?;

        if url.scheme() != "https" {
            return Err(ConnectingError::InvalidUrl(
                "WebTransport URL scheme must be 'https'".to_string(),
            ));
        }

        let host = url.host().expect("https scheme must have an host");
        let port = url.port().unwrap_or(443);

        let (socket_address, server_name) = match host {
            Host::Domain(domain) => {
                let socket_address = self
                    .side
                    .dns_resolver
                    .resolve(&format!("{domain}:{port}"))
                    .await
                    .map_err(ConnectingError::DnsLookup)?
                    .ok_or(ConnectingError::DnsNotFound)?;

                (socket_address, domain.to_string())
            }
            Host::Ipv4(address) => {
                let socket_address = SocketAddr::V4(SocketAddrV4::new(address, port));
                (socket_address, address.to_string())
            }
            Host::Ipv6(address) => {
                let socket_address = SocketAddr::V6(SocketAddrV6::new(address, port, 0, 0));
                (socket_address, address.to_string())
            }
        };

        let quic_connecting = self
            .endpoint
            .connect(socket_address, &server_name)
            .map_err(ConnectingError::with_connect_error)?;

        let zero_rtt_attempt = if zero_rtt {
            quic_connecting.into_0rtt()
        } else {
            Err(quic_connecting)
        };

        let (quic_connection, zero_rtt) = match zero_rtt_attempt {
            Ok((quic_connection, accepted)) => {
                debug!("Sending session request as 0-RTT data");
                (quic_connection, ZeroRtt::sending(accepted))
            }
            // Nothing to resume: a full handshake, indistinguishable from `connect`.
            Err(quic_connecting) => {
                let quic_connection = quic_connecting.await.map_err(|connection_error| {
                    ConnectingError::ConnectionError(connection_error.into())
                })?;

                (quic_connection, ZeroRtt::Off)
            }
        };

        // One driver for the life of the connection. A second one over the same connection
        // would race this one for the streams the peer opens, so a rejected 0-RTT attempt
        // reuses this driver, which rebuilds the streams it had opened.
        let driver = Driver::init(
            quic_connection.clone(),
            zero_rtt.clone(),
            self.side.qpack_max_table_capacity,
        );

        if zero_rtt.is_early() {
            match session_exchange(&driver, &quic_connection, &url, &options, &zero_rtt).await {
                Ok(session_id) => {
                    return Ok(Connection::new(
                        quic_connection,
                        driver,
                        session_id,
                        zero_rtt,
                    ))
                }
                Err(error) => {
                    // Distinguishing a rejection from a genuine failure means waiting for
                    // the handshake either way, which costs nothing here: the attempt has
                    // already failed.
                    if zero_rtt.accepted().await {
                        return Err(error);
                    }
                }
            }

            // The server declined the early data, so the request never reached its
            // application. The connection itself survived and has now completed a full
            // handshake, so the request goes out again over it — the caller sees an
            // ordinary connection, one round trip later than hoped.
            debug!("0-RTT data rejected: sending the session request again");

            let zero_rtt = ZeroRtt::Rejected;
            let session_id =
                session_exchange(&driver, &quic_connection, &url, &options, &zero_rtt).await?;

            return Ok(Connection::new(
                quic_connection,
                driver,
                session_id,
                zero_rtt,
            ));
        }

        let session_id =
            session_exchange(&driver, &quic_connection, &url, &options, &zero_rtt).await?;

        Ok(Connection::new(
            quic_connection,
            driver,
            session_id,
            zero_rtt,
        ))
    }
}

/// Sends the session request and reads the server's reply, yielding the session's id.
async fn session_exchange(
    driver: &Driver,
    quic_connection: &quinn::Connection,
    url: &Url,
    options: &ConnectOptions,
    zero_rtt: &ZeroRtt,
) -> Result<SessionId, ConnectingError> {
    {
        // A 0-RTT connection sends its request without waiting for the server's SETTINGS;
        // waiting first would give back the round trip 0-RTT just saved. RFC 9114 §7.2.4.2
        // allows this using settings remembered from the resumed session, and wtransport
        // does not act on peer settings at all (see the TODO below), so there is nothing
        // to remember. The settings are still awaited, concurrently with the response.
        let optimistic = zero_rtt.is_early();

        if !optimistic {
            let _settings = driver.accept_settings().await.map_err(|driver_error| {
                ConnectingError::ConnectionError(ConnectionError::with_driver_error(
                    driver_error,
                    quic_connection,
                ))
            })?;

            // TODO(biagio): validate settings
        }

        let mut session_request_proto =
            SessionRequestProto::new(url.as_ref()).expect("Url has been already validate");

        for (k, v) in &options.additional_headers {
            session_request_proto
                .insert(k.clone(), v.clone())
                .map_err(|ReservedHeader| ConnectingError::ReservedHeader(k.clone()))?;
        }

        let mut stream_session = match driver.open_session(session_request_proto).await {
            Ok(stream_session) => stream_session,
            Err(driver_error) => {
                return Err(ConnectingError::ConnectionError(
                    ConnectionError::with_driver_error(driver_error, quic_connection),
                ))
            }
        };

        let session_id = stream_session.session_id();

        // Encoded against the peer's table when it offered one. On the request this is
        // always the static table: the peer's settings have not arrived yet, and nothing
        // it has acknowledged could be referenced this early.
        let request = driver
            .qpack_encoder_state()
            .encode(stream_session.request().headers());

        match stream_session.write_frame(request).await {
            Ok(()) => {}
            Err(ProtoWriteError::Stopped) => {
                return Err(ConnectingError::SessionRejected);
            }
            Err(ProtoWriteError::NotConnected) => {
                return Err(ConnectingError::with_no_connection(quic_connection));
            }
        }

        let read_response = read_session_response(&mut stream_session, quic_connection);

        let frame = if optimistic {
            let await_settings = async {
                driver.accept_settings().await.map_err(|driver_error| {
                    ConnectingError::ConnectionError(ConnectionError::with_driver_error(
                        driver_error,
                        quic_connection,
                    ))
                })?;

                // TODO(biagio): validate settings

                Ok(())
            };

            let (frame, ()) = tokio::try_join!(read_response, await_settings)?;
            frame
        } else {
            read_response.await?
        };

        if !matches!(frame.kind(), FrameKind::Headers) {
            quic_connection.close(varint_w2q(ErrorCode::FrameUnexpected.to_code()), b"");
            return Err(ConnectingError::ConnectionError(
                ConnectionError::local_h3_error(ErrorCode::FrameUnexpected),
            ));
        }

        // The response is decoded against the connection's dynamic table, so a server
        // that took up the offer of one can index into it.
        let headers = match driver
            .qpack_decoder_state()
            .decode(&frame, session_id.into_varint().into_inner())
        {
            Ok(headers) => headers,
            Err(error_code) => {
                quic_connection.close(varint_w2q(error_code.to_code()), b"");
                return Err(ConnectingError::ConnectionError(
                    ConnectionError::local_h3_error(error_code),
                ));
            }
        };

        let Ok(session_response) = SessionResponseProto::try_from(headers) else {
            quic_connection.close(varint_w2q(ErrorCode::Message.to_code()), b"");
            return Err(ConnectingError::ConnectionError(
                ConnectionError::local_h3_error(ErrorCode::Message),
            ));
        };

        if session_response.code().is_successful() {
            match driver.register_session(stream_session).await {
                Ok(()) => {}
                Err(driver_error) => {
                    return Err(ConnectingError::ConnectionError(
                        ConnectionError::with_driver_error(driver_error, quic_connection),
                    ))
                }
            }
        } else {
            return Err(ConnectingError::SessionRejected);
        }

        Ok(session_id)
    }
}

/// Reads the server's reply to a session request, skipping frames meant to be ignored.
async fn read_session_response(
    stream_session: &mut StreamSession,
    quic_connection: &quinn::Connection,
) -> Result<Frame<'static>, ConnectingError> {
    loop {
        let frame = match stream_session.read_frame().await {
            Ok(frame) => frame,
            Err(ProtoReadError::H3(error_code)) => {
                quic_connection.close(varint_w2q(error_code.to_code()), b"");
                return Err(ConnectingError::ConnectionError(
                    ConnectionError::local_h3_error(error_code),
                ));
            }
            Err(ProtoReadError::IO(_io_error)) => {
                return Err(ConnectingError::with_no_connection(quic_connection));
            }
        };

        if !matches!(frame.kind(), FrameKind::Exercise(_)) {
            return Ok(frame);
        }
    }
}

/// Options for establishing a client WebTransport connection.
///
/// Used in [`Endpoint::connect`].
///
/// # Examples
///
/// ```no_run
/// # use anyhow::Result;
/// # use wtransport::endpoint::endpoint_side::Client;
/// # use wtransport::endpoint::ConnectOptions;
/// # async fn example(endpoint: wtransport::Endpoint<Client>) -> Result<()> {
/// let options = ConnectOptions::builder("https://example.com:4433/webtransport")
///     .add_header("Authorization", "AuthToken")
///     .build();
/// let connection = endpoint.connect(options).await?;
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    url: String,
    additional_headers: HashMap<String, String>,
}

impl ConnectOptions {
    /// Creates a new `ConnectOptions` using a builder pattern.
    ///
    /// # Arguments
    ///
    /// * `url` - A [URL](https://en.wikipedia.org/wiki/URL) string representing the WebTransport
    ///   endpoint to connect to. It must have an `https` scheme.
    ///   The URL can specify either an IP address or a hostname.
    ///   When specifying a hostname, the method will internally perform DNS resolution,
    ///   configured with
    ///   [`ClientConfigBuilder::dns_resolver`](crate::config::ClientConfigBuilder::dns_resolver).
    pub fn builder<S>(url: S) -> ConnectRequestBuilder
    where
        S: ToString,
    {
        ConnectRequestBuilder {
            url: url.to_string(),
            additional_headers: Default::default(),
        }
    }

    /// Gets the URL which this will connect to.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Gets the additional headers that will be passed when connecting.
    pub fn additional_headers(&self) -> &HashMap<String, String> {
        &self.additional_headers
    }
}

/// A trait for converting types into `ConnectOptions`.
pub trait IntoConnectOptions {
    /// Perform value-to-value conversion into [`ConnectOptions`].
    fn into_options(self) -> ConnectOptions;
}

/// A builder for [`ConnectOptions`].
///
/// See [`ConnectOptions::builder`].
pub struct ConnectRequestBuilder {
    url: String,
    additional_headers: HashMap<String, String>,
}

impl ConnectRequestBuilder {
    /// Adds a header to the connection options.
    ///
    /// # Examples
    ///
    /// ```rust
    /// use wtransport::endpoint::ConnectOptions;
    ///
    /// let options = ConnectOptions::builder("https://example.com:4433/webtransport")
    ///     .add_header("Authorization", "AuthToken")
    ///     .build();
    /// ```
    pub fn add_header<K, V>(mut self, key: K, value: V) -> Self
    where
        K: ToString,
        V: ToString,
    {
        self.additional_headers
            .insert(key.to_string(), value.to_string());
        self
    }

    /// Constructs the [`ConnectOptions`] from the builder configuration.
    pub fn build(self) -> ConnectOptions {
        ConnectOptions {
            url: self.url,
            additional_headers: self.additional_headers,
        }
    }
}

impl IntoConnectOptions for ConnectRequestBuilder {
    fn into_options(self) -> ConnectOptions {
        self.build()
    }
}

impl IntoConnectOptions for ConnectOptions {
    fn into_options(self) -> ConnectOptions {
        self
    }
}

impl<S> IntoConnectOptions for S
where
    S: ToString,
{
    fn into_options(self) -> ConnectOptions {
        ConnectOptions::builder(self).build()
    }
}

type DynFutureIncomingSession =
    dyn Future<Output = Result<SessionRequest, ConnectionError>> + Send + Sync;

/// [`IntoFuture`] for an in-progress incoming connection attempt.
///
/// Created by [`Endpoint::accept`].
pub struct IncomingSession {
    quic_incoming: quinn::Incoming,
    zero_rtt: bool,
    qpack_max_table_capacity: u64,
}

impl IncomingSession {
    /// The peer's UDP address.
    pub fn remote_address(&self) -> SocketAddr {
        self.quic_incoming.remote_address()
    }

    /// Whether the socket address that is initiating this connection has been validated.
    ///
    /// This means that the sender of the initial packet has proved that they can receive traffic
    /// sent to `self.remote_address()`.
    pub fn remote_address_validated(&self) -> bool {
        self.quic_incoming.remote_address_validated()
    }

    /// Respond with a retry packet, requiring the client to retry with address validation
    ///
    /// # Panics
    ///
    /// If `remote_address_validated()` is true.
    pub fn retry(self) {
        self.quic_incoming
            .retry()
            .expect("remote address already verified");
    }

    /// Reject this incoming connection attempt.
    pub fn refuse(self) {
        self.quic_incoming.refuse();
    }

    /// Ignore this incoming connection attempt, not sending any packet in response.
    pub fn ignore(self) {
        self.quic_incoming.ignore();
    }
}

impl IntoFuture for IncomingSession {
    type IntoFuture = IncomingSessionFuture;
    type Output = Result<SessionRequest, ConnectionError>;

    fn into_future(self) -> Self::IntoFuture {
        IncomingSessionFuture::new(
            self.quic_incoming,
            self.zero_rtt,
            self.qpack_max_table_capacity,
        )
    }
}

/// [`Future`] for an in-progress incoming connection attempt.
///
/// Created by awaiting an [`IncomingSession`]
pub struct IncomingSessionFuture(Pin<Box<DynFutureIncomingSession>>);

impl IncomingSessionFuture {
    /// Creates a future from [`quinn::Incoming`].
    ///
    /// The returned future resolves to a [`SessionRequest`] once the QUIC connection
    /// is established and the WebTransport session has been accepted.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    pub fn with_quic_incoming(quic_incoming: quinn::Incoming) -> Self {
        Self::new(quic_incoming, false, 0)
    }

    /// Creates a future from [`quinn::Incoming`], accepting *0-RTT* data.
    ///
    /// Behaves like [`with_quic_incoming`](Self::with_quic_incoming) except that the
    /// connection is converted with [`quinn::Connecting::into_0rtt`], so a resuming client
    /// may deliver its `CONNECT` request before the handshake completes. This only has an
    /// effect if the QUIC configuration permits early data; see
    /// [`ServerConfigBuilder::enable_0rtt`](crate::config::ServerConfigBuilder::enable_0rtt)
    /// for the replay caveats that come with it.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    pub fn with_quic_incoming_0rtt(quic_incoming: quinn::Incoming) -> Self {
        Self::new(quic_incoming, true, 0)
    }

    /// Creates a future from [`quinn::Connecting`].
    ///
    /// This is useful when a [`quinn::Connecting`] is already available and needs to be
    /// driven to completion to accept an incoming WebTransport session.
    ///
    /// The returned future resolves to a [`SessionRequest`] once the QUIC connection
    /// is established and the WebTransport session has been accepted.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    pub fn with_quic_connecting(quic_connecting: quinn::Connecting) -> Self {
        Self(Box::pin(Self::handshake(quic_connecting, false, 0)))
    }

    /// Creates a future from [`quinn::Connecting`], accepting *0-RTT* data.
    ///
    /// See [`with_quic_incoming_0rtt`](Self::with_quic_incoming_0rtt).
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    pub fn with_quic_connecting_0rtt(quic_connecting: quinn::Connecting) -> Self {
        Self(Box::pin(Self::handshake(quic_connecting, true, 0)))
    }

    fn new(quic_incoming: quinn::Incoming, zero_rtt: bool, qpack_max_table_capacity: u64) -> Self {
        Self(Box::pin(async move {
            let quic_connecting = quic_incoming.accept()?;
            Self::handshake(quic_connecting, zero_rtt, qpack_max_table_capacity).await
        }))
    }

    async fn handshake(
        quic_connecting: quinn::Connecting,
        zero_rtt: bool,
        qpack_max_table_capacity: u64,
    ) -> Result<SessionRequest, ConnectionError> {
        if !zero_rtt {
            return Self::accept(
                quic_connecting.await?,
                ZeroRtt::Off,
                qpack_max_table_capacity,
            )
            .await;
        }

        // Server-side conversion always succeeds, but the fallible signature is part of
        // quinn's contract and falling back costs nothing.
        match quic_connecting.into_0rtt() {
            Ok((quic_connection, accepted)) => {
                debug!("Accepting connection with 0.5-RTT data");
                Self::accept(
                    quic_connection,
                    ZeroRtt::receiving(accepted),
                    qpack_max_table_capacity,
                )
                .await
            }
            Err(quic_connecting) => {
                Self::accept(
                    quic_connecting.await?,
                    ZeroRtt::Off,
                    qpack_max_table_capacity,
                )
                .await
            }
        }
    }

    async fn accept(
        quic_connection: quinn::Connection,
        zero_rtt: ZeroRtt,
        qpack_max_table_capacity: u64,
    ) -> Result<SessionRequest, ConnectionError> {
        let driver = Driver::init(
            quic_connection.clone(),
            zero_rtt.clone(),
            qpack_max_table_capacity,
        );

        let _settings = driver.accept_settings().await.map_err(|driver_error| {
            ConnectionError::with_driver_error(driver_error, &quic_connection)
        })?;

        // TODO(biagio): validate settings

        let stream_session = driver.accept_session().await.map_err(|driver_error| {
            ConnectionError::with_driver_error(driver_error, &quic_connection)
        })?;

        // Sampled here, while the request is fresh: by the time the application inspects
        // the request the handshake may well have completed.
        let is_0rtt = zero_rtt.is_early();

        Ok(SessionRequest::new(
            quic_connection,
            driver,
            stream_session,
            zero_rtt,
            is_0rtt,
        ))
    }
}

impl Future for IncomingSessionFuture {
    type Output = Result<SessionRequest, ConnectionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Future::poll(self.0.as_mut(), cx)
    }
}

/// A incoming client session request.
///
/// Server should use methods [`accept`](Self::accept), [`forbidden`](Self::forbidden),
/// or [`not_found`](Self::not_found) in order to validate or reject the client request.
pub struct SessionRequest {
    quic_connection: quinn::Connection,
    driver: Driver,
    stream_session: StreamSession,
    zero_rtt: ZeroRtt,
    is_0rtt: bool,
}

impl SessionRequest {
    pub(crate) fn new(
        quic_connection: quinn::Connection,
        driver: Driver,
        stream_session: StreamSession,
        zero_rtt: ZeroRtt,
        is_0rtt: bool,
    ) -> Self {
        Self {
            quic_connection,
            driver,
            stream_session,
            zero_rtt,
            is_0rtt,
        }
    }

    /// Whether this request arrived as *0-RTT* data, before the TLS handshake completed.
    ///
    /// A `true` value means the request is **replayable**: an attacker who captured the
    /// client's first flight can deliver it again, and this method will report `true` for
    /// the copy as well. Anything non-idempotent the application does in response — an
    /// authorization side effect, a billing event, a stateful grant — must be deferred
    /// until [`handshake_confirmed`](Self::handshake_confirmed) resolves.
    ///
    /// Always `false` unless the server enabled
    /// [`enable_0rtt`](crate::config::ServerConfigBuilder::enable_0rtt).
    pub fn is_0rtt(&self) -> bool {
        self.is_0rtt
    }

    /// Waits for the TLS handshake to complete.
    ///
    /// Returns immediately when [`is_0rtt`](Self::is_0rtt) is `false`, since in that case
    /// the handshake had already completed before the request was read. Otherwise it
    /// resolves once the client's identity and the connection's full cryptographic
    /// guarantees are established, at which point the request is no longer replayable.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel-safe.
    pub async fn handshake_confirmed(&self) {
        self.zero_rtt.accepted().await;
    }

    /// Returns the peer's UDP address.
    ///
    /// **Note**: as QUIC supports migration, remote address may change
    /// during connection. Furthermore, when IPv6 support is enabled, IPv4
    /// addresses may be mapped to IPv6.
    #[inline(always)]
    pub fn remote_address(&self) -> SocketAddr {
        self.quic_connection.remote_address()
    }

    /// Returns the `:authority` field of the request.
    pub fn authority(&self) -> &str {
        self.stream_session.request().authority()
    }

    /// Returns the `:path` field of the request.
    pub fn path(&self) -> &str {
        self.stream_session.request().path()
    }

    /// Returns the `origin` field of the request if present.
    pub fn origin(&self) -> Option<&str> {
        self.stream_session.request().origin()
    }

    /// Returns the `user-agent` field of the request if present.
    pub fn user_agent(&self) -> Option<&str> {
        self.stream_session.request().user_agent()
    }

    /// Returns all header fields associated with the request.
    pub fn headers(&self) -> &HashMap<String, String> {
        self.stream_session.request().headers().as_ref()
    }

    /// Accepts the client request with headers.
    pub async fn accept_with_headers<I, K, V>(
        self,
        headers: I,
    ) -> Result<Connection, ConnectionError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        self.accept_impl(
            headers
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        )
        .await
    }

    /// Accepts the client request and it establishes the WebTransport session.
    pub async fn accept(self) -> Result<Connection, ConnectionError> {
        self.accept_impl(HashMap::new()).await
    }

    /// Rejects the client request by replying with `403` status code.
    pub async fn forbidden(self) {
        self.reject(SessionResponseProto::forbidden()).await;
    }

    /// Rejects the client request by replying with `404` status code.
    pub async fn not_found(self) {
        self.reject(SessionResponseProto::not_found()).await;
    }

    /// Rejects the client request by replying with `429` status code.
    pub async fn too_many_requests(self) {
        self.reject(SessionResponseProto::too_many_requests()).await;
    }

    async fn accept_impl(
        mut self,
        headers: HashMap<String, String>,
    ) -> Result<Connection, ConnectionError> {
        let mut response = SessionResponseProto::ok();

        for (key, value) in headers {
            response.add(key, value);
        }

        self.send_response(response).await?;

        let session_id = self.stream_session.session_id();

        self.driver
            .register_session(self.stream_session)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })?;

        Ok(Connection::new(
            self.quic_connection,
            self.driver,
            session_id,
            self.zero_rtt,
        ))
    }

    async fn reject(mut self, response: SessionResponseProto) {
        let _ = self.send_response(response).await;
        self.stream_session.finish().await;
    }

    async fn send_response(
        &mut self,
        response: SessionResponseProto,
    ) -> Result<(), ConnectionError> {
        let frame = self.driver.qpack_encoder_state().encode(response.headers());

        match self.stream_session.write_frame(frame).await {
            Ok(()) => Ok(()),
            Err(ProtoWriteError::NotConnected) => {
                Err(ConnectionError::no_connect(&self.quic_connection))
            }
            Err(ProtoWriteError::Stopped) => {
                self.quic_connection
                    .close(varint_w2q(ErrorCode::ClosedCriticalStream.to_code()), b"");

                Err(ConnectionError::local_h3_error(
                    ErrorCode::ClosedCriticalStream,
                ))
            }
        }
    }
}
