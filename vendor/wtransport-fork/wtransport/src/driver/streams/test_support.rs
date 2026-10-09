//! Bounded real-QUIC fixtures for stream-owner state replacement tests.
use super::*;
use std::future::Future;
use std::task::Waker;
use wtransport_proto::bytes::AsyncRead;
use wtransport_proto::frame::FrameReader;

pub async fn bounded<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(std::time::Duration::from_secs(5), future)
        .await
        .expect("loopback operation exceeded five seconds")
}

pub async fn pair() -> (
    quinn::Endpoint,
    quinn::Endpoint,
    quinn::Connection,
    quinn::Connection,
) {
    bounded(async {
        let server_config = crate::ServerConfig::builder()
            .with_bind_default(0)
            .with_identity(crate::Identity::self_signed(["localhost"]).unwrap())
            .build();
        let client_config = crate::ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .build();
        let server =
            quinn::Endpoint::server(server_config.quic_config, "127.0.0.1:0".parse().unwrap())
                .unwrap();
        let mut client = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        client.set_default_client_config(client_config.quic_config);
        let (client_connection, server_connection) = tokio::join!(
            client
                .connect(server.local_addr().unwrap(), "localhost")
                .unwrap(),
            async { server.accept().await.unwrap().await }
        );
        (
            server,
            client,
            server_connection.unwrap(),
            client_connection.unwrap(),
        )
    })
    .await
}

/// Seed a cancelled read at an exact consumed prefix, independent of scheduling.
pub fn partial(state: &mut FrameReader, prefix: &[u8]) {
    struct Prefix<'a>(&'a [u8]);
    impl AsyncRead for Prefix<'_> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            out: &mut [u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.0.is_empty() {
                return Poll::Pending;
            }
            let count = out.len().min(self.0.len());
            out[..count].copy_from_slice(&self.0[..count]);
            self.0 = &self.0[count..];
            Poll::Ready(Ok(count))
        }
    }
    let mut input = Prefix(prefix);
    assert!(Box::pin(state.read(&mut input))
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending());
    assert!(input.0.is_empty());
}

pub fn session(send: quinn::SendStream, recv: quinn::RecvStream) -> session::StreamSession {
    Stream {
        stream: (QuicSendStream(send), QuicRecvStream(recv)),
        proto: StreamProto::accept_bi()
            .upgrade()
            .into_session(SessionRequest::new("https://localhost/").unwrap()),
    }
}
