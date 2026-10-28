//! CID-steered SO_REUSEPORT groups: insert this instance's bound socket into a
//! pinned `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY` and optionally attach the pinned
//! `sk_reuseport` program to the group.
//!
//! This is the third deployment hook (after `reusePort` and `quicLb`): the
//! socket fd never leaves the addon, so without this nothing can wire the
//! kernel's CID steering to it (examples/quic-lb/README.md documents the gap).
//! Everything here is fail-closed on purpose — a steering misconfiguration
//! must fail server startup, never silently fall back to 4-tuple hashing,
//! because a hash-steered group looks healthy while measuring (or serving)
//! the wrong deployment.
//!
//! Kernel semantics this leans on (verified against the bench rig):
//! - the sockarray entry is auto-removed when the socket closes, so rebind
//!   after close needs no explicit delete (a fast close→rebind can race the
//!   removal and see `EEXIST`; callers treat that like `AddrInUse`);
//! - `SO_ATTACH_REUSEPORT_EBPF` stores the program on the *group*, covering
//!   sockets that join later and surviving the attaching socket's death while
//!   any member lives;
//! - attach/insert ordering is therefore free: a lookup miss in the program
//!   falls back to `SK_PASS` (kernel hash) until the slot is populated.

/// One instance's steering wiring, resolved at bind time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReusePortSteering {
    /// Pinned `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY` (bpffs path).
    pub sock_array_pin_path: String,
    /// This instance's slot — by convention equal to the numeric QUIC-LB
    /// server id, and the same value the steering program's
    /// `slot_by_server_id` map resolves to.
    pub key: u32,
    /// Pinned `sk_reuseport` program to attach to the group. Exactly one
    /// instance per group passes this.
    pub attach_prog_pin_path: Option<String>,
}

/// Rejection message for `reusePortSteering` on non-Linux builds.
pub(crate) const STEERING_UNSUPPORTED: &str =
    "reusePortSteering requires Linux (BPF reuseport sockarrays); \
     this platform does not provide them";

pub(crate) const fn steering_supported() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(target_os = "linux")]
mod imp {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

    // bpf(2) command numbers and flags (include/uapi/linux/bpf.h; stable ABI).
    const BPF_MAP_UPDATE_ELEM: libc::c_int = 2;
    const BPF_OBJ_GET: libc::c_int = 7;
    const BPF_NOEXIST: u64 = 1;
    // asm-generic/socket.h; identical across Linux architectures in use here.
    const SO_ATTACH_REUSEPORT_EBPF: libc::c_int = 52;

    #[repr(C)]
    struct BpfObjGetAttr {
        pathname: u64,
        bpf_fd: u32,
        file_flags: u32,
    }

    #[repr(C)]
    struct BpfMapUpdateAttr {
        map_fd: u32,
        _pad: u32,
        key: u64,
        value: u64,
        flags: u64,
    }

