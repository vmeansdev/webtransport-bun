//! Observe a directory's OS identity the same way the comparison-supervisor
//! does during trust bootstrap (`LibcEngine::fstatfs`), and print the
//! camelCase JSON that `required_identity_matches` expects inside an
//! authority root declaration.
//!
//! Usage:
//!   observe-directory-identity <absolute-directory-path>
//!
//! The directory must already exist and should be mode 0700 (not group- or
//! world-writable) so a later bootstrap can accept it.

#[cfg_attr(not(test), allow(dead_code))]
#[path = "../secure_fs.rs"]
mod secure_fs;

use std::io::Write;
use std::os::fd::RawFd;
use std::process::ExitCode;

fn main() -> ExitCode {
    #[cfg(windows)]
    {
        let _ = std::io::stderr()
            .lock()
            .write_all(b"observe-directory-identity: unsupported on Windows\n");
        return ExitCode::from(2);
    }

    #[cfg(not(windows))]
    {
        let mut args = std::env::args().skip(1);
        let Some(path) = args.next() else {
            let _ = std::io::stderr()
                .lock()
                .write_all(b"usage: observe-directory-identity <absolute-directory-path>\n");
            return ExitCode::from(2);
        };
        if args.next().is_some() {
            let _ = std::io::stderr()
                .lock()
                .write_all(b"observe-directory-identity: unexpected extra arguments\n");
            return ExitCode::from(2);
        }

        match observe(&path) {
            Ok(json) => {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(json.as_bytes());
                let _ = out.write_all(b"\n");
                ExitCode::SUCCESS
            }
            Err(message) => {
                let mut err = std::io::stderr().lock();
                let _ = err.write_all(b"observe-directory-identity: ");
                let _ = err.write_all(message.as_bytes());
                let _ = err.write_all(b"\n");
                ExitCode::from(1)
            }
        }
    }
}

#[cfg(not(windows))]
fn observe(path: &str) -> Result<String, String> {
    use secure_fs::{LibcSyscalls, SecureFsSyscalls};

    let c_path = std::ffi::CString::new(path).map_err(|_| "path contains interior NUL")?;
    // SAFETY: open a real directory O_RDONLY|O_DIRECTORY|O_CLOEXEC for fstatfs.
    let fd: RawFd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!("open({path}): {}", std::io::Error::last_os_error()));
    }

    let mut syscalls = LibcSyscalls::new();
    let identity = syscalls
        .engine()
        .fstatfs(fd)
        .map_err(|_| "fstatfs failed".to_string());
    unsafe {
        libc::close(fd);
    }
    let identity = identity?;
    Ok(identity_to_json(&identity))
}

#[cfg(not(windows))]
fn identity_to_json(identity: &secure_fs::DirectoryIdentity) -> String {
    match identity {
        secure_fs::DirectoryIdentity::Macos(mac) => format!(
            concat!(
                "{{",
                "\"platform\":\"darwin\",",
                "\"device\":{},",
                "\"inode\":{},",
                "\"fsidWord0\":{},",
                "\"fsidWord1\":{},",
                "\"fileSystemType\":{},",
                "\"volumeUuid\":{},",
                "\"mountTableEntrySha256\":{},",
                "\"canonicalDescriptorPathSha256\":{},",
                "\"ownerUid\":{},",
                "\"ownerGid\":{},",
                "\"mode\":{},",
                "\"hardLinkCount\":{}",
                "}}"
            ),
            json_string(&mac.device),
            json_string(&mac.inode),
            json_string(&mac.fsid_word0),
            json_string(&mac.fsid_word1),
            json_string(&mac.file_system_type),
            json_string(&mac.volume_uuid),
            json_string(&mac.mount_table_entry_sha256),
            json_string(&mac.canonical_descriptor_path_sha256),
            mac.owner_uid,
            mac.owner_gid,
            mac.mode,
            json_string(&mac.hard_link_count),
        ),
        secure_fs::DirectoryIdentity::Linux(linux) => format!(
            concat!(
                "{{",
                "\"platform\":\"linux\",",
                "\"deviceMajor\":{},",
                "\"deviceMinor\":{},",
                "\"inode\":{},",
                "\"mountId\":{},",
                "\"fileSystemType\":{},",
                "\"fileSystemTypeMagic\":{},",
                "\"fsidWord0\":{},",
                "\"fsidWord1\":{},",
                "\"ownerUid\":{},",
                "\"ownerGid\":{},",
                "\"mode\":{},",
                "\"hardLinkCount\":{}",
                "}}"
            ),
            json_string(&linux.device_major),
            json_string(&linux.device_minor),
            json_string(&linux.inode),
            json_string(&linux.mount_id),
            json_string(&linux.file_system_type),
            json_string(&linux.file_system_type_magic),
            json_string(&linux.fsid_word0),
            json_string(&linux.fsid_word1),
            linux.owner_uid,
            linux.owner_gid,
            linux.mode,
            json_string(&linux.hard_link_count),
        ),
    }
}

#[cfg(not(windows))]
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}
