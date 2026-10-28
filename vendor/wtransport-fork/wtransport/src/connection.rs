//! # WebTransport Connection
//!
//! [`Connection`] provides an essential building block for managing WebTransport
//! connections. It allows you to initiate, accept, and control data *streams*, send and receive
//! *datagrams*, monitor connection status, and interact with various aspects of your WebTransport
//! communication.
//!
//! WebTransport exchanges data either via [*streams*](crate#streams) or [*datagrams*](crate#datagrams).
//!
//! ## Streams
//! WebTransport streams provide a lightweight, ordered byte-stream abstraction.
//!
//! There are two fundamental types of streams:
//!  - *Unidirectional* streams carry data in a single direction, from the stream initiator to its peer.
//!  - *Bidirectional* streams allow for data to be sent in both directions.
//!
//! Both server and client endpoints have the capability to create an arbitrary number of streams to
//! operate concurrently.
//!
//! Each stream can be independently cancelled by both side.
//!
//! ### Examples
//! #### Open a stream
//! ```no_run
//! # use anyhow::Result;
//! # async fn foo(connection: wtransport::Connection) -> Result<()> {
//! use wtransport::Connection;
//!
//! // Open a bi-directional stream
//! let (mut send_stream, mut recv_stream) = connection.open_bi().await?.await?;
//!
//! // Send data on the stream
//! send_stream.write_all(b"Hello, wtransport!").await?;
//!
//! // Receive data from the stream
//! let mut buffer = vec![0; 1024];
//! let bytes_read = recv_stream.read(&mut buffer).await?;
//!
//! // Open an uni-directional stream (can only send data)
//! let mut send_stream = connection.open_uni().await?.await?;
//!
//! // Send data on the stream
//! send_stream.write_all(b"Hello, wtransport!").await?;
//! # Ok(())
//! # }
//! ```
//!
//! #### Accept a stream
//! ```no_run
//! # use anyhow::Result;
//! # async fn foo(connection: wtransport::Connection) -> Result<()> {
//! use wtransport::Connection;
//!
//! // Await the peer opens a bi-directional stream
//! let (mut send_stream, mut recv_stream) = connection.accept_bi().await?;
//!
//! // Can send and receive data on peer's stream
//! send_stream.write_all(b"Hello, wtransport!").await?;
//! # let mut buffer = vec![0; 1024];
//! let bytes_read = recv_stream.read(&mut buffer).await?;
//!
//! // Await the peer opens an uni-directional stream (can only receive data)
//! let mut recv_stream = connection.accept_uni().await?;
//!
//! // Receive data on the stream
//! let bytes_read = recv_stream.read(&mut buffer).await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Datagrams
//! WebTransport datagrams are similar to UDP datagrams but come with an
//! added layer of security through *encryption* and *congestion control*.
//! Datagrams can arrive out of order or might not arrive at all, offering
//! flexibility in data exchange scenarios.
//!
//! Unlike streams, which operate as byte-stream abstractions, WebTransport
//! datagrams act more like messages.
//!
//! ### Examples
//! ```no_run
//! # use anyhow::Result;
//! # async fn foo(connection: wtransport::Connection) -> Result<()> {
//! use wtransport::Connection;
//!
//! // Send datagram message
//! connection.send_datagram(b"Hello, wtransport!")?;
//!
//! // Receive a datagram message
//! let message = connection.receive_datagram().await?;
//! # Ok(())
//! # }
//! ```

use crate::datagram::Datagram;
use crate::driver::utils::varint_w2q;
use crate::driver::Driver;
use crate::error::ConnectionError;
use crate::error::ExportKeyingMaterialError;
use crate::error::SendDatagramError;
use crate::stream::OpeningBiStream;
use crate::stream::OpeningUniStream;
use crate::stream::RecvStream;
use crate::stream::SendStream;
use crate::tls::Certificate;
use crate::tls::CertificateChain;
use crate::tls::HandshakeData;
use crate::zerortt::ZeroRtt;
use crate::SessionId;
use crate::VarInt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

/// A WebTransport session connection.
///
/// For more details, see the [module documentation](crate::connection).
///
/// May be cloned to obtain another handle to the same connection.
#[derive(Clone, Debug)]
pub struct Connection {
    quic_connection: quinn::Connection,
    driver: Arc<Driver>,
    session_id: SessionId,
    zero_rtt: ZeroRtt,
}

impl Connection {
    pub(crate) fn new(
        quic_connection: quinn::Connection,
        driver: Driver,
        session_id: SessionId,
        zero_rtt: ZeroRtt,
    ) -> Self {
        Self {
            quic_connection,
            driver: Arc::new(driver),
            session_id,
            zero_rtt,
        }
    }

    /// Waits for the TLS handshake to complete.
    ///
    /// A connection established with *0-RTT* data carries traffic that is not covered by
    /// the full cryptographic guarantees of a completed handshake — on the client side it
    /// is replayable, on the server side it precedes client authentication. This method
    /// resolves once those guarantees are in place, and returns immediately for a
    /// connection that never used early data.
    ///
    /// The returned value reports whether the peer accepted the early data. It is only
    /// meaningful on a client connection that sent some; elsewhere it is always `true`.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel-safe.
    pub async fn handshake_confirmed(&self) -> bool {
        self.zero_rtt.accepted().await
    }