    fn bpf_call<T>(cmd: libc::c_int, attr: &mut T) -> std::io::Result<RawFd> {
        // SAFETY: attr is a properly sized repr(C) struct for this command;
        // the kernel reads exactly `size` bytes.
        let ret = unsafe {
            libc::syscall(
                libc::SYS_bpf,
                cmd,
                attr as *mut T as *mut libc::c_void,
                std::mem::size_of::<T>() as u32,
            )
        };
        if ret < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(ret as RawFd)
        }
    }

    fn obj_get(pin_path: &str, what: &str) -> Result<OwnedFd, String> {
        let path = std::ffi::CString::new(pin_path)
            .map_err(|_| format!("steering {what} pin path contains a NUL byte"))?;
        let mut attr = BpfObjGetAttr {
            pathname: path.as_ptr() as u64,
            bpf_fd: 0,
            file_flags: 0,
        };
        match bpf_call(BPF_OBJ_GET, &mut attr) {
            // SAFETY: a successful BPF_OBJ_GET returns a fresh fd we own.
            Ok(fd) => Ok(unsafe { OwnedFd::from_raw_fd(fd) }),
            Err(e) => Err(match e.raw_os_error() {
                Some(libc::ENOENT) => format!(
                    "steering {what} pin not found at '{pin_path}' — \
                     run the steering setup (bpftool loadall/pinmaps) first"
                ),
                Some(libc::EPERM) | Some(libc::EACCES) => format!(
                    "opening steering {what} pin '{pin_path}' requires CAP_BPF \
                     (or root): {e}"
                ),
                _ => format!("failed to open steering {what} pin '{pin_path}': {e}"),
            }),
        }
    }

    pub(super) fn install(
        socket: &std::net::UdpSocket,
        steering: &super::ReusePortSteering,
    ) -> Result<(), String> {
        let map_fd = obj_get(&steering.sock_array_pin_path, "sockarray")?;
        let key: u32 = steering.key;
        let value: u64 = socket.as_raw_fd() as u64;
        let mut attr = BpfMapUpdateAttr {
            map_fd: map_fd.as_raw_fd() as u32,
            _pad: 0,
            key: &key as *const u32 as u64,
            value: &value as *const u64 as u64,
            // NOEXIST, never ANY: ANY would let a mis-keyed instance silently
            // evict a live sibling from its slot, degrading that sibling's
            // flows to hash fallback with no error anywhere.
            flags: BPF_NOEXIST,
        };
        bpf_call(BPF_MAP_UPDATE_ELEM, &mut attr).map_err(|e| match e.raw_os_error() {
            Some(libc::EEXIST) => format!(
                "steering slot {key} is already occupied in '{}' — another \
                 instance holds it, or a just-closed socket's removal is still \
                 in flight (retryable, like AddrInUse)",
                steering.sock_array_pin_path
            ),
            Some(libc::E2BIG) => format!(
                "steering slot {key} is out of range for '{}'",
                steering.sock_array_pin_path
            ),
            _ => format!(
                "failed to insert socket into steering slot {key} of '{}': {e} \
                 (is the pin a BPF_MAP_TYPE_REUSEPORT_SOCKARRAY?)",
                steering.sock_array_pin_path
            ),
        })?;

        if let Some(prog_pin) = &steering.attach_prog_pin_path {
            let prog_fd = obj_get(prog_pin, "program")?;
            let prog_raw: libc::c_int = prog_fd.as_raw_fd();
            // SAFETY: plain setsockopt with an int-sized option value.
            let ret = unsafe {
                libc::setsockopt(
                    socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    SO_ATTACH_REUSEPORT_EBPF,
                    &prog_raw as *const libc::c_int as *const libc::c_void,
                    std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                )
            };
            if ret != 0 {
                let e = std::io::Error::last_os_error();
                return Err(format!(
                    "failed to attach steering program '{prog_pin}' to the \
                     reuseport group: {e} (is the pin an sk_reuseport program?)"
                ));
            }
        }
        Ok(())
    }
}

