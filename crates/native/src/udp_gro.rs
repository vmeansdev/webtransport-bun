//! Throwaway: turn off UDP_GRO on the listen socket so `sk_drops` is
//! per-datagram. Do not merge. Do not ship as a product knob.

use std::sync::atomic::{AtomicI64, Ordering};

/// -1 unset, 0 requested but not off, 1 confirmed off.
static UDP_GRO_OFF: AtomicI64 = AtomicI64::new(-1);

pub(crate) fn snapshot_udp_gro_off() -> i64 {
    UDP_GRO_OFF.load(Ordering::Relaxed)
}

pub(crate) fn disable_listen_udp_gro(port: u16) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = port;
        UDP_GRO_OFF.store(0, Ordering::Relaxed);
        Err("udp_gro disable requires linux".into())
    }
    #[cfg(target_os = "linux")]
    linux::disable(port)
}

#[cfg(target_os = "linux")]
mod linux {
    use super::UDP_GRO_OFF;
    use std::os::unix::io::RawFd;
    use std::sync::atomic::Ordering;

    const SOL_UDP: libc::c_int = 17;
    const UDP_GRO: libc::c_int = 104;

    pub(super) fn disable(port: u16) -> Result<(), String> {
        let fds = unconn_ipv4_udp_fds(port)?;
        if fds.len() != 1 {
            UDP_GRO_OFF.store(0, Ordering::Relaxed);
            return Err(format!(
                "expected 1 UNCONN IPv4 UDP fd for port {port}, found {}",
                fds.len()
            ));
        }
        let fd = fds[0];
        let off: libc::c_int = 0;
        // SAFETY: fd is a live datagram socket in this process; optval is a c_int we own.
        let rc = unsafe {
            libc::setsockopt(
                fd,
                SOL_UDP,
                UDP_GRO,
                std::ptr::addr_of!(off).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        if rc != 0 {
            UDP_GRO_OFF.store(0, Ordering::Relaxed);
            return Err(format!(
                "setsockopt UDP_GRO=0 failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut got: libc::c_int = 1;
        let mut got_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: fd still live; got is a c_int we own.
        let grc = unsafe {
            libc::getsockopt(
                fd,
                SOL_UDP,
                UDP_GRO,
                std::ptr::addr_of_mut!(got).cast(),
                &mut got_len,
            )
        };
        if grc != 0 || got != 0 {
            UDP_GRO_OFF.store(0, Ordering::Relaxed);
            return Err(format!("UDP_GRO still {got} after disable"));
        }
        UDP_GRO_OFF.store(1, Ordering::Relaxed);
        Ok(())
    }

    fn unconn_ipv4_udp_fds(port: u16) -> Result<Vec<RawFd>, String> {
        let dir =
            std::fs::read_dir("/proc/self/fd").map_err(|e| format!("read /proc/self/fd: {e}"))?;
        let mut fds = Vec::new();
        for entry in dir {
            let entry = entry.map_err(|e| format!("fd dir: {e}"))?;
            let name = entry.file_name();
            let Some(fd) = name.to_str().and_then(|s| s.parse::<RawFd>().ok()) else {
                continue;
            };
            if is_unconn_ipv4_udp(fd, port) {
                fds.push(fd);
            }
        }
        fds.sort_unstable();
        fds.dedup();
        Ok(fds)
    }

    fn is_unconn_ipv4_udp(fd: RawFd, port: u16) -> bool {
        let mut sock_type: libc::c_int = 0;
        let mut type_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: fd from /proc/self/fd; sock_type is a c_int we own.
        let type_rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                std::ptr::addr_of_mut!(sock_type).cast(),
                &mut type_len,
            )
        };
        if type_rc != 0 || sock_type != libc::SOCK_DGRAM {
            return false;
        }
        let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        let mut addr_len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
        // SAFETY: addr is a sockaddr_in we own.
        let name_rc =
            unsafe { libc::getsockname(fd, std::ptr::addr_of_mut!(addr).cast(), &mut addr_len) };
        if name_rc != 0 || i32::from(addr.sin_family) != libc::AF_INET {
            return false;
        }
        if u16::from_be(addr.sin_port) != port {
            return false;
        }
        let mut peer: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        let mut peer_len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
        // SAFETY: peer is a sockaddr_in we own. ENOTCONN means UNCONN listen.
        let peer_rc =
            unsafe { libc::getpeername(fd, std::ptr::addr_of_mut!(peer).cast(), &mut peer_len) };
        peer_rc != 0
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux;
    use std::net::UdpSocket;
    use std::os::fd::AsRawFd;

    const SOL_UDP: libc::c_int = 17;
    const UDP_GRO: libc::c_int = 104;

    fn gro_on(fd: libc::c_int) -> libc::c_int {
        let on: libc::c_int = 1;
        unsafe {
            libc::setsockopt(
                fd,
                SOL_UDP,
                UDP_GRO,
                std::ptr::addr_of!(on).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        let mut got: libc::c_int = -1;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        unsafe {
            libc::getsockopt(
                fd,
                SOL_UDP,
                UDP_GRO,
                std::ptr::addr_of_mut!(got).cast(),
                &mut len,
            );
        }
        got
    }

    #[test]
    fn disables_udp_gro_on_the_unconn_listen_fd() {
        let sock = UdpSocket::bind("127.0.0.1:0").expect("bind");
        let port = sock.local_addr().expect("addr").port();
        let enabled = gro_on(sock.as_raw_fd());
        assert!(
            enabled == 1 || enabled == 0,
            "host must accept UDP_GRO getsockopt, got {enabled}"
        );
        linux::disable(port).expect("disable");
        let mut got: libc::c_int = 1;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        unsafe {
            libc::getsockopt(
                sock.as_raw_fd(),
                SOL_UDP,
                UDP_GRO,
                std::ptr::addr_of_mut!(got).cast(),
                &mut len,
            );
        }
        assert_eq!(got, 0);
        assert_eq!(super::snapshot_udp_gro_off(), 1);
    }
}
