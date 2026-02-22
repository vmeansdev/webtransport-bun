//! Minimal WebTransport client using wtransport. Connects to addon server,
//! sends datagram and receives echo. Used to isolate browser-specific issues
//! (runs in separate process, no Chromium).

use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| DEFAULT_URL.to_string());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    let exit = rt.block_on(run(&url));
    std::process::exit(exit);
}

async fn run(url: &str) -> i32 {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();

    let endpoint = match Endpoint::client(config) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("smoke-client: endpoint error: {}", e);
            return 1;
        }
    };

    let conn = match endpoint.connect(url).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("smoke-client: connect failed: {}", e);
            return 1;
        }
    };

    // Datagram echo
    let payload = b"smoke-datagram-echo";
    if let Err(e) = conn.send_datagram(payload) {
        eprintln!("smoke-client: send_datagram failed: {}", e);
        return 1;
    }
    match conn.receive_datagram().await {
        Ok(d) => {
            if d.as_ref() != payload {
                eprintln!(
                    "smoke-client: datagram echo mismatch: got {:?}",
                    std::str::from_utf8(d.as_ref()).unwrap_or("")
                );
                return 1;
            }
        }
        Err(e) => {
            eprintln!("smoke-client: receive_datagram failed: {}", e);
            return 1;
        }
    }

    // Bidi stream echo
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(opening) => match opening.await {
            Ok((s, r)) => (s, r),
            Err(e) => {
                eprintln!("smoke-client: open_bi await failed: {}", e);
                return 1;
            }
        },
        Err(e) => {
            eprintln!("smoke-client: open_bi failed: {}", e);
            return 1;
        }
    };
    let msg = b"smoke-bidi-echo";
    send.write_all(msg).await.ok();
    let _ = send.finish().await;
    let mut buf = vec![0u8; 256];
    let n = match recv.read(&mut buf).await {
        Ok(Some(sz)) => sz,
        Ok(None) => 0,
        Err(e) => {
            eprintln!("smoke-client: bidi read failed: {}", e);
            return 1;
        }
    };
    if &buf[..n] != msg {
        eprintln!(
            "smoke-client: bidi echo mismatch: got {:?}",
            std::str::from_utf8(&buf[..n]).unwrap_or("")
        );
        return 1;
    }

    conn.close(0u32.into(), b"done");
    println!("smoke-client: PASS");
    0
}