/// Wires one bound `SO_REUSEPORT` socket into the steering group: inserts it
/// at `key` in the pinned sockarray (`BPF_NOEXIST`) and, when
/// `attach_prog_pin_path` is set, attaches the pinned program to the group.
#[cfg(target_os = "linux")]
pub(crate) fn install(
    socket: &std::net::UdpSocket,
    steering: &ReusePortSteering,
) -> Result<(), String> {
    imp::install(socket, steering)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn install(
    _socket: &std::net::UdpSocket,
    _steering: &ReusePortSteering,
) -> Result<(), String> {
    Err(STEERING_UNSUPPORTED.to_string())
}

/// Parses the `reusePortSteering` option object. `Ok(None)` when absent.
/// Shape errors here; the platform/reusePort/quicLb cross-checks live at the
/// napi layer beside the other bind-option refusals.
pub(crate) fn parse_steering_options(
    opts: &serde_json::Value,
) -> Result<Option<ReusePortSteering>, String> {
    let Some(value) = opts.get("reusePortSteering") else {
        return Ok(None);
    };
    let Some(obj) = value.as_object() else {
        return Err("reusePortSteering must be an object".to_string());
    };
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "sockArrayPinPath" | "key" | "attachProgPinPath"
        ) {
            return Err(format!("reusePortSteering has unknown field '{key}'"));
        }
    }
    let sock_array_pin_path = obj
        .get("sockArrayPinPath")
        .and_then(|v| v.as_str())
        .ok_or("reusePortSteering.sockArrayPinPath must be a string")?;
    if !sock_array_pin_path.starts_with('/') {
        return Err(
            "reusePortSteering.sockArrayPinPath must be an absolute bpffs path".to_string(),
        );
    }
    let key = obj
        .get("key")
        .and_then(|v| v.as_u64())
        .ok_or("reusePortSteering.key must be a non-negative integer")?;
    if key > u32::MAX as u64 {
        return Err("reusePortSteering.key must fit in 32 bits".to_string());
    }
    let attach_prog_pin_path = match obj.get("attachProgPinPath") {
        None => None,
        Some(v) => {
            let path = v
                .as_str()
                .ok_or("reusePortSteering.attachProgPinPath must be a string")?;
            if !path.starts_with('/') {
                return Err(
                    "reusePortSteering.attachProgPinPath must be an absolute bpffs path"
                        .to_string(),
                );
            }
            Some(path.to_string())
        }
    };
    Ok(Some(ReusePortSteering {
        sock_array_pin_path: sock_array_pin_path.to_string(),
        key: key as u32,
        attach_prog_pin_path,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<Option<ReusePortSteering>, String> {
        parse_steering_options(&serde_json::from_str(json).expect("test json"))
    }

    #[test]
    fn absent_option_parses_to_none() {
        assert_eq!(parse("{}"), Ok(None));
    }

    #[test]
    fn full_option_parses() {
        let parsed = parse(
            r#"{"reusePortSteering": {"sockArrayPinPath": "/sys/fs/bpf/g6/socks",
                "key": 3, "attachProgPinPath": "/sys/fs/bpf/g6/steer"}}"#,
        )
        .expect("valid option")
        .expect("present");
        assert_eq!(parsed.key, 3);
        assert_eq!(parsed.sock_array_pin_path, "/sys/fs/bpf/g6/socks");
        assert_eq!(
            parsed.attach_prog_pin_path.as_deref(),
            Some("/sys/fs/bpf/g6/steer")
        );
    }

    #[test]
    fn shape_errors_are_specific() {
        assert!(parse(r#"{"reusePortSteering": 7}"#)
            .unwrap_err()
            .contains("must be an object"));
        assert!(
            parse(r#"{"reusePortSteering": {"key": 0}}"#)
                .unwrap_err()
                .contains("sockArrayPinPath"),
            "missing map pin must be named"
        );
        assert!(
            parse(r#"{"reusePortSteering": {"sockArrayPinPath": "rel/path", "key": 0}}"#)
                .unwrap_err()
                .contains("absolute")
        );
        assert!(
            parse(r#"{"reusePortSteering": {"sockArrayPinPath": "/p", "key": -1}}"#)
                .unwrap_err()
                .contains("non-negative")
        );
        assert!(parse(
            r#"{"reusePortSteering": {"sockArrayPinPath": "/p", "key": 0, "extra": 1}}"#
        )
        .unwrap_err()
        .contains("unknown field 'extra'"));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn install_refuses_off_linux() {
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").expect("socket");
        let steering = ReusePortSteering {
            sock_array_pin_path: "/sys/fs/bpf/never".to_string(),
            key: 0,
            attach_prog_pin_path: None,
        };
        assert_eq!(
            install(&socket, &steering),
            Err(STEERING_UNSUPPORTED.to_string())
        );
    }

    /// Live kernel-facing test, gated: needs CAP_BPF and a Linux kernel, so it
    /// runs on the bench rig (`WEBTRANSPORT_TEST_BPF=1 sudo -E cargo test`),
    /// not in ordinary CI. It exercises the full path: create + pin a real
    /// REUSEPORT_SOCKARRAY, insert a bound reusePort socket, verify NOEXIST
    /// refuses a duplicate slot, and verify a wrong-type pin is refused.
    #[cfg(target_os = "linux")]
    #[test]
    fn live_sockarray_insert_and_noexist_refusal() {
        if std::env::var("WEBTRANSPORT_TEST_BPF").as_deref() != Ok("1") {
            eprintln!("skipping live BPF test (set WEBTRANSPORT_TEST_BPF=1 on a rig with CAP_BPF)");
            return;
        }
        use std::os::fd::AsRawFd;

        #[repr(C)]
        struct BpfMapCreateAttr {
            map_type: u32,
            key_size: u32,
            value_size: u32,
            max_entries: u32,
            map_flags: u32,
        }
        #[repr(C)]
        struct BpfObjPinAttr {
            pathname: u64,
            bpf_fd: u32,
            file_flags: u32,
        }
        const BPF_MAP_CREATE: libc::c_int = 0;
        const BPF_OBJ_PIN: libc::c_int = 6;
        const BPF_MAP_TYPE_REUSEPORT_SOCKARRAY: u32 = 20;

        let mut create = BpfMapCreateAttr {
            map_type: BPF_MAP_TYPE_REUSEPORT_SOCKARRAY,
            key_size: 4,
            value_size: 8,
            max_entries: 4,
            map_flags: 0,
        };
        let map_fd = unsafe {
            libc::syscall(
                libc::SYS_bpf,
                BPF_MAP_CREATE,
                &mut create as *mut _ as *mut libc::c_void,
                std::mem::size_of::<BpfMapCreateAttr>() as u32,
            )
        };
        assert!(
            map_fd >= 0,
            "map create failed: {}",
            std::io::Error::last_os_error()
        );

        let pin_dir = format!("/sys/fs/bpf/wtb-steering-test-{}", std::process::id());
        std::fs::create_dir_all(&pin_dir).expect("bpffs dir");
        let pin_path = format!("{pin_dir}/socks");
        let c_path = std::ffi::CString::new(pin_path.clone()).expect("path");
        let mut pin = BpfObjPinAttr {
            pathname: c_path.as_ptr() as u64,
            bpf_fd: map_fd as u32,
            file_flags: 0,
        };
        let pinned = unsafe {
            libc::syscall(
                libc::SYS_bpf,
                BPF_OBJ_PIN,
                &mut pin as *mut _ as *mut libc::c_void,
                std::mem::size_of::<BpfObjPinAttr>() as u32,
            )
        };
        assert!(
            pinned >= 0,
            "pin failed: {}",
            std::io::Error::last_os_error()
        );

        let socket =
            crate::server_spawn::bind_reuse_port_socket("127.0.0.1:0".parse().expect("addr"))
                .expect("reusePort socket");
        let steering = ReusePortSteering {
            sock_array_pin_path: pin_path.clone(),
            key: 1,
            attach_prog_pin_path: None,
        };
        install(&socket, &steering).expect("first insert lands");

        // Same slot again from a second live socket: BPF_NOEXIST must refuse
        // with the sibling-eviction message, not silently replace.
        let second =
            crate::server_spawn::bind_reuse_port_socket(socket.local_addr().expect("addr"))
                .expect("second reusePort socket");
        let err = install(&second, &steering).expect_err("duplicate slot must refuse");
        assert!(err.contains("already occupied"), "unexpected error: {err}");

        // A pin that is not a sockarray must be refused by the kernel, and the
        // error must name the path.
        let bogus = ReusePortSteering {
            sock_array_pin_path: format!("{pin_dir}/missing"),
            key: 0,
            attach_prog_pin_path: None,
        };
        let err = install(&socket, &bogus).expect_err("missing pin must refuse");
        assert!(err.contains("not found"), "unexpected error: {err}");

        drop(socket);
        drop(second);
        unsafe { libc::close(map_fd as libc::c_int) };
        let _ = std::fs::remove_file(&pin_path);
        let _ = std::fs::remove_dir(&pin_dir);
    }
}
