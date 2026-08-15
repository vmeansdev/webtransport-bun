//! Reports what quinn-udp actually negotiated on this host: whether the
//! UDP_SEGMENT (GSO) probe succeeded and what receive batching (GRO) is
//! available. quinn silently falls back to one-packet-per-sendmsg when the
//! probe fails, so this is the only direct way to see which world the bench
//! runner is in.

use std::net::UdpSocket;

fn main() {
    let socket = UdpSocket::bind("0.0.0.0:0").expect("bind probe socket");
    let state = quinn_udp::UdpSocketState::new((&socket).into()).expect("init quinn-udp state");

    let gso = state.max_gso_segments();
    let gro = state.gro_segments();

    println!("quinn-udp max_gso_segments = {gso}");
    println!("quinn-udp gro_segments     = {gro}");
    println!(
        "verdict: GSO {}, GRO {}",
        if gso > 1 {
            "ACTIVE"
        } else {
            "INACTIVE (1 packet per sendmsg)"
        },
        if gro > 1 { "ACTIVE" } else { "INACTIVE" },
    );
}