    /// Asynchronously accepts a unidirectional stream.
    ///
    /// This method is used to accept incoming unidirectional streams that have been initiated
    /// by the remote peer.
    /// It waits for the next unidirectional stream to be available, then wraps it in a
    /// [`RecvStream`] that can be used to read data from the stream.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel safe.
    pub async fn accept_uni(&self) -> Result<RecvStream, ConnectionError> {
        let stream = self
            .driver
            .accept_uni(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })?
            .into_stream();

        Ok(RecvStream::new(stream))
    }

    /// Asynchronously accepts a bidirectional stream.
    ///
    /// This method is used to accept incoming bidirectional streams that have been initiated
    /// by the remote peer.
    /// It waits for the next bidirectional stream to be available, then wraps it in a
    /// tuple containing a [`SendStream`] for sending data and a [`RecvStream`] for receiving
    /// data on the stream.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel safe.
    pub async fn accept_bi(&self) -> Result<(SendStream, RecvStream), ConnectionError> {
        let stream = self
            .driver
            .accept_bi(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })?
            .into_stream();

        Ok((SendStream::new(stream.0), RecvStream::new(stream.1)))
    }

    /// Asynchronously opens a new unidirectional stream.
    ///
    /// This method is used to initiate the opening of a new unidirectional stream.
    ///
    /// # Asynchronous Behavior
    ///
    /// This method is asynchronous and involves two `await` points:
    ///
    /// 1. The first `await` occurs during the initial phase of opening the stream, which may involve awaiting
    ///    the flow controller. This wait is necessary to ensure proper resource allocation and flow control.
    ///    It is safe to cancel this `await` point if needed.
    ///
    /// 2. The second `await` is internal to the returned [`OpeningUniStream`] object when it is used to initialize
    ///    the WebTransport stream. Cancelling this latter future before it completes may result in the stream
    ///    being closed during initialization.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// let send_stream = connection.open_uni().await?.await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn open_uni(&self) -> Result<OpeningUniStream, ConnectionError> {
        self.driver
            .open_uni(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Asynchronously opens a new bidirectional stream.
    ///
    /// This method is used to initiate the opening of a new bidirectional stream.
    ///
    /// # Asynchronous Behavior
    ///
    /// This method is asynchronous and involves two `await` points:
    ///
    /// 1. The first `await` occurs during the initial phase of opening the stream, which may involve awaiting
    ///    the flow controller. This wait is necessary to ensure proper resource allocation and flow control.
    ///    It is safe to cancel this `await` point if needed.
    ///
    /// 2. The second `await` is internal to the returned [`OpeningBiStream`] object when it is used to initialize
    ///    the WebTransport stream. Cancelling this latter future before it completes may result in the stream
    ///    being closed during initialization.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// let (send_stream, recv_stream) = connection.open_bi().await?.await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn open_bi(&self) -> Result<OpeningBiStream, ConnectionError> {
        self.driver
            .open_bi(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Asynchronously receives an application datagram from the remote peer.
    ///
    /// This method is used to receive an application datagram sent by the remote
    /// peer over the connection.
    /// It waits for a datagram to become available and returns the received [`Datagram`].
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// let datagram = connection.receive_datagram().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn receive_datagram(&self) -> Result<Datagram, ConnectionError> {
        self.driver
            .receive_datagram(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Sends an application datagram to the remote peer.
    ///
    /// This method is used to send an application datagram to the remote peer
    /// over the connection.
    /// The datagram payload is provided as a reference to a slice of bytes.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// connection.send_datagram(b"Hello, wtransport!")?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn send_datagram<D>(&self, payload: D) -> Result<(), SendDatagramError>
    where
        D: AsRef<[u8]>,
    {
        self.driver.send_datagram(self.session_id, payload.as_ref())
    }

    /// Closes the connection immediately.
    ///
    /// This is a QUIC-level close: the peer learns that the connection is gone, but not
    /// that the WebTransport session ended or why. Use [`Self::close_session`] to end the
    /// session itself.
    pub fn close(&self, error_code: VarInt, reason: &[u8]) {
        self.quic_connection.close(varint_w2q(error_code), reason);
    }

    /// Closes the WebTransport session, telling the peer why.
    ///
    /// The `error_code` and `reason` reach the peer as a `CLOSE_WEBTRANSPORT_SESSION`
    /// capsule on the session's CONNECT stream, which is what a WebTransport peer
    /// surfaces to its application. A reason longer than 1024 bytes is truncated on a
    /// character boundary.
    ///
    /// This returns immediately. Delivery of the capsule is best-effort and happens in
    /// the background; the connection is torn down once the capsule is out, or sooner if
    /// the peer has stopped responding. Wait on [`Self::closed`] to observe the end of
    /// the connection.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # async fn run(connection: Connection) {
    /// connection.close_session(42, "all done");
    /// connection.closed().await;
    /// # }
    /// ```
    pub fn close_session(&self, error_code: u32, reason: &str) {
        self.driver.close_session(error_code, reason);
    }

    /// Tells the peer this session is going away soon.
    ///
    /// The session stays fully usable: streams already open keep working and new ones can
    /// still be opened. This only asks the peer to start winding down, so that the eventual
    /// [`Self::close_session`] does not interrupt anything.
    ///
    /// Returns immediately; the notification is sent in the background.
    pub fn drain_session(&self) {
        self.driver.drain_session();
    }

    /// Tells the peer not to open any further session on this connection.
    ///
    /// The session already running is unaffected. Session requests that arrive afterwards
    /// are refused.
    ///
    /// Returns immediately; the notification is sent in the background.
    pub fn send_goaway(&self) {
        self.driver.send_goaway();
    }

    /// Waits for the peer to say this session is going away.
    ///
    /// Resolves when the peer drains the session or sends `GOAWAY`, and immediately if it
    /// already has. The session remains usable: this is a warning, not an ending. Use
    /// [`Self::closed`] to wait for the end itself.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel safe.
    pub async fn draining(&self) {
        self.driver.draining().await;
    }

    /// The identifier the peer sent with its `GOAWAY`, if it sent one.
    ///
    /// Requests this endpoint opened with a lower identifier are still being handled;
    /// anything at or above it was not processed and is safe to retry elsewhere.
    pub fn peer_goaway_id(&self) -> Option<VarInt> {
        self.driver.peer_goaway_id()
    }

    /// Waits for the connection to be closed for any reason.
    pub async fn closed(&self) -> ConnectionError {
        self.quic_connection.closed().await.into()
    }

    /// Returns the WebTransport session identifier.
    #[inline(always)]
    pub fn session_id(&self) -> SessionId {
        self.session_id
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

    /// A stable identifier for this connection.
    ///
    /// Peer addresses and connection IDs can change, but this value will remain
    /// fixed for the lifetime of the connection.
    #[inline(always)]
    pub fn stable_id(&self) -> usize {
        self.quic_connection.stable_id()
    }

    /// Computes the maximum size of datagrams that may be passed to
    /// [`send_datagram`](Self::send_datagram).
    ///
    /// Returns `None` if datagrams are unsupported by the peer or disabled locally.
    ///
    /// This may change over the lifetime of a connection according to variation in the path MTU
    /// estimate. The peer can also enforce an arbitrarily small fixed limit, but if the peer's
    /// limit is large this is guaranteed to be a little over a kilobyte at minimum.
    ///
    /// Not necessarily the maximum size of received datagrams.
    #[inline(always)]
    pub fn max_datagram_size(&self) -> Option<usize> {
        self.quic_connection
            .max_datagram_size()
            .map(|quic_max_size| quic_max_size - Datagram::header_size(self.session_id))
    }

    /// Current best estimate of this connection's latency (round-trip-time).
    #[inline(always)]
    pub fn rtt(&self) -> Duration {
        self.quic_connection.rtt()
    }

    /// Derive keying material from this connection's TLS session secrets.
    ///
    /// When both peers call this method with the same `label` and `context`
    /// arguments and `output` buffers of equal length, they will get the
    /// same sequence of bytes in `output`. These bytes are cryptographically
    /// strong and pseudorandom, and are suitable for use as keying material.
    ///
    /// See [RFC5705](https://tools.ietf.org/html/rfc5705) for more information.
    pub fn export_keying_material(
        &self,
        output: &mut [u8],
        label: &[u8],
        context: &[u8],
    ) -> Result<(), ExportKeyingMaterialError> {
        self.quic_connection
            .export_keying_material(output, label, context)
            .map_err(|_: quinn::crypto::ExportKeyingMaterialError| ExportKeyingMaterialError)
    }

    /// Returns the peer's identity as a certificate chain if available.
    ///
    /// This function returns an `Option` containing a [`CertificateChain`]. If the peer's identity
    /// is available, it is converted into a `CertificateChain` and returned. If the peer's identity
    /// is not available, `None` is returned.
    pub fn peer_identity(&self) -> Option<CertificateChain> {
        self.quic_connection.peer_identity().map(|any| {
            any.downcast::<Vec<rustls_pki_types::CertificateDer<'static>>>()
                .expect("rustls certificate vector")
                .into_iter()
                .map(Certificate::from_rustls_pki)
                .collect()
        })
    }

    /// Retrieves handshake data associated with the connection.
    pub fn handshake_data(&self) -> HandshakeData {
        let hd = self
            .quic_connection
            .handshake_data()
            .expect("fully established connection")
            .downcast::<quinn::crypto::rustls::HandshakeData>()
            .expect("valid downcast");

        HandshakeData {
            alpn: hd.protocol,
            server_name: hd.server_name,
        }
    }

    /// Returns a reference to the inner QUIC connection.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    #[inline(always)]
    pub fn quic_connection(&self) -> &quinn::Connection {
        &self.quic_connection
    }

    /// Returns a mutable reference to the inner QUIC connection.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    #[inline(always)]
    pub fn quic_connection_mut(&mut self) -> &mut quinn::Connection {
        &mut self.quic_connection
    }
}
