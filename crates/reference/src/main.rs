//! Reference WebTransport server using wtransport directly.
//! Used for interop testing and debugging — not part of the production addon.
//! Supports datagrams, bidirectional streams, and unidirectional streams (echo).
//!
//! Starts an HTTP health server on 127.0.0.1:4434 for Playwright readiness probing
//! (QUIC/HTTP3 does not respond to regular HTTP GET).

use std::net::SocketAddr;
use tokio::io::AsyncWriteExt;
use wtransport::Endpoint;
use wtransport::Identity;
use wtransport::ServerConfig;

const HEALTH_PORT: u16 = 4434;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("reference-server: Starting up...");

    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;

    let config = ServerConfig::builder()
        .with_bind_default(4433)
        .with_identity(identity)
        .build();

    let server = Endpoint::server(config)?;
    println!("reference-server: Listening on {}", server.local_addr()?);

    // HTTP health server for Playwright webServer readiness (QUIC doesn't respond to HTTP GET)
    tokio::spawn(async move {
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], HEALTH_PORT)))
                .await
                .expect("bind health port");
        println!(
            "reference-server: Health server on http://127.0.0.1:{}",
            HEALTH_PORT
        );
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => continue,
            };
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            let _ = stream.flush().await;
        }
    });

    loop {
        let incoming = server.accept().await;
        tokio::spawn(async move {
            match incoming.await {
                Ok(session_request) => {
                    println!(
                        "reference-server: Session request from {:?}",
                        session_request.authority()
                    );
                    match session_request.accept().await {
                        Ok(connection) => {
                            println!(
                                "reference-server: Accepted WebTransport session from {:?}",
                                connection.remote_address()
                            );

                            // Spawn tasks for bidi, uni, and datagrams in parallel
                            let conn_bidi = connection.clone();
                            let conn_uni = connection.clone();
                            let conn_dgram = connection.clone();

                            // Bidi stream echo
                            tokio::spawn(async move {
                                if let Ok((mut send, mut recv)) = conn_bidi.accept_bi().await {
                                    let mut buf = vec![0; 1024];
                                    if let Ok(Some(n)) = recv.read(&mut buf).await {
                                        let _ = send.write_all(&buf[..n]).await;
                                    }
                                }
                            });

                            // Uni stream echo (client sends, we read and echo back on new uni stream)
                            tokio::spawn(async move {
                                if let Ok(mut recv) = conn_uni.accept_uni().await {
                                    let mut buf = vec![0; 1024];
                                    if let Ok(Some(n)) = recv.read(&mut buf).await {
                                        if let Ok(opening) = conn_uni.open_uni().await {
                                            if let Ok(mut send) = opening.await {
                                                let _ = send.write_all(&buf[..n]).await;
                                            }
                                        }
                                    }
                                }
                            });

                            // Datagram echo
                            tokio::spawn(async move {
                                if let Ok(dgram) = conn_dgram.receive_datagram().await {
                                    let _ = conn_dgram.send_datagram(dgram.as_ref());
                                }
                            });
                        }
                        Err(err) => {
                            println!("reference-server: Error accepting session: {:?}", err);
                        }
                    }
                }
                Err(err) => {
                    println!("reference-server: Error accepting connection: {:?}", err);
                }
            }
        });
    }
}
