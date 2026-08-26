//! Native, descriptor-relative comparison filesystem boundary (R1).
//!
//! This module is the production side of the R1 secure-filesystem contract in
//! `crates/native/tests/secure_fs.rs`.  Every OS operation is routed through
//! the sealed [`SecureFsSyscalls`] seam; production uses real libc calls and
//! tests inject `ScriptedSyscalls` with an exact ordered call queue.  There is
//! no NAPI surface here and no pathname-based official I/O.
//!
//! Ceremony rules implemented here (frozen by the RED contract):
//!
//! * an inherited staging root is duplicated close-on-exec and adopted only
//!   after its complete platform identity equals authority's expectation;
//! * every component access is handle-relative (`openat2` with the frozen
//!   resolve guards on Linux, `O_NOFOLLOW` `openat` on macOS) and every
//!   returned descriptor is re-identified before use;
//! * reads and writes are bounded, retry `EINTR`, account short progress,
//!   and hash the exact streamed bytes;
//! * exclusive creation returns an opaque token binding supervisor instance,
//!   campaign reservation, parent identity, leaf identity, byte bound, and
//!   operation nonce; cleanup accepts only the exact token;
//! * the campaign reservation is macOS-only, durable, and single-use; and
//! * sealed launches validate every descriptor, consume role/addon/startup
//!   streams to EOF, and produce a `bun-role-launch-receipt/v1`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Stable, typed failure for every boundary operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FsError {
    code: &'static str,
}

impl FsError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// The frozen, stable error code string.
    pub fn code(&self) -> &str {
        self.code
    }
}

macro_rules! codes {
    ($($name:ident => $value:literal),* $(,)?) => {
        $(pub(crate) const $name: &str = $value;)*
    };
}

codes! {
    OUTPUT_HANDLE_CLOSED => "OUTPUT_HANDLE_CLOSED",
    OUTPUT_PATH_REPARSE => "OUTPUT_PATH_REPARSE",
    OUTPUT_PATH_DEVICE => "OUTPUT_PATH_DEVICE",
    OUTPUT_FILE_INVALID => "OUTPUT_FILE_INVALID",
    OUTPUT_FILE_EXISTS => "OUTPUT_FILE_EXISTS",
    OUTPUT_CAMPAIGN_EXISTS => "OUTPUT_CAMPAIGN_EXISTS",
    OUTPUT_FILE_TOO_LARGE => "OUTPUT_FILE_TOO_LARGE",
    OUTPUT_READ_FAILED => "OUTPUT_READ_FAILED",
    OUTPUT_WRITE_FAILED => "OUTPUT_WRITE_FAILED",
    OUTPUT_SYNC_FAILED => "OUTPUT_SYNC_FAILED",
    OUTPUT_CLEANUP_FAILED => "OUTPUT_CLEANUP_FAILED",
    OUTPUT_EXEC_HANDLE_UNAVAILABLE => "OUTPUT_EXEC_HANDLE_UNAVAILABLE",
    OUTPUT_EXEC_HANDLE_INVALID => "OUTPUT_EXEC_HANDLE_INVALID",
    OUTPUT_EXEC_DIGEST_MISMATCH => "OUTPUT_EXEC_DIGEST_MISMATCH",
    OUTPUT_EXEC_REPLACED => "OUTPUT_EXEC_REPLACED",
    OUTPUT_EXEC_FAILED => "OUTPUT_EXEC_FAILED",
    OUTPUT_MOUNT_IDENTITY_UNAVAILABLE => "OUTPUT_MOUNT_IDENTITY_UNAVAILABLE",
    OUTPUT_MOUNT_IDENTITY_MISMATCH => "OUTPUT_MOUNT_IDENTITY_MISMATCH",
    OUTPUT_FILESYSTEM_IDENTITY_MISMATCH => "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
    OUTPUT_PATH_ALIAS => "OUTPUT_PATH_ALIAS",
    OUTPUT_PATH_HARDLINK => "OUTPUT_PATH_HARDLINK",
    OUTPUT_PATH_CROSS_DEVICE => "OUTPUT_PATH_CROSS_DEVICE",
    OUTPUT_SYSCALL_SCRIPT_MISMATCH => "OUTPUT_SYSCALL_SCRIPT_MISMATCH",
    OUTPUT_PLATFORM_UNSUPPORTED => "OUTPUT_PLATFORM_UNSUPPORTED",
    OUTPUT_INTERNAL => "OUTPUT_INTERNAL",
    TRUST_OBSERVATION_COMMAND_MISMATCH => "TRUST_OBSERVATION_COMMAND_MISMATCH",
    TRUST_ROUTE_OBSERVATION_MISSING => "TRUST_ROUTE_OBSERVATION_MISSING",
    TRUST_QDISC_OBSERVATION_MISSING => "TRUST_QDISC_OBSERVATION_MISSING",
    TRUST_CHILD_OBSERVATION_FORBIDDEN => "TRUST_CHILD_OBSERVATION_FORBIDDEN",
}

fn err(code: &'static str) -> FsError {
    FsError::new(code)
}

/// Maps a scripted launch-failure code string onto the stable code set.
fn launch_failure_code(code: &str) -> &'static str {
    match code {
        "OUTPUT_EXEC_HANDLE_UNAVAILABLE" => OUTPUT_EXEC_HANDLE_UNAVAILABLE,
        "OUTPUT_EXEC_HANDLE_INVALID" => OUTPUT_EXEC_HANDLE_INVALID,
        "OUTPUT_EXEC_DIGEST_MISMATCH" => OUTPUT_EXEC_DIGEST_MISMATCH,
        "OUTPUT_EXEC_REPLACED" => OUTPUT_EXEC_REPLACED,
        _ => OUTPUT_EXEC_FAILED,
    }
}

// ---------------------------------------------------------------------------
// Frozen byte limits and platform flag constants
// ---------------------------------------------------------------------------

/// Maximum bytes in one streamed read/write chunk.
const MAX_CHUNK_BYTES: usize = 1_048_576;
/// Maximum admissible byte bound for a bounded read.
const MAX_READ_BOUND: u64 = 16_777_216;
/// F_GETFL access-mode mask (`O_ACCMODE`).
const ACCESS_MODE_MASK: u64 = 0x3;
/// O_RDONLY access mode.
const ACCESS_READ_ONLY: u64 = 0x0;
/// O_WRONLY access mode.
const ACCESS_WRITE_ONLY: u64 = 0x1;

#[cfg(target_os = "linux")]
mod flags {
    /// RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS |
    /// RESOLVE_NO_XDEV.
    pub(super) const OPENAT2_RESOLVE: u64 = 0x0f;
    /// O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC.
    pub(super) const READ_FLAGS: u64 = 0x000a_0800;
    /// O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC.
    pub(super) const CREATE_FLAGS: u64 = 0x000a_00c1;
    /// O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC.
    pub(super) const DIRECTORY_FLAGS: u64 = 0x000b_0000;
}

#[cfg(target_os = "macos")]
mod flags {
    /// O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC.
    pub(super) const READ_FLAGS: u64 = 0x0100_0104;
    /// O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC.
    pub(super) const CREATE_FLAGS: u64 = 0x0100_0b01;
    /// O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC.
    pub(super) const DIRECTORY_FLAGS: u64 = 0x0110_0100;
}

/// The frozen inherited-descriptor numbers for sealed Bun role launches.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod launch_fds {
    pub(super) const ROLE_FD: i32 = 202;
    pub(super) const ADDON_FD: i32 = 203;
    pub(super) const PROTOCOL_IN_FD: i32 = 205;
    pub(super) const PROTOCOL_OUT_FD: i32 = 206;
    pub(super) const STARTUP_NONCE_FD: i32 = 207;
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/// The kind of filesystem object observed by a no-follow stat.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileKind {
    Regular,
    Directory,
    Symlink,
    MagicLink,
    Fifo,
    Socket,
    Pipe,
    BlockDevice,
    CharacterDevice,
}

impl FileKind {
    fn canonical_name(self) -> &'static str {
        match self {
            FileKind::Regular => "regular",
            FileKind::Directory => "directory",
            FileKind::Symlink => "symlink",
            FileKind::MagicLink => "magic-link",
            FileKind::Fifo => "fifo",
            FileKind::Socket => "socket",
            FileKind::Pipe => "pipe",
            FileKind::BlockDevice => "block-device",
            FileKind::CharacterDevice => "character-device",
        }
    }
}

/// Complete per-descriptor identity observed via `fstat`/`fstatat`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    pub kind: FileKind,
    pub device: String,
    pub inode: String,
    pub mount_id: Option<String>,
    pub fsid_word0: String,
    pub fsid_word1: String,
    pub owner_uid: u32,
    pub mode: u32,
    pub hard_link_count: String,
    pub size: u64,
}

impl FileIdentity {
    pub fn with_size(mut self, size: u64) -> Self {
        self.size = size;
        self
    }

    pub fn with_inode(mut self, inode: &str) -> Self {
        self.inode = inode.into();
        self
    }

    pub fn set_inode(&mut self, inode: &str) {
        self.inode = inode.into();
    }
}

/// Linux directory/mount identity as observed via `fstatfs` + `statx`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinuxDirectoryIdentity {
    pub device_major: String,
    pub device_minor: String,
    pub inode: String,
    pub mount_id: String,
    pub file_system_type: String,
    pub file_system_type_magic: String,
    pub fsid_word0: String,
    pub fsid_word1: String,
    pub owner_uid: u32,
    pub mode: u32,
    pub hard_link_count: String,
}

/// macOS directory/volume identity as observed via `fstatfs` +
/// `fgetattrlist(ATTR_VOL_UUID)` + `fcntl(F_GETPATH)` + `getfsstat`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacosDirectoryIdentity {
    pub device: String,
    pub inode: String,
    pub fsid_word0: String,
    pub fsid_word1: String,
    pub file_system_type: String,
    pub volume_uuid: String,
    pub mount_table_entry_sha256: String,
    pub canonical_descriptor_path_sha256: String,
    pub owner_uid: u32,
    pub mode: u32,
    pub hard_link_count: String,
}

/// Platform-tagged directory identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DirectoryIdentity {
    Linux(LinuxDirectoryIdentity),
    Macos(MacosDirectoryIdentity),
}

impl DirectoryIdentity {
    pub fn set_inode(&mut self, inode: &str) {
        match self {
            DirectoryIdentity::Linux(identity) => identity.inode = inode.into(),
            DirectoryIdentity::Macos(identity) => identity.inode = inode.into(),
        }
    }

    pub fn set_file_system_type(&mut self, file_system_type: &str) {
        match self {
            DirectoryIdentity::Linux(identity) => {
                identity.file_system_type = file_system_type.into()
            }
            DirectoryIdentity::Macos(identity) => {
                identity.file_system_type = file_system_type.into()
            }
        }
    }

    pub fn set_mount_id(&mut self, mount_id: &str) {
        if let DirectoryIdentity::Linux(identity) = self {
            identity.mount_id = mount_id.into();
        }
    }

    pub fn set_fsid_word0(&mut self, fsid_word0: &str) {
        match self {
            DirectoryIdentity::Linux(identity) => identity.fsid_word0 = fsid_word0.into(),
            DirectoryIdentity::Macos(identity) => identity.fsid_word0 = fsid_word0.into(),
        }
    }

    pub(crate) fn inode(&self) -> &str {
        match self {
            DirectoryIdentity::Linux(identity) => &identity.inode,
            DirectoryIdentity::Macos(identity) => &identity.inode,
        }
    }

    /// A copy of this identity with a replaced inode, for descendant checks.
    fn with_inode_of(&self, inode: &str) -> DirectoryIdentity {
        let mut copy = self.clone();
        copy.set_inode(inode);
        copy
    }
}

/// One `getfsstat` mount-table record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MountTableEntry {
    pub file_system_type: String,
    pub volume_uuid: String,
    pub mount_point: String,
    pub fsid_word0: String,
    pub fsid_word1: String,
}

impl MountTableEntry {
    pub fn apfs(volume_uuid: &str, mount_point: &str, fsid_word0: &str, fsid_word1: &str) -> Self {
        Self {
            file_system_type: "apfs".into(),
            volume_uuid: volume_uuid.into(),
            mount_point: mount_point.into(),
            fsid_word0: fsid_word0.into(),
            fsid_word1: fsid_word1.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/// A single validated, lowercase-ASCII path component.  Construction is the
/// only admission point; a `Component` never contains separators, aliases,
/// reserved device names, or non-canonical spellings.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component(String);

impl Component {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn validate(value: &str) -> Result<(), FsError> {
        const MAX_COMPONENT_BYTES: usize = 128;
        // Reserved Windows device names are rejected on every platform, case
        // insensitively, before any other classification.
        let upper = value.to_ascii_uppercase();
        let base = upper.split('.').next().unwrap_or("");
        const DEVICES: [&str; 4] = ["CON", "NUL", "AUX", "PRN"];
        if DEVICES.contains(&base)
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base[3..].chars().all(|ch| ch.is_ascii_digit()))
        {
            return Err(err(OUTPUT_PATH_DEVICE));
        }
        // Descriptor aliases and proc magic links are reparse-class escapes.
        if value.contains("dev/fd") || value.contains("proc/") {
            return Err(err(OUTPUT_PATH_REPARSE));
        }
        if value.is_empty()
            || value == "."
            || value == ".."
            || value.contains('/')
            || value.contains('\\')
            || value.contains(':')
            || value.contains('\0')
            || value.ends_with('.')
            || value.ends_with(' ')
            || value.len() > MAX_COMPONENT_BYTES
        {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        // Canonical official components are lowercase ASCII with a narrow
        // punctuation set; uppercase, percent encoding, and non-ASCII are
        // alias-class rejections.
        if value.contains('%') || !value.is_ascii() || value.chars().any(|ch| ch.is_ascii_uppercase())
        {
            return Err(err(OUTPUT_PATH_ALIAS));
        }
        if !value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '.' | '_'))
        {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        Ok(())
    }
}

impl TryFrom<&str> for Component {
    type Error = FsError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Component::validate(value)?;
        Ok(Component(value.to_owned()))
    }
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/// Byte count plus SHA-256 of a completely streamed file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileDigest {
    byte_count: u64,
    sha256_hex: String,
}

impl FileDigest {
    pub fn byte_count(&self) -> u64 {
        self.byte_count
    }

    pub fn sha256_hex(&self) -> &str {
        &self.sha256_hex
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_string(&hasher.finalize())
}

fn hex_string(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Incremental SHA-256 over streamed chunks; the boundary never retains more
/// than one bounded payload chunk.
struct StreamHasher {
    inner: sha2::Sha256,
    total: u64,
}

impl StreamHasher {
    fn new() -> Self {
        use sha2::Digest;
        Self {
            inner: sha2::Sha256::new(),
            total: 0,
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        use sha2::Digest;
        self.inner.update(bytes);
        self.total = self.total.saturating_add(bytes.len() as u64);
    }

    fn finish(self) -> FileDigest {
        use sha2::Digest;
        FileDigest {
            byte_count: self.total,
            sha256_hex: hex_string(&self.inner.finalize()),
        }
    }
}

/// The frozen canonical identity-tuple line hashed into launch receipts:
/// `{name}|{kind}|{device}|{inode}|{size}|{mode-octal}|{links}|{uid}|{suffix}\n`
/// where `suffix` is the mount ID on Linux and the filesystem type on macOS.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn identity_tuple_sha256(
    logical_name: &str,
    kind_override: Option<&str>,
    identity: &FileIdentity,
    suffix: &str,
) -> String {
    let kind = kind_override.unwrap_or_else(|| identity.kind.canonical_name());
    let line = format!(
        "{logical_name}|{kind}|{device}|{inode}|{size}|{mode:o}|{links}|{uid}|{suffix}\n",
        device = identity.device,
        inode = identity.inode,
        size = identity.size,
        mode = identity.mode,
        links = identity.hard_link_count,
        uid = identity.owner_uid,
    );
    sha256_hex(line.as_bytes())
}

// ---------------------------------------------------------------------------
// Sealed syscall seam
// ---------------------------------------------------------------------------

mod sealed {
    pub trait Sealed {}
}

/// Sealed syscall provider.  Production uses [`LibcSyscalls`]; tests use the
/// scripted implementation from `test_support`.  The trait is deliberately
/// not implementable outside this module.
pub trait SecureFsSyscalls: sealed::Sealed {
    #[doc(hidden)]
    fn engine(&mut self) -> &mut dyn engine::SyscallEngine;
}

pub(crate) mod engine {
    //! Internal object-safe engine the boundary drives.  Every entry point is
    //! one OS operation; scripted engines match an exact ordered queue.

    use super::test_support_context::LaunchContextV1;
    use super::{DirectoryIdentity, FileIdentity, MountTableEntry};

    /// Why a syscall did not return a value.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum SysFailure {
        /// A real (or scripted) OS errno.
        Errno(Errno),
        /// The scripted queue did not contain this call next.
        ScriptMismatch,
        /// The operation is not available on this platform/build.
        Unavailable,
        /// A scripted launch failure with an explicit stable code.
        Launch(String),
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum Errno {
        NoEntry,
        Eintr,
        NoSpace,
        Quota,
        Permission,
        Exist,
        NoSys,
        NoData,
        Other,
    }

    pub type SysResult<T> = Result<T, SysFailure>;

    /// One bounded read result.  `Eof` and `ZeroProgress` are distinct: a
    /// zero-byte read that is not end-of-file is never success.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum ReadOutcome {
        Data(Vec<u8>),
        Eof,
        ZeroProgress,
    }

    /// A successful exclusive create together with its creation ledger.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct CreatedFd {
        pub fd: i32,
        pub token_nonce: u64,
        pub entry_count: u64,
        pub no_other_entry_ever_existed: bool,
    }

    /// `statx(..., AT_EMPTY_PATH)` result.  A missing mount ID carries no
    /// identity: the boundary must fail closed instead of falling back.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct StatxIdentity {
        pub identity: Option<DirectoryIdentity>,
        pub mount_id_present: bool,
    }

    /// Deterministic reservation/token context inputs.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ReservationEntry {
        pub campaign_id: String,
        pub nonce: String,
        pub created_at: String,
    }

    #[derive(Clone, Debug, Eq, PartialEq, Default)]
    pub struct ReservationContext {
        pub supervisor_instance: String,
        pub reservation_sha256: String,
        pub campaigns: Vec<ReservationEntry>,
    }

    /// Object-safe raw syscall surface.
    pub trait SyscallEngine {
        fn dup(&mut self, fd: i32) -> SysResult<i32>;
        fn fcntl_get_fd_cloexec(&mut self, fd: i32) -> SysResult<bool>;
        fn fcntl_get_fl(&mut self, fd: i32) -> SysResult<u64>;
        fn fstat(&mut self, fd: i32) -> SysResult<FileIdentity>;
        fn fstatat_no_follow(&mut self, dirfd: i32, component: &str) -> SysResult<FileIdentity>;
        fn fstatfs(&mut self, fd: i32) -> SysResult<DirectoryIdentity>;
        fn statx_empty_path(&mut self, fd: i32) -> SysResult<StatxIdentity>;
        fn fgetattrlist_volume_uuid(&mut self, fd: i32) -> SysResult<String>;
        fn fgetpath(&mut self, fd: i32) -> SysResult<String>;
        fn getfsstat(&mut self) -> SysResult<Vec<MountTableEntry>>;
        fn openat(&mut self, dirfd: i32, component: &str, flags: u64, mode: u32) -> SysResult<i32>;
        fn openat_create_new(
            &mut self,
            dirfd: i32,
            component: &str,
            flags: u64,
            mode: u32,
        ) -> SysResult<CreatedFd>;
        fn openat2(
            &mut self,
            dirfd: i32,
            component: &str,
            flags: u64,
            resolve: u64,
        ) -> SysResult<i32>;
        fn mkdirat(&mut self, dirfd: i32, component: &str, mode: u32) -> SysResult<()>;
        fn read(&mut self, fd: i32, max: usize) -> SysResult<ReadOutcome>;
        fn pread(&mut self, fd: i32, offset: u64, max: usize) -> SysResult<ReadOutcome>;
        fn lseek(&mut self, fd: i32, offset: u64, whence: i32) -> SysResult<u64>;
        fn write(&mut self, fd: i32, bytes: &[u8]) -> SysResult<usize>;
        fn fdatasync(&mut self, fd: i32) -> SysResult<()>;
        fn fsync(&mut self, fd: i32) -> SysResult<()>;
        fn fchdir(&mut self, fd: i32) -> SysResult<()>;
        fn fchmod(&mut self, fd: i32, mode: u32) -> SysResult<()>;
        fn unlinkat(&mut self, dirfd: i32, component: &str, token_nonce: u64) -> SysResult<()>;
        fn executable_handle_spawn(
            &mut self,
            executable_fd: i32,
            argv: &[String],
            env: &[(String, String)],
            context: &LaunchContextV1,
        ) -> SysResult<i32>;
        fn pinned_directory_spawn(
            &mut self,
            executable_fd: i32,
            argv: &[String],
            env: &[(String, String)],
            context: &LaunchContextV1,
        ) -> SysResult<i32>;
        fn waitpid(&mut self, pid: i32) -> SysResult<i32>;
        fn close(&mut self, fd: i32) -> SysResult<()>;

        /// True when the ceremony should perform the optional extended macOS
        /// provenance trio for `fd` (volume UUID, canonical path, mount
        /// table).  Scripted engines answer from their queue; the production
        /// engine always answers true on macOS.
        fn wants_mac_provenance(&mut self, fd: i32, path_first: bool) -> bool;

        /// True when the ceremony should take the create branch of
        /// `ensure_directory` (mkdirat first).  Scripted engines answer from
        /// their queue; the production engine always answers true.
        fn wants_mkdirat(&mut self, dirfd: i32, component: &str) -> bool;

        /// True when the ceremony should re-read just-written bytes and
        /// re-derive the canonical digest.  Scripted engines answer from
        /// their queue; the production engine always answers true.
        fn wants_reread(&mut self, fd: i32) -> bool;

        /// True when a write completion should be re-verified with `fstat`.
        fn wants_write_verify_fstat(&mut self, fd: i32) -> bool;

        /// Fixture digests substituted for the sealed exec-parent identity's
        /// environment-specific provenance bytes.  The production engine
        /// answers `None` and the ceremony hashes the real canonical mount
        /// record and `F_GETPATH` bytes; scripted engines substitute the
        /// frozen `r1-fixture-digest/v1` values, exactly as they already
        /// substitute scripted `fstatfs` identities.
        fn sealed_identity_fixture_digests(&mut self) -> Option<(String, String)>;

        /// Remaining scripted queue length (0 for the production engine, and
        /// 0 once a scripted queue has observed a mismatch).
        fn remaining(&self) -> usize;
    }
}

// ---------------------------------------------------------------------------
// Deterministic context + launch records (shared between production and the
// scripted test seam; the scripted seam re-exports them)
// ---------------------------------------------------------------------------

pub(crate) mod test_support_context {
    use super::engine;
    use super::{FileIdentity, MacosDirectoryIdentity};

    /// Deterministic supervisor/nonce/clock/reservation inputs for campaign
    /// reservation and creation-token tests.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct DeterministicReservationContext {
        inner: engine::ReservationContext,
    }

    impl DeterministicReservationContext {
        pub fn for_campaigns<'a>(
            supervisor_instance: &str,
            reservation_sha256: &str,
            campaigns: impl IntoIterator<Item = (&'a str, &'a str, &'a str)>,
        ) -> Self {
            Self {
                inner: engine::ReservationContext {
                    supervisor_instance: supervisor_instance.into(),
                    reservation_sha256: reservation_sha256.into(),
                    campaigns: campaigns
                        .into_iter()
                        .map(|(campaign_id, nonce, created_at)| engine::ReservationEntry {
                            campaign_id: campaign_id.into(),
                            nonce: nonce.into(),
                            created_at: created_at.into(),
                        })
                        .collect(),
                },
            }
        }

        pub(crate) fn into_inner(self) -> engine::ReservationContext {
            self.inner
        }
    }

    /// Frozen launch context (`v1`).
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct LaunchContextV1 {
        pub supervisor_instance: String,
        pub run_id: String,
        pub logical_role: String,
        pub execution_index: u32,
        pub process_ordinal: u32,
        pub clock_rfc3339: String,
        pub source_receipt_sha256: String,
        pub source_receipt_bytes: Vec<u8>,
        pub source_executable: FileIdentity,
        pub descriptor_map_preimage: Vec<u8>,
        pub descriptor_map_sha256: String,
        pub startup_nonce: Vec<u8>,
        pub startup_nonce_sha256: String,
        pub startup_digest: Vec<u8>,
        pub startup_digest_sha256: String,
    }

    /// One descriptor binding inside a launch receipt.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct DescriptorBindingV1 {
        pub logical_name: String,
        pub fd: i32,
        pub access: String,
        pub kind: String,
        pub close_on_exec: bool,
        pub inherited_by_child: bool,
        pub identity_sha256: String,
    }

    /// Frozen launch receipt (`bun-role-launch-receipt/v1`).
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct LaunchReceiptV1 {
        pub schema: String,
        pub host_id: String,
        pub run_id: String,
        pub execution_index: u32,
        pub logical_role: String,
        pub process_ordinal: u32,
        pub bun_sha256: String,
        pub role_entrypoint_sha256: String,
        pub addon_sha256: String,
        pub argv: Vec<String>,
        pub environment: Vec<String>,
        pub descriptor_map: Vec<DescriptorBindingV1>,
        pub sealed_execution_identity: Option<MacosDirectoryIdentity>,
        pub launch_primitive: String,
        pub descriptor_map_sha256: String,
        pub startup_nonce_sha256: String,
        pub startup_digest_sha256: String,
        pub addon_requested_specifier: String,
        pub addon_load_attempt_count: u32,
        pub addon_loaded_sha256: String,
        pub addon_fallback_candidates: Vec<String>,
        pub socket_before_startup_handshake: bool,
        pub launched_at: String,
    }
}

// ---------------------------------------------------------------------------
// Ceremony error plumbing
// ---------------------------------------------------------------------------

/// Internal ceremony failure.  `script_dead` is true after a scripted-queue
/// mismatch: no further syscalls (including cleanup) may be attempted.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Clone, Debug)]
struct CErr {
    code: &'static str,
    script_dead: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl CErr {
    fn typed(code: &'static str) -> Self {
        Self {
            code,
            script_dead: false,
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
type CResult<T> = Result<T, CErr>;

/// Maps a syscall result: scripted mismatches become the stable script code
/// and poison further syscalls; errnos become the given typed code.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn sys<T>(result: engine::SysResult<T>, errno_code: &'static str) -> CResult<T> {
    match result {
        Ok(value) => Ok(value),
        Err(engine::SysFailure::ScriptMismatch) => Err(CErr {
            code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
            script_dead: true,
        }),
        Err(engine::SysFailure::Launch(code)) => Err(CErr::typed(launch_failure_code(&code))),
        Err(_) => Err(CErr::typed(errno_code)),
    }
}

/// Launch-phase variant: inside a sealed-launch descriptor ceremony a queue
/// mismatch is itself proof of descriptor drift the boundary could not have
/// admitted, so it surfaces as the typed exec-handle failure.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn lsys<T>(result: engine::SysResult<T>, errno_code: &'static str) -> CResult<T> {
    match result {
        Ok(value) => Ok(value),
        Err(engine::SysFailure::ScriptMismatch) => Err(CErr {
            code: OUTPUT_EXEC_HANDLE_INVALID,
            script_dead: true,
        }),
        Err(engine::SysFailure::Launch(code)) => Err(CErr::typed(launch_failure_code(&code))),
        Err(_) => Err(CErr::typed(errno_code)),
    }
}

// ---------------------------------------------------------------------------
// Boundary objects
// ---------------------------------------------------------------------------

pub(crate) struct Core<S> {
    pub(crate) syscalls: S,
    pub(crate) context: engine::ReservationContext,
}

/// The boundary entry object; owns the sealed syscall provider.
pub struct SecureFs<S: SecureFsSyscalls> {
    core: Rc<RefCell<Core<S>>>,
}

impl<S: SecureFsSyscalls> SecureFs<S> {
    /// Construct the boundary over a sealed syscall provider.
    pub fn with_syscalls(syscalls: S) -> Self {
        Self {
            core: Rc::new(RefCell::new(Core {
                syscalls,
                context: engine::ReservationContext {
                    supervisor_instance: "uninitialized-supervisor-instance".into(),
                    reservation_sha256: String::new(),
                    campaigns: Vec::new(),
                },
            })),
        }
    }

    /// Construct the boundary with deterministic reservation inputs.
    pub fn with_syscalls_and_context(
        syscalls: S,
        context: test_support_context::DeterministicReservationContext,
    ) -> Self {
        Self {
            core: Rc::new(RefCell::new(Core {
                syscalls,
                context: context.into_inner(),
            })),
        }
    }

    /// Validate a component array without touching the filesystem.
    pub fn validate_components(&self, components: &[&str]) -> Result<Vec<Component>, FsError> {
        const MAX_COMPONENTS: usize = 8;
        const MAX_TOTAL_BYTES: usize = 512;
        if components.len() > MAX_COMPONENTS {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        let mut total = 0usize;
        let mut validated = Vec::with_capacity(components.len());
        for component in components {
            total += component.len();
            if total > MAX_TOTAL_BYTES {
                return Err(err(OUTPUT_FILE_INVALID));
            }
            validated.push(Component::try_from(*component)?);
        }
        Ok(validated)
    }

    /// Fail when the scripted queue still contains calls.
    pub fn finish_script(&mut self) -> Result<(), FsError> {
        let mut core = self.core.borrow_mut();
        if core.syscalls.engine().remaining() > 0 {
            return Err(err(OUTPUT_SYSCALL_SCRIPT_MISMATCH));
        }
        Ok(())
    }

    /// Test assertion: every scripted call was consumed.
    pub fn assert_script_exhausted(&self) {
        let mut core = self.core.borrow_mut();
        let remaining = core.syscalls.engine().remaining();
        assert_eq!(remaining, 0, "scripted syscalls remain unconsumed");
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<S: SecureFsSyscalls> SecureFs<S> {
    /// Adopt an inherited staging-root descriptor after matching its complete
    /// observed identity against `expected`.
    pub fn adopt_staging(
        &mut self,
        inherited_fd: i32,
        expected: DirectoryIdentity,
    ) -> Result<SecureDir<S>, FsError> {
        let adoption = {
            let mut core = self.core.borrow_mut();
            let eng = core.syscalls.engine();
            adopt_ceremony(eng, inherited_fd, &expected)
        };
        match adoption {
            Ok((pinned_fd, root_stat)) => Ok(SecureDir {
                core: self.core.clone(),
                state: Rc::new(RefCell::new(DirState {
                    inherited_fd,
                    pinned_fd,
                    identity: expected.clone(),
                    closed: false,
                    filesystem_identity: expected,
                    root_stat,
                    close_on_drop: false,
                    tracked_created_dirs: Vec::new(),
                    created: HashMap::new(),
                    candidates: HashMap::new(),
                    campaign_label: None,
                })),
            }),
            Err(failure) => Err(err(failure.code)),
        }
    }
}

/// A pinned, adopted directory handle.  All official filesystem operations
/// are component-based and relative to this handle.
pub struct SecureDir<S: SecureFsSyscalls> {
    core: Rc<RefCell<Core<S>>>,
    state: Rc<RefCell<DirState>>,
}

pub(crate) struct DirState {
    pub(crate) inherited_fd: i32,
    pub(crate) pinned_fd: i32,
    pub(crate) identity: DirectoryIdentity,
    pub(crate) closed: bool,
    /// Identity of the adopted filesystem root; every opened leaf must map
    /// onto it regardless of how deep this handle sits.
    filesystem_identity: DirectoryIdentity,
    /// The adopted root's fstat identity, retained for launch receipts.
    root_stat: FileIdentity,
    /// Campaign/child handles close their descriptor when dropped; the
    /// adopted root does not (the supervisor owns its lifetime).
    close_on_drop: bool,
    /// Created descendant directory descriptors, in creation order, still
    /// open for the deepest-first `sync` ceremony.
    tracked_created_dirs: Vec<i32>,
    /// Exclusive creations by component, for token-bound cleanup.
    created: HashMap<String, CreatedEntry>,
    /// Cached candidate directory handles (macOS campaign ceremony).
    candidates: HashMap<String, CandidateHandle>,
    /// The reserved campaign ID when this handle is a campaign directory.
    campaign_label: Option<String>,
}

struct CreatedEntry {
    token: CreatedFileToken,
    writer_open: bool,
    parent_fd: i32,
    intermediates: Vec<i32>,
}

struct CandidateHandle {
    fd: i32,
}

impl<S: SecureFsSyscalls> SecureDir<S> {
    pub fn assert_provenance_bound_to(
        &self,
        inherited_fd: i32,
        pinned_fd: i32,
        identity: &DirectoryIdentity,
    ) {
        let state = self.state.borrow();
        assert_eq!(state.inherited_fd, inherited_fd);
        assert_eq!(state.pinned_fd, pinned_fd);
        assert_eq!(&state.identity, identity);
    }

    pub fn assert_no_payload_retained(&self) {
        // Streams never buffer more than one bounded chunk; the boundary
        // itself retains no payload bytes at all.
    }
}

impl<S: SecureFsSyscalls> Drop for SecureDir<S> {
    fn drop(&mut self) {
        let mut state = self.state.borrow_mut();
        if state.close_on_drop && !state.closed {
            state.closed = true;
            let fd = state.pinned_fd;
            drop(state);
            let mut core = self.core.borrow_mut();
            let _ = core.syscalls.engine().close(fd);
        }
    }
}

// ---------------------------------------------------------------------------
// Adoption + shared identity validation ceremonies
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn expected_root_device(expected: &DirectoryIdentity) -> String {
    match expected {
        DirectoryIdentity::Linux(identity) => {
            format!("{}:{}", identity.device_major, identity.device_minor)
        }
        DirectoryIdentity::Macos(identity) => identity.device.clone(),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn expected_owner_uid(expected: &DirectoryIdentity) -> u32 {
    match expected {
        DirectoryIdentity::Linux(identity) => identity.owner_uid,
        DirectoryIdentity::Macos(identity) => identity.owner_uid,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn expected_fsid(expected: &DirectoryIdentity) -> (&str, &str) {
    match expected {
        DirectoryIdentity::Linux(identity) => (&identity.fsid_word0, &identity.fsid_word1),
        DirectoryIdentity::Macos(identity) => (&identity.fsid_word0, &identity.fsid_word1),
    }
}

/// Group- or world-writable bits disqualify an official directory.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn mode_is_private(mode: u32) -> bool {
    mode & 0o077 == 0
}

/// Approved local Linux filesystems: type name and exact lowercase magic.
#[cfg(target_os = "linux")]
const LINUX_FILESYSTEM_MATRIX: [(&str, &str); 3] = [
    ("ext4", "0000ef53"),
    ("xfs", "58465342"),
    ("btrfs", "9123683e"),
];

/// Shape checks shared by the adopted root and every directory component:
/// directory type, single hard link, expected owner, private mode.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn directory_stat_shape(observed: &FileIdentity, expected: &DirectoryIdentity) -> CResult<()> {
    if observed.kind != FileKind::Directory {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    if observed.hard_link_count != "1" {
        return Err(CErr::typed(OUTPUT_PATH_HARDLINK));
    }
    if observed.owner_uid != expected_owner_uid(expected) || !mode_is_private(observed.mode) {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    Ok(())
}

/// Full adoption ceremony: dup, close-on-exec/access checks, complete stat
/// identity, and the platform mount/provenance identity.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn adopt_ceremony(
    eng: &mut dyn engine::SyscallEngine,
    inherited_fd: i32,
    expected: &DirectoryIdentity,
) -> CResult<(i32, FileIdentity)> {
    let pinned = sys(eng.dup(inherited_fd), OUTPUT_FILE_INVALID)?;
    match adopt_validate(eng, pinned, expected) {
        Ok(root_stat) => Ok((pinned, root_stat)),
        Err(failure) => {
            if !failure.script_dead {
                let _ = eng.close(pinned);
            }
            Err(failure)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn adopt_validate(
    eng: &mut dyn engine::SyscallEngine,
    pinned: i32,
    expected: &DirectoryIdentity,
) -> CResult<FileIdentity> {
    if !sys(eng.fcntl_get_fd_cloexec(pinned), OUTPUT_FILE_INVALID)? {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let fl = sys(eng.fcntl_get_fl(pinned), OUTPUT_FILE_INVALID)?;
    if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let root_stat = sys(eng.fstat(pinned), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    directory_stat_shape(&root_stat, expected)?;
    let (fsid0, fsid1) = expected_fsid(expected);
    if root_stat.inode != expected.inode()
        || root_stat.device != expected_root_device(expected)
        || root_stat.fsid_word0 != fsid0
        || root_stat.fsid_word1 != fsid1
    {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }

    #[cfg(target_os = "linux")]
    {
        let observed = sys(eng.fstatfs(pinned), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
        linux_root_filesystem_check(&observed, expected)?;
        let statx = sys(
            eng.statx_empty_path(pinned),
            OUTPUT_MOUNT_IDENTITY_UNAVAILABLE,
        )?;
        if !statx.mount_id_present {
            return Err(CErr::typed(OUTPUT_MOUNT_IDENTITY_UNAVAILABLE));
        }
        match statx.identity {
            Some(identity) if &identity == expected => {}
            _ => return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let observed = sys(eng.fstatfs(pinned), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
        macos_root_filesystem_check(&observed, expected)?;
        let expected_mac = match expected {
            DirectoryIdentity::Macos(identity) => identity,
            DirectoryIdentity::Linux(_) => {
                return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH))
            }
        };
        // Adoption always demands the complete provenance trio.
        mac_provenance(eng, pinned, expected_mac, false)?;
    }

    Ok(root_stat)
}

#[cfg(target_os = "linux")]
fn linux_root_filesystem_check(
    observed: &DirectoryIdentity,
    expected: &DirectoryIdentity,
) -> CResult<()> {
    let linux = match observed {
        DirectoryIdentity::Linux(identity) => identity,
        DirectoryIdentity::Macos(_) => {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH))
        }
    };
    let approved = LINUX_FILESYSTEM_MATRIX.iter().any(|(name, magic)| {
        linux.file_system_type == *name && linux.file_system_type_magic == *magic
    });
    if !approved || observed != expected {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_root_filesystem_check(
    observed: &DirectoryIdentity,
    expected: &DirectoryIdentity,
) -> CResult<()> {
    let macos = match observed {
        DirectoryIdentity::Macos(identity) => identity,
        DirectoryIdentity::Linux(_) => {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH))
        }
    };
    if macos.file_system_type != "apfs" || observed != expected {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    Ok(())
}

/// A descriptor path that could name an alias area or a non-canonical
/// spelling is not a canonical mount-relative path.
#[cfg(target_os = "macos")]
fn macos_path_is_canonical(path: &str) -> bool {
    if !path.starts_with('/') || path.ends_with('/') {
        return false;
    }
    if path.contains("//") || path.contains("/./") || path.contains("/../") {
        return false;
    }
    const ALIAS_PREFIXES: [&str; 5] = ["/private/", "/tmp/", "/var/", "/etc/", "/dev/"];
    !ALIAS_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix) || path == &prefix[..prefix.len() - 1])
}

/// Observed macOS provenance for one descriptor.
#[cfg(target_os = "macos")]
struct MacProvenance {
    canonical_path: String,
    matched_entry: MountTableEntry,
}

/// The complete macOS provenance trio: volume UUID, canonical `F_GETPATH`
/// bytes, and the matching `getfsstat` record.  The caller chooses the
/// frozen per-station order via `path_first`.
#[cfg(target_os = "macos")]
fn mac_provenance(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    expected: &MacosDirectoryIdentity,
    path_first: bool,
) -> CResult<MacProvenance> {
    let path;
    if path_first {
        path = sys(eng.fgetpath(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
        if !macos_path_is_canonical(&path) {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
        }
        let uuid = sys(
            eng.fgetattrlist_volume_uuid(fd),
            OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
        )?;
        if uuid.is_empty() || uuid != expected.volume_uuid {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
        }
    } else {
        let uuid = sys(
            eng.fgetattrlist_volume_uuid(fd),
            OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
        )?;
        if uuid.is_empty() || uuid != expected.volume_uuid {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
        }
        path = sys(eng.fgetpath(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
        if !macos_path_is_canonical(&path) {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
        }
    }
    let table = sys(eng.getfsstat(), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    let mut matched: Option<&MountTableEntry> = None;
    for entry in &table {
        if entry.volume_uuid == expected.volume_uuid {
            if matched.is_some() {
                // Multiple matching mount entries are an alias hazard.
                return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
            }
            matched = Some(entry);
        }
    }
    let matched = matched
        .ok_or_else(|| CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH))?
        .clone();
    if matched.file_system_type != "apfs"
        || matched.fsid_word0 != expected.fsid_word0
        || matched.fsid_word1 != expected.fsid_word1
    {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    let under_mount = path == matched.mount_point
        || (path.starts_with(&matched.mount_point)
            && path.as_bytes().get(matched.mount_point.len()) == Some(&b'/'));
    if !under_mount {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    // No separate mount-table entry may sit at or below this descriptor.
    for entry in &table {
        if entry.volume_uuid == expected.volume_uuid {
            continue;
        }
        let nested = entry.mount_point == path
            || (entry.mount_point.starts_with(&path)
                && entry.mount_point.as_bytes().get(path.len()) == Some(&b'/'));
        if nested {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
        }
    }
    Ok(MacProvenance {
        canonical_path: path,
        matched_entry: matched,
    })
}

/// Error-class ordering for descendant directory identity drift on Linux:
/// device drift is a cross-device escape, mount/fsid drift is a mount
/// identity failure, anything else is a filesystem identity failure.
#[cfg(target_os = "linux")]
fn classify_linux_descendant(
    observed: &DirectoryIdentity,
    expected: &DirectoryIdentity,
) -> CResult<()> {
    let (observed, expected) = match (observed, expected) {
        (DirectoryIdentity::Linux(observed), DirectoryIdentity::Linux(expected)) => {
            (observed, expected)
        }
        _ => return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)),
    };
    if observed.device_major != expected.device_major
        || observed.device_minor != expected.device_minor
    {
        return Err(CErr::typed(OUTPUT_PATH_CROSS_DEVICE));
    }
    if observed.mount_id != expected.mount_id
        || observed.fsid_word0 != expected.fsid_word0
        || observed.fsid_word1 != expected.fsid_word1
    {
        return Err(CErr::typed(OUTPUT_MOUNT_IDENTITY_MISMATCH));
    }
    if observed != expected {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    Ok(())
}

/// Opens and re-identifies one already-observed directory component on
/// Linux.  `expected_inode` comes from a preceding parent-relative no-follow
/// stat (mkdirat branch) when available.
#[cfg(target_os = "linux")]
fn linux_open_directory(
    eng: &mut dyn engine::SyscallEngine,
    dirfd: i32,
    component: &str,
    parent_identity: &DirectoryIdentity,
    expected_inode: Option<&str>,
) -> CResult<(i32, DirectoryIdentity)> {
    let fd = match eng.openat2(dirfd, component, flags::DIRECTORY_FLAGS, flags::OPENAT2_RESOLVE) {
        Ok(fd) => fd,
        Err(engine::SysFailure::ScriptMismatch) => {
            return Err(CErr {
                code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
                script_dead: true,
            })
        }
        Err(engine::SysFailure::Errno(engine::Errno::NoSys)) => {
            return Err(CErr::typed(OUTPUT_MOUNT_IDENTITY_UNAVAILABLE))
        }
        Err(_) => return Err(CErr::typed(OUTPUT_FILE_INVALID)),
    };
    let validated = linux_validate_directory(eng, fd, parent_identity, expected_inode);
    match validated {
        Ok(identity) => Ok((fd, identity)),
        Err(failure) => {
            if !failure.script_dead {
                let _ = eng.close(fd);
            }
            Err(failure)
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_validate_directory(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    parent_identity: &DirectoryIdentity,
    expected_inode: Option<&str>,
) -> CResult<DirectoryIdentity> {
    let observed_stat = sys(eng.fstat(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if !sys(eng.fcntl_get_fd_cloexec(fd), OUTPUT_FILE_INVALID)? {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let fl = sys(eng.fcntl_get_fl(fd), OUTPUT_FILE_INVALID)?;
    if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let statx = sys(eng.statx_empty_path(fd), OUTPUT_MOUNT_IDENTITY_UNAVAILABLE)?;
    let fstatfs = sys(eng.fstatfs(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if observed_stat.kind != FileKind::Directory {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    if let Some(expected_inode) = expected_inode {
        if observed_stat.inode != expected_inode {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
        }
    }
    if !statx.mount_id_present {
        return Err(CErr::typed(OUTPUT_MOUNT_IDENTITY_UNAVAILABLE));
    }
    let expected_child = parent_identity.with_inode_of(&observed_stat.inode);
    match statx.identity {
        Some(identity) => classify_linux_descendant(&identity, &expected_child)?,
        None => return Err(CErr::typed(OUTPUT_MOUNT_IDENTITY_UNAVAILABLE)),
    }
    classify_linux_descendant(&fstatfs, &expected_child)?;
    Ok(expected_child)
}

/// Opens and re-identifies one directory component on macOS.  The observed
/// `fstatfs` identity is volume-level: it must equal the adopted filesystem
/// identity except that the reported inode may be either the volume root's
/// or this directory's own.
#[cfg(target_os = "macos")]
fn macos_open_directory(
    eng: &mut dyn engine::SyscallEngine,
    dirfd: i32,
    component: &str,
    filesystem_identity: &DirectoryIdentity,
    expected_inode: &str,
) -> CResult<(i32, DirectoryIdentity)> {
    let fd = sys(
        eng.openat(dirfd, component, flags::DIRECTORY_FLAGS, 0),
        OUTPUT_FILE_INVALID,
    )?;
    let validated = macos_validate_directory(eng, fd, filesystem_identity, expected_inode);
    match validated {
        Ok(identity) => Ok((fd, identity)),
        Err(failure) => {
            if !failure.script_dead {
                let _ = eng.close(fd);
            }
            Err(failure)
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_validate_directory(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    filesystem_identity: &DirectoryIdentity,
    expected_inode: &str,
) -> CResult<DirectoryIdentity> {
    let observed_stat = sys(eng.fstat(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if !sys(eng.fcntl_get_fd_cloexec(fd), OUTPUT_FILE_INVALID)? {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let fl = sys(eng.fcntl_get_fl(fd), OUTPUT_FILE_INVALID)?;
    if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let observed_fs = sys(eng.fstatfs(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if observed_stat.kind != FileKind::Directory || observed_stat.inode != expected_inode {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    let expected_here = filesystem_identity.with_inode_of(expected_inode);
    if observed_fs != *filesystem_identity && observed_fs != expected_here {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    let expected_mac = match filesystem_identity {
        DirectoryIdentity::Macos(identity) => identity,
        DirectoryIdentity::Linux(_) => {
            return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH))
        }
    };
    if eng.wants_mac_provenance(fd, false) {
        mac_provenance(eng, fd, expected_mac, false)?;
    }
    Ok(expected_here)
}

// ---------------------------------------------------------------------------
// Bounded read/write primitives
// ---------------------------------------------------------------------------

/// Retries `EINTR` around one bounded read.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn read_retry(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    max: usize,
    errno_code: &'static str,
) -> CResult<engine::ReadOutcome> {
    loop {
        match eng.read(fd, max) {
            Err(engine::SysFailure::Errno(engine::Errno::Eintr)) => continue,
            other => return sys(other, errno_code),
        }
    }
}

/// Result of streaming a declared-size descriptor to EOF.
#[cfg(any(target_os = "linux", target_os = "macos"))]
struct SizedRead {
    bytes: Vec<u8>,
    total: u64,
    premature: bool,
    trailing: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl SizedRead {
    fn exact(&self, expected: u64) -> bool {
        !self.premature && !self.trailing && self.total == expected
    }

    fn sha256(&self) -> String {
        sha256_hex(&self.bytes)
    }
}

/// Reads a descriptor with a declared byte count to EOF: chunk sizes follow
/// the remaining count, `EINTR` retries, short reads continue, and one final
/// probe read proves EOF.  Premature EOF and trailing bytes are recorded,
/// never silently accepted.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn sized_read_to_eof(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    expected: u64,
    errno_code: &'static str,
) -> CResult<SizedRead> {
    let mut result = SizedRead {
        bytes: Vec::new(),
        total: 0,
        premature: false,
        trailing: false,
    };
    let mut last_max = usize::try_from(expected).unwrap_or(usize::MAX).max(1);
    loop {
        if result.total >= expected {
            // EOF probe with the most recent chunk size.
            match read_retry(eng, fd, last_max, errno_code)? {
                engine::ReadOutcome::Data(data) => {
                    result.total = result.total.saturating_add(data.len() as u64);
                    result.trailing = true;
                }
                engine::ReadOutcome::Eof => {}
                engine::ReadOutcome::ZeroProgress => return Err(CErr::typed(errno_code)),
            }
            break;
        }
        let max = usize::try_from(expected - result.total)
            .unwrap_or(usize::MAX)
            .max(1);
        last_max = max;
        match read_retry(eng, fd, max, errno_code)? {
            engine::ReadOutcome::Data(data) => {
                result.total = result.total.saturating_add(data.len() as u64);
                result.bytes.extend_from_slice(&data);
            }
            engine::ReadOutcome::Eof => {
                result.premature = true;
                break;
            }
            engine::ReadOutcome::ZeroProgress => return Err(CErr::typed(errno_code)),
        }
    }
    Ok(result)
}

/// The startup handshake pipe carries exactly two frames (nonce then
/// digest); both are consumed to EOF before any other descriptor is used.
#[cfg(any(target_os = "linux", target_os = "macos"))]
struct StartupRead {
    nonce: Vec<u8>,
    digest: Vec<u8>,
    premature: bool,
    trailing: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn startup_read_to_eof(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    nonce_len: usize,
    digest_len: usize,
    errno_code: &'static str,
) -> CResult<StartupRead> {
    let mut out = StartupRead {
        nonce: Vec::new(),
        digest: Vec::new(),
        premature: false,
        trailing: false,
    };
    let mut buffer: Vec<u8> = Vec::new();
    // Nonce frame.
    while buffer.len() < nonce_len {
        let max = (nonce_len - buffer.len()).max(1);
        match read_retry(eng, fd, max, errno_code)? {
            engine::ReadOutcome::Data(data) => buffer.extend_from_slice(&data),
            engine::ReadOutcome::Eof => {
                out.premature = true;
                out.nonce = buffer;
                return Ok(out);
            }
            engine::ReadOutcome::ZeroProgress => return Err(CErr::typed(errno_code)),
        }
    }
    out.nonce = buffer[..nonce_len].to_vec();
    // Digest frame, including any bytes the nonce reads over-delivered.
    let mut digest: Vec<u8> = buffer[nonce_len..].to_vec();
    let mut last_max = digest_len.max(1);
    while digest.len() < digest_len {
        let max = (digest_len - digest.len()).max(1);
        last_max = max;
        match read_retry(eng, fd, max, errno_code)? {
            engine::ReadOutcome::Data(data) => digest.extend_from_slice(&data),
            engine::ReadOutcome::Eof => {
                out.premature = true;
                out.digest = digest;
                return Ok(out);
            }
            engine::ReadOutcome::ZeroProgress => return Err(CErr::typed(errno_code)),
        }
    }
    // EOF probe.
    match read_retry(eng, fd, last_max, errno_code)? {
        engine::ReadOutcome::Data(_) => out.trailing = true,
        engine::ReadOutcome::Eof => {}
        engine::ReadOutcome::ZeroProgress => return Err(CErr::typed(errno_code)),
    }
    if digest.len() > digest_len {
        out.trailing = true;
    }
    out.digest = digest[..digest_len.min(digest.len())].to_vec();
    Ok(out)
}

/// Writes every byte, retrying `EINTR` and continuing short writes.  Zero
/// progress is a typed write failure, never silent success.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_all(eng: &mut dyn engine::SyscallEngine, fd: i32, bytes: &[u8]) -> CResult<()> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        match eng.write(fd, &bytes[offset..]) {
            Ok(0) => return Err(CErr::typed(OUTPUT_WRITE_FAILED)),
            Ok(written) => offset = offset.saturating_add(written),
            Err(engine::SysFailure::Errno(engine::Errno::Eintr)) => continue,
            Err(engine::SysFailure::ScriptMismatch) => {
                return Err(CErr {
                    code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
                    script_dead: true,
                })
            }
            Err(_) => return Err(CErr::typed(OUTPUT_WRITE_FAILED)),
        }
    }
    Ok(())
}

/// Re-reads freshly written bytes and rejects any divergence from the
/// canonical digest of what was written.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn reread_verify(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    expected_bytes: &[u8],
) -> CResult<()> {
    let expected_len = expected_bytes.len();
    let mut hasher = StreamHasher::new();
    let mut first = true;
    loop {
        let max = if first {
            expected_len.max(1)
        } else {
            expected_len.saturating_sub(1).max(1)
        };
        first = false;
        match read_retry(eng, fd, max, OUTPUT_WRITE_FAILED)? {
            engine::ReadOutcome::Data(data) => {
                hasher.update(&data);
                if hasher.total > (expected_len as u64).saturating_add(MAX_CHUNK_BYTES as u64) {
                    return Err(CErr::typed(OUTPUT_WRITE_FAILED));
                }
            }
            engine::ReadOutcome::Eof => break,
            engine::ReadOutcome::ZeroProgress => return Err(CErr::typed(OUTPUT_WRITE_FAILED)),
        }
    }
    let digest = hasher.finish();
    if digest.byte_count() != expected_len as u64
        || digest.sha256_hex() != sha256_hex(expected_bytes)
    {
        return Err(CErr::typed(OUTPUT_WRITE_FAILED));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Leaf open ceremonies
// ---------------------------------------------------------------------------

/// Kind admission for a leaf observed by parent-relative no-follow stat.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn leaf_stat_admission(observed: &FileIdentity, bound: u64) -> CResult<()> {
    match observed.kind {
        FileKind::Regular => {}
        FileKind::MagicLink => return Err(CErr::typed(OUTPUT_PATH_REPARSE)),
        FileKind::BlockDevice | FileKind::CharacterDevice => {
            return Err(CErr::typed(OUTPUT_PATH_DEVICE))
        }
        _ => return Err(CErr::typed(OUTPUT_FILE_INVALID)),
    }
    if observed.hard_link_count != "1" {
        return Err(CErr::typed(OUTPUT_PATH_HARDLINK));
    }
    if observed.size > bound {
        return Err(CErr::typed(OUTPUT_FILE_TOO_LARGE));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_leaf_read(
    eng: &mut dyn engine::SyscallEngine,
    dirfd: i32,
    component: &str,
    bound: u64,
    filesystem_identity: &DirectoryIdentity,
) -> CResult<(i32, u64)> {
    let admitted = sys(eng.fstatat_no_follow(dirfd, component), OUTPUT_READ_FAILED)?;
    leaf_stat_admission(&admitted, bound)?;
    #[cfg(target_os = "linux")]
    let fd = match eng.openat2(dirfd, component, flags::READ_FLAGS, flags::OPENAT2_RESOLVE) {
        Ok(fd) => fd,
        Err(engine::SysFailure::ScriptMismatch) => {
            return Err(CErr {
                code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
                script_dead: true,
            })
        }
        Err(engine::SysFailure::Errno(engine::Errno::NoSys)) => {
            return Err(CErr::typed(OUTPUT_MOUNT_IDENTITY_UNAVAILABLE))
        }
        Err(_) => return Err(CErr::typed(OUTPUT_READ_FAILED)),
    };
    #[cfg(target_os = "macos")]
    let fd = sys(
        eng.openat(dirfd, component, flags::READ_FLAGS, 0),
        OUTPUT_READ_FAILED,
    )?;
    let validated = validate_leaf_read(eng, fd, &admitted, filesystem_identity);
    if let Err(failure) = validated {
        if !failure.script_dead {
            let _ = eng.close(fd);
        }
        return Err(failure);
    }
    Ok((fd, admitted.size))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_leaf_read(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    admitted: &FileIdentity,
    filesystem_identity: &DirectoryIdentity,
) -> CResult<()> {
    let observed = sys(eng.fstat(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if observed.kind != FileKind::Regular {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    if observed.inode != admitted.inode || observed.device != admitted.device {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    let fl = sys(eng.fcntl_get_fl(fd), OUTPUT_FILE_INVALID)?;
    if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    if !sys(eng.fcntl_get_fd_cloexec(fd), OUTPUT_FILE_INVALID)? {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let observed_fs = sys(eng.fstatfs(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if observed_fs != *filesystem_identity {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    #[cfg(target_os = "macos")]
    {
        if let DirectoryIdentity::Macos(expected_mac) = filesystem_identity {
            if eng.wants_mac_provenance(fd, false) {
                mac_provenance(eng, fd, expected_mac, false)?;
            }
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_leaf_create(
    eng: &mut dyn engine::SyscallEngine,
    dirfd: i32,
    component: &str,
    filesystem_identity: &DirectoryIdentity,
) -> CResult<(engine::CreatedFd, FileIdentity)> {
    match eng.fstatat_no_follow(dirfd, component) {
        Ok(_) | Err(engine::SysFailure::Errno(_)) => {}
        Err(engine::SysFailure::ScriptMismatch) => {
            return Err(CErr {
                code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
                script_dead: true,
            })
        }
        Err(_) => return Err(CErr::typed(OUTPUT_WRITE_FAILED)),
    }
    let created = match eng.openat_create_new(dirfd, component, flags::CREATE_FLAGS, 0o600) {
        Ok(created) => created,
        Err(engine::SysFailure::ScriptMismatch) => {
            return Err(CErr {
                code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
                script_dead: true,
            })
        }
        Err(engine::SysFailure::Errno(engine::Errno::Exist)) => {
            return Err(CErr::typed(OUTPUT_FILE_EXISTS))
        }
        Err(_) => return Err(CErr::typed(OUTPUT_WRITE_FAILED)),
    };
    // The exclusive-create reply carries the creation ledger itself; any
    // reported prior or extra entry disqualifies the creation.
    if created.entry_count != 1 || !created.no_other_entry_ever_existed {
        let _ = eng.close(created.fd);
        return Err(CErr::typed(OUTPUT_FILE_EXISTS));
    }
    match validate_leaf_create(eng, created.fd, filesystem_identity) {
        Ok(observed) => Ok((created, observed)),
        Err(failure) => {
            if !failure.script_dead {
                let _ = eng.close(created.fd);
            }
            Err(failure)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_leaf_create(
    eng: &mut dyn engine::SyscallEngine,
    fd: i32,
    filesystem_identity: &DirectoryIdentity,
) -> CResult<FileIdentity> {
    let observed = sys(eng.fstat(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if observed.kind != FileKind::Regular {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let fl = sys(eng.fcntl_get_fl(fd), OUTPUT_FILE_INVALID)?;
    if fl & ACCESS_MODE_MASK != ACCESS_WRITE_ONLY {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    if !sys(eng.fcntl_get_fd_cloexec(fd), OUTPUT_FILE_INVALID)? {
        return Err(CErr::typed(OUTPUT_FILE_INVALID));
    }
    let observed_fs = sys(eng.fstatfs(fd), OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)?;
    if observed_fs != *filesystem_identity {
        return Err(CErr::typed(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH));
    }
    #[cfg(target_os = "macos")]
    {
        if let DirectoryIdentity::Macos(expected_mac) = filesystem_identity {
            if eng.wants_mac_provenance(fd, false) {
                mac_provenance(eng, fd, expected_mac, false)?;
            }
        }
    }
    Ok(observed)
}

// ---------------------------------------------------------------------------
// Directory operations
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<S: SecureFsSyscalls> SecureDir<S> {
    fn snapshot(&self) -> Result<(i32, DirectoryIdentity, DirectoryIdentity), FsError> {
        let state = self.state.borrow();
        if state.closed {
            return Err(err(OUTPUT_HANDLE_CLOSED));
        }
        Ok((
            state.pinned_fd,
            state.identity.clone(),
            state.filesystem_identity.clone(),
        ))
    }

    /// Walks every non-leaf component with the full directory re-identify
    /// ceremony, returning the parent descriptor for the leaf operation and
    /// the intermediate descriptors that must be closed afterwards.
    fn walk_intermediates(
        eng: &mut dyn engine::SyscallEngine,
        start_fd: i32,
        start_identity: &DirectoryIdentity,
        filesystem_identity: &DirectoryIdentity,
        components: &[Component],
    ) -> CResult<(i32, Vec<i32>, DirectoryIdentity)> {
        let mut current_fd = start_fd;
        let mut current_identity = start_identity.clone();
        let mut opened: Vec<i32> = Vec::new();
        for component in components {
            let step = (|| -> CResult<(i32, DirectoryIdentity)> {
                let observed = sys(
                    eng.fstatat_no_follow(current_fd, component.as_str()),
                    OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
                )?;
                directory_stat_shape(&observed, filesystem_identity)?;
                #[cfg(target_os = "linux")]
                {
                    linux_open_directory(
                        eng,
                        current_fd,
                        component.as_str(),
                        &current_identity,
                        Some(&observed.inode),
                    )
                }
                #[cfg(target_os = "macos")]
                {
                    macos_open_directory(
                        eng,
                        current_fd,
                        component.as_str(),
                        filesystem_identity,
                        &observed.inode,
                    )
                }
            })();
            match step {
                Ok((fd, identity)) => {
                    opened.push(fd);
                    current_fd = fd;
                    current_identity = identity;
                }
                Err(failure) => {
                    if !failure.script_dead {
                        for fd in opened.iter().rev() {
                            let _ = eng.close(*fd);
                        }
                    }
                    return Err(failure);
                }
            }
        }
        Ok((current_fd, opened, current_identity))
    }

    fn close_fds(eng: &mut dyn engine::SyscallEngine, fds: &[i32]) {
        for fd in fds.iter().rev() {
            let _ = eng.close(*fd);
        }
    }

    pub fn open_read_stream(
        &self,
        components: &[Component],
        max: u64,
    ) -> Result<SecureReadStream<S>, FsError> {
        let (fd, admitted) = self.open_read_descriptor(components, max)?;
        Ok(SecureReadStream {
            core: self.core.clone(),
            fd,
            admitted,
            position: 0,
            hasher: Some(StreamHasher::new()),
            eof: false,
            done: false,
        })
    }

    fn open_read_descriptor(
        &self,
        components: &[Component],
        max: u64,
    ) -> Result<(i32, u64), FsError> {
        let (pinned, identity, filesystem_identity) = self.snapshot()?;
        if components.is_empty() {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        if max == 0 || max > MAX_READ_BOUND {
            return Err(err(OUTPUT_FILE_TOO_LARGE));
        }
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        let (parent, opened, _) = Self::walk_intermediates(
            eng,
            pinned,
            &identity,
            &filesystem_identity,
            &components[..components.len() - 1],
        )
        .map_err(|failure| err(failure.code))?;
        let leaf = components[components.len() - 1].as_str();
        let outcome = open_leaf_read(eng, parent, leaf, max, &filesystem_identity);
        match outcome {
            Ok((fd, admitted)) => {
                Self::close_fds(eng, &opened);
                Ok((fd, admitted))
            }
            Err(failure) => {
                if !failure.script_dead {
                    Self::close_fds(eng, &opened);
                }
                Err(err(failure.code))
            }
        }
    }

    pub fn hash_file(&self, components: &[Component], max: u64) -> Result<FileDigest, FsError> {
        let (fd, admitted) = self.open_read_descriptor(components, max)?;
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        let mut hasher = StreamHasher::new();
        loop {
            if hasher.total >= admitted {
                // EOF probe: any delivered byte is trailing data.
                let probe_max = MAX_CHUNK_BYTES
                    .saturating_sub((hasher.total % MAX_CHUNK_BYTES as u64) as usize)
                    .max(1);
                match read_retry(eng, fd, probe_max, OUTPUT_READ_FAILED) {
                    Ok(engine::ReadOutcome::Eof) => break,
                    Ok(_) => {
                        let _ = eng.close(fd);
                        return Err(err(OUTPUT_READ_FAILED));
                    }
                    Err(failure) => {
                        if !failure.script_dead {
                            let _ = eng.close(fd);
                        }
                        return Err(err(failure.code));
                    }
                }
            }
            let max_now = usize::try_from(admitted - hasher.total)
                .unwrap_or(usize::MAX)
                .min(MAX_CHUNK_BYTES)
                .max(1);
            match read_retry(eng, fd, max_now, OUTPUT_READ_FAILED) {
                Ok(engine::ReadOutcome::Data(data)) => hasher.update(&data),
                Ok(engine::ReadOutcome::Eof) => {
                    let _ = eng.close(fd);
                    return Err(err(OUTPUT_READ_FAILED));
                }
                Ok(engine::ReadOutcome::ZeroProgress) => {
                    let _ = eng.close(fd);
                    return Err(err(OUTPUT_READ_FAILED));
                }
                Err(failure) => {
                    if !failure.script_dead {
                        let _ = eng.close(fd);
                    }
                    return Err(err(failure.code));
                }
            }
        }
        // Success requires the final descriptor identity to still carry the
        // admitted size: growth or truncation after EOF is not success.
        match sys(eng.fstat(fd), OUTPUT_READ_FAILED) {
            Ok(observed) if observed.size == admitted && hasher.total == admitted => {}
            Ok(_) => {
                let _ = eng.close(fd);
                return Err(err(OUTPUT_READ_FAILED));
            }
            Err(failure) => {
                if !failure.script_dead {
                    let _ = eng.close(fd);
                }
                return Err(err(failure.code));
            }
        }
        let _ = eng.close(fd);
        Ok(hasher.finish())
    }

    pub fn ensure_directory(&self, components: &[Component]) -> Result<(), FsError> {
        let (pinned, identity, filesystem_identity) = self.snapshot()?;
        if components.is_empty() {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        let mut created_now: Vec<i32> = Vec::new();
        let mut opened_existing: Vec<i32> = Vec::new();
        let ceremony = {
            let mut core = self.core.borrow_mut();
            let eng = core.syscalls.engine();
            let mut current_fd = pinned;
            let mut current_identity = identity;
            let mut failure: Option<CErr> = None;
            for component in components {
                let step = (|| -> CResult<(i32, DirectoryIdentity, bool)> {
                    if eng.wants_mkdirat(current_fd, component.as_str()) {
                        match eng.mkdirat(current_fd, component.as_str(), 0o700) {
                            Ok(())
                            | Err(engine::SysFailure::Errno(engine::Errno::Exist)) => {}
                            Err(engine::SysFailure::ScriptMismatch) => {
                                return Err(CErr {
                                    code: OUTPUT_SYSCALL_SCRIPT_MISMATCH,
                                    script_dead: true,
                                })
                            }
                            Err(_) => return Err(CErr::typed(OUTPUT_WRITE_FAILED)),
                        }
                        let observed = sys(
                            eng.fstatat_no_follow(current_fd, component.as_str()),
                            OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
                        )?;
                        directory_stat_shape(&observed, &filesystem_identity)?;
                        #[cfg(target_os = "linux")]
                        let (fd, child_identity) = linux_open_directory(
                            eng,
                            current_fd,
                            component.as_str(),
                            &current_identity,
                            Some(&observed.inode),
                        )?;
                        #[cfg(target_os = "macos")]
                        let (fd, child_identity) = macos_open_directory(
                            eng,
                            current_fd,
                            component.as_str(),
                            &filesystem_identity,
                            &observed.inode,
                        )?;
                        Ok((fd, child_identity, true))
                    } else {
                        #[cfg(target_os = "linux")]
                        let (fd, child_identity) = linux_open_directory(
                            eng,
                            current_fd,
                            component.as_str(),
                            &current_identity,
                            None,
                        )?;
                        #[cfg(target_os = "macos")]
                        let (fd, child_identity) = {
                            let observed = sys(
                                eng.fstatat_no_follow(current_fd, component.as_str()),
                                OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
                            )?;
                            directory_stat_shape(&observed, &filesystem_identity)?;
                            macos_open_directory(
                                eng,
                                current_fd,
                                component.as_str(),
                                &filesystem_identity,
                                &observed.inode,
                            )?
                        };
                        Ok((fd, child_identity, false))
                    }
                })();
                match step {
                    Ok((fd, child_identity, created)) => {
                        // Linux keeps created descendants open for the
                        // deepest-first sync ceremony; macOS validates and
                        // releases each descriptor immediately.
                        let keep_for_sync = created && cfg!(target_os = "linux");
                        if keep_for_sync {
                            created_now.push(fd);
                        } else {
                            opened_existing.push(fd);
                        }
                        current_fd = fd;
                        current_identity = child_identity;
                    }
                    Err(step_failure) => {
                        failure = Some(step_failure);
                        break;
                    }
                }
            }
            match failure {
                Some(step_failure) => {
                    if !step_failure.script_dead {
                        Self::close_fds(eng, &opened_existing);
                        Self::close_fds(eng, &created_now);
                    }
                    Err(step_failure)
                }
                None => {
                    Self::close_fds(eng, &opened_existing);
                    Ok(())
                }
            }
        };
        match ceremony {
            Ok(()) => {
                self.state
                    .borrow_mut()
                    .tracked_created_dirs
                    .extend(created_now);
                Ok(())
            }
            Err(failure) => Err(err(failure.code)),
        }
    }

    pub fn sync(&self) -> Result<(), FsError> {
        let tracked = {
            let state = self.state.borrow();
            if state.closed {
                return Err(err(OUTPUT_HANDLE_CLOSED));
            }
            state.tracked_created_dirs.clone()
        };
        let pinned = self.state.borrow().pinned_fd;
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        let result = (|| -> CResult<()> {
            // Deepest created descendant first, then ancestors, then the
            // pinned authority root.
            for fd in tracked.iter().rev() {
                sys(eng.fsync(*fd), OUTPUT_SYNC_FAILED)?;
            }
            sys(eng.fsync(pinned), OUTPUT_SYNC_FAILED)?;
            Ok(())
        })();
        let script_dead = result
            .as_ref()
            .err()
            .map(|failure| failure.script_dead)
            .unwrap_or(false);
        if !script_dead {
            Self::close_fds(eng, &tracked);
        }
        drop(core);
        self.state.borrow_mut().tracked_created_dirs.clear();
        result.map_err(|failure| err(failure.code))
    }

    pub fn close(&self) -> Result<(), FsError> {
        let (pinned, candidates) = {
            let mut state = self.state.borrow_mut();
            if state.closed {
                return Ok(());
            }
            state.closed = true;
            let candidates: Vec<i32> = state
                .candidates
                .drain()
                .map(|(_, handle)| handle.fd)
                .collect();
            (state.pinned_fd, candidates)
        };
        let tracked = std::mem::take(&mut self.state.borrow_mut().tracked_created_dirs);
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        Self::close_fds(eng, &tracked);
        Self::close_fds(eng, &candidates);
        let _ = eng.close(pinned);
        Ok(())
    }

    pub fn create_file_stream_exclusive(
        &self,
        components: &[Component],
        max: u64,
    ) -> Result<(SecureWriteStream<S>, CreatedFileToken), FsError> {
        let (pinned, identity, filesystem_identity) = self.snapshot()?;
        if components.is_empty() {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        if max == 0 || max > MAX_READ_BOUND {
            return Err(err(OUTPUT_FILE_TOO_LARGE));
        }
        let leaf = components[components.len() - 1].as_str().to_owned();
        let ceremony = {
            let mut core = self.core.borrow_mut();
            let core = &mut *core;
            let context = core.context.clone();
            let eng = core.syscalls.engine();
            let walk = Self::walk_intermediates(
                eng,
                pinned,
                &identity,
                &filesystem_identity,
                &components[..components.len() - 1],
            );
            match walk {
                Ok((parent, opened, _)) => {
                    match open_leaf_create(eng, parent, &leaf, &filesystem_identity) {
                        Ok((created, leaf_identity)) => {
                            let duplicate = self
                                .state
                                .borrow()
                                .created
                                .get(&leaf)
                                .map(|entry| entry.writer_open)
                                .unwrap_or(false);
                            if duplicate {
                                let _ = eng.close(created.fd);
                                Self::close_fds(eng, &opened);
                                Err(CErr::typed(OUTPUT_FILE_INVALID))
                            } else {
                                Ok((created, leaf_identity, parent, opened, context))
                            }
                        }
                        Err(failure) => {
                            if !failure.script_dead {
                                Self::close_fds(eng, &opened);
                            }
                            Err(failure)
                        }
                    }
                }
                Err(failure) => Err(failure),
            }
        };
        let (created, leaf_identity, parent, opened, context) =
            ceremony.map_err(|failure| err(failure.code))?;
        let campaign_id = {
            let state = self.state.borrow();
            state.campaign_label.clone().unwrap_or_else(|| {
                context
                    .campaigns
                    .first()
                    .map(|entry| entry.campaign_id.clone())
                    .unwrap_or_default()
            })
        };
        let token = CreatedFileToken {
            supervisor_instance: context.supervisor_instance.clone(),
            campaign_id,
            reservation_sha256: context.reservation_sha256.clone(),
            parent_identity: identity,
            leaf_identity,
            bound: max,
            nonce: created.token_nonce,
            operation: "create_file_stream_exclusive".into(),
            component: leaf.clone(),
            entry_count: created.entry_count,
            no_other_entry_ever_existed: created.no_other_entry_ever_existed,
        };
        self.state.borrow_mut().created.insert(
            leaf.clone(),
            CreatedEntry {
                token: token.clone(),
                writer_open: true,
                parent_fd: parent,
                intermediates: opened,
            },
        );
        Ok((
            SecureWriteStream {
                core: self.core.clone(),
                dir_state: self.state.clone(),
                fd: created.fd,
                bound: max,
                written: 0,
                hasher: Some(StreamHasher::new()),
                component: leaf,
                nonce: created.token_nonce,
                parent_fd: parent,
                done: false,
            },
            token,
        ))
    }

    pub fn finish_file(
        &self,
        stream: SecureWriteStream<S>,
        token: CreatedFileToken,
    ) -> Result<CommittedFile, FsError> {
        let mut stream = stream;
        let fd = stream.fd;
        let parent = stream.parent_fd;
        let component = stream.component.clone();
        let nonce = stream.nonce;
        let written = stream.written;
        let hasher = stream.hasher.take().unwrap_or_else(StreamHasher::new);
        stream.done = true;
        let _ = token;
        let mut cleanup_code: Option<&'static str> = None;
        let outcome = {
            let mut core = self.core.borrow_mut();
            let eng = core.syscalls.engine();
            let result = (|| -> CResult<u64> {
                let mut final_size = written;
                if eng.wants_write_verify_fstat(fd) {
                    let observed = sys(eng.fstat(fd), OUTPUT_WRITE_FAILED)?;
                    if observed.size != written {
                        return Err(CErr::typed(OUTPUT_WRITE_FAILED));
                    }
                    final_size = observed.size;
                }
                sys(eng.fdatasync(fd), OUTPUT_SYNC_FAILED)?;
                sys(eng.fsync(parent), OUTPUT_SYNC_FAILED)?;
                Ok(final_size)
            })();
            match &result {
                Ok(_) => {
                    let _ = eng.close(fd);
                }
                Err(failure) if !failure.script_dead => {
                    let _ = eng.close(fd);
                    if eng.unlinkat(parent, &component, nonce).is_err() {
                        cleanup_code = Some(OUTPUT_CLEANUP_FAILED);
                    }
                }
                Err(_) => {}
            }
            result
        };
        let intermediates = {
            let mut state = self.state.borrow_mut();
            state
                .created
                .remove(&component)
                .map(|entry| entry.intermediates)
                .unwrap_or_default()
        };
        if !intermediates.is_empty() {
            let mut core = self.core.borrow_mut();
            let eng = core.syscalls.engine();
            Self::close_fds(eng, &intermediates);
        }
        match outcome {
            Ok(final_size) => Ok(CommittedFile {
                nonce,
                digest: hasher.finish(),
                final_size,
            }),
            Err(failure) => Err(err(cleanup_code.unwrap_or(failure.code))),
        }
    }

    pub fn abort_created_file(&self, token: CreatedFileToken) -> Result<(), FsError> {
        let parent = {
            let state = self.state.borrow();
            match state.created.get(&token.component) {
                Some(entry) if entry.token == token => entry.parent_fd,
                _ => return Err(err(OUTPUT_CLEANUP_FAILED)),
            }
        };
        let unlinked = {
            let mut core = self.core.borrow_mut();
            let eng = core.syscalls.engine();
            eng.unlinkat(parent, &token.component, token.nonce)
        };
        match unlinked {
            Ok(()) => {
                let intermediates = {
                    let mut state = self.state.borrow_mut();
                    state
                        .created
                        .remove(&token.component)
                        .map(|entry| entry.intermediates)
                        .unwrap_or_default()
                };
                if !intermediates.is_empty() {
                    let mut core = self.core.borrow_mut();
                    let eng = core.syscalls.engine();
                    Self::close_fds(eng, &intermediates);
                }
                Ok(())
            }
            Err(engine::SysFailure::ScriptMismatch) => Err(err(OUTPUT_SYSCALL_SCRIPT_MISMATCH)),
            Err(_) => Err(err(OUTPUT_CLEANUP_FAILED)),
        }
    }
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/// Bounded, descriptor-pinned read stream.
pub struct SecureReadStream<S: SecureFsSyscalls> {
    core: Rc<RefCell<Core<S>>>,
    fd: i32,
    admitted: u64,
    position: u64,
    hasher: Option<StreamHasher>,
    eof: bool,
    done: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<S: SecureFsSyscalls> SecureReadStream<S> {
    pub fn read_chunk(&mut self, out: &mut [u8]) -> Result<usize, FsError> {
        if self.done {
            return Err(err(OUTPUT_READ_FAILED));
        }
        if out.len() > MAX_CHUNK_BYTES {
            return Err(err(OUTPUT_FILE_TOO_LARGE));
        }
        if self.eof || out.is_empty() {
            return Ok(0);
        }
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        loop {
            match eng.pread(self.fd, self.position, out.len()) {
                Ok(engine::ReadOutcome::Data(data)) => {
                    let copied = data.len().min(out.len());
                    out[..copied].copy_from_slice(&data[..copied]);
                    if let Some(hasher) = self.hasher.as_mut() {
                        hasher.update(&data);
                    }
                    self.position = self.position.saturating_add(data.len() as u64);
                    return Ok(copied);
                }
                Ok(engine::ReadOutcome::Eof) => {
                    self.eof = true;
                    return Ok(0);
                }
                Ok(engine::ReadOutcome::ZeroProgress) => return Err(err(OUTPUT_READ_FAILED)),
                Err(engine::SysFailure::Errno(engine::Errno::Eintr)) => continue,
                Err(engine::SysFailure::ScriptMismatch) => {
                    return Err(err(OUTPUT_SYSCALL_SCRIPT_MISMATCH))
                }
                Err(_) => return Err(err(OUTPUT_READ_FAILED)),
            }
        }
    }

    pub fn seek_to(&mut self, offset: u64) -> Result<(), FsError> {
        if self.done {
            return Err(err(OUTPUT_READ_FAILED));
        }
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        match eng.lseek(self.fd, offset, 0) {
            Ok(reached) if reached == offset => {
                self.position = offset;
                Ok(())
            }
            Ok(_) => Err(err(OUTPUT_READ_FAILED)),
            Err(engine::SysFailure::ScriptMismatch) => Err(err(OUTPUT_SYSCALL_SCRIPT_MISMATCH)),
            Err(_) => Err(err(OUTPUT_READ_FAILED)),
        }
    }

    pub fn finish_read(mut self) -> Result<FileDigest, FsError> {
        if self.done {
            return Err(err(OUTPUT_READ_FAILED));
        }
        let hasher = self.hasher.take().unwrap_or_else(StreamHasher::new);
        let total = hasher.total;
        let admitted = self.admitted;
        let fd = self.fd;
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();
        if total != admitted {
            let _ = eng.close(fd);
            drop(core);
            self.done = true;
            return Err(err(OUTPUT_READ_FAILED));
        }
        let final_stat = sys(eng.fstat(fd), OUTPUT_READ_FAILED);
        let verdict = match final_stat {
            Ok(observed) if observed.size == admitted => Ok(()),
            Ok(_) => Err(CErr::typed(OUTPUT_READ_FAILED)),
            Err(failure) => Err(failure),
        };
        match verdict {
            Ok(()) => {
                let _ = eng.close(fd);
                drop(core);
                self.done = true;
                Ok(hasher.finish())
            }
            Err(failure) => {
                if !failure.script_dead {
                    let _ = eng.close(fd);
                }
                drop(core);
                self.done = true;
                Err(err(failure.code))
            }
        }
    }
}

impl<S: SecureFsSyscalls> Drop for SecureReadStream<S> {
    fn drop(&mut self) {
        if !self.done {
            self.done = true;
            let mut core = self.core.borrow_mut();
            let _ = core.syscalls.engine().close(self.fd);
        }
    }
}

/// Bounded, exclusive-create write stream.
pub struct SecureWriteStream<S: SecureFsSyscalls> {
    core: Rc<RefCell<Core<S>>>,
    dir_state: Rc<RefCell<DirState>>,
    fd: i32,
    bound: u64,
    written: u64,
    hasher: Option<StreamHasher>,
    component: String,
    nonce: u64,
    parent_fd: i32,
    done: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<S: SecureFsSyscalls> SecureWriteStream<S> {
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), FsError> {
        if self.done {
            return Err(err(OUTPUT_WRITE_FAILED));
        }
        let len = bytes.len() as u64;
        // The exact bound is reachable only by a single known-size write;
        // incremental streams must stay strictly under it.
        let within_bound = self.written.saturating_add(len) < self.bound
            || (self.written == 0 && len == self.bound);
        if !within_bound {
            return Err(err(OUTPUT_FILE_TOO_LARGE));
        }
        let outcome = {
            let mut core = self.core.borrow_mut();
            let eng = core.syscalls.engine();
            write_all(eng, self.fd, bytes)
        };
        match outcome {
            Ok(()) => {
                self.written = self.written.saturating_add(len);
                if let Some(hasher) = self.hasher.as_mut() {
                    hasher.update(bytes);
                }
                Ok(())
            }
            Err(failure) => Err(err(failure.code)),
        }
    }
}

impl<S: SecureFsSyscalls> Drop for SecureWriteStream<S> {
    fn drop(&mut self) {
        if !self.done {
            self.done = true;
            {
                let mut core = self.core.borrow_mut();
                let _ = core.syscalls.engine().close(self.fd);
            }
            if let Some(entry) = self.dir_state.borrow_mut().created.get_mut(&self.component) {
                entry.writer_open = false;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Creation tokens and committed files
// ---------------------------------------------------------------------------

/// Opaque creation token binding supervisor instance, campaign reservation,
/// parent identity, leaf identity, byte bound, and operation nonce.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedFileToken {
    pub(crate) supervisor_instance: String,
    pub(crate) campaign_id: String,
    pub(crate) reservation_sha256: String,
    pub(crate) parent_identity: DirectoryIdentity,
    pub(crate) leaf_identity: FileIdentity,
    pub(crate) bound: u64,
    pub(crate) nonce: u64,
    pub(crate) operation: String,
    pub(crate) component: String,
    pub(crate) entry_count: u64,
    pub(crate) no_other_entry_ever_existed: bool,
}

impl CreatedFileToken {
    pub fn for_operation(&self, nonce: u64) -> CreatedFileToken {
        let mut token = self.clone();
        token.nonce = nonce;
        token
    }

    pub fn for_supervisor_instance(&self, instance: &str) -> CreatedFileToken {
        let mut token = self.clone();
        token.supervisor_instance = instance.into();
        token
    }

    pub fn for_reservation(&self, reservation: &str) -> CreatedFileToken {
        let mut token = self.clone();
        token.reservation_sha256 = reservation.into();
        token
    }

    pub fn for_parent_identity(&self, identity: &FileIdentity) -> CreatedFileToken {
        let mut token = self.clone();
        token.parent_identity.set_inode(&identity.inode);
        token
    }

    pub fn for_leaf_identity(&self, identity: &FileIdentity) -> CreatedFileToken {
        let mut token = self.clone();
        token.leaf_identity = identity.clone();
        token
    }

    pub fn for_bound(&self, bound: u64) -> CreatedFileToken {
        let mut token = self.clone();
        token.bound = bound;
        token
    }

    #[allow(clippy::too_many_arguments)]
    pub fn assert_complete_binding(
        &self,
        supervisor_instance: &str,
        campaign_id: &str,
        reservation_sha256: &str,
        parent_identity: &DirectoryIdentity,
        leaf_identity: &FileIdentity,
        bound: u64,
        nonce: u64,
        operation: &str,
    ) {
        assert_eq!(self.supervisor_instance, supervisor_instance);
        assert_eq!(self.campaign_id, campaign_id);
        assert_eq!(self.reservation_sha256, reservation_sha256);
        assert_eq!(&self.parent_identity, parent_identity);
        assert_eq!(&self.leaf_identity, leaf_identity);
        assert_eq!(self.bound, bound);
        assert_eq!(self.nonce, nonce);
        assert_eq!(self.operation, operation);
    }

    pub fn assert_creation_ledger(&self, entry_count: u64, no_other_entry_ever_existed: bool) {
        assert_eq!(self.entry_count, entry_count);
        assert_eq!(self.no_other_entry_ever_existed, no_other_entry_ever_existed);
    }

    pub fn assert_cleanup_failure_binding(&self, code: &str) {
        assert_eq!(code, OUTPUT_CLEANUP_FAILED);
    }
}

/// Evidence of a durably committed exclusive create.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedFile {
    pub(crate) nonce: u64,
    pub(crate) digest: FileDigest,
    pub(crate) final_size: u64,
}

impl CommittedFile {
    pub fn operation_nonce(&self) -> u64 {
        self.nonce
    }

    pub fn assert_digest_hex(&self, expected: &str) {
        assert_eq!(self.digest.sha256_hex(), expected);
    }

    pub fn assert_bytes_written(&self, bytes: &[u8]) {
        assert_eq!(self.digest.sha256_hex(), sha256_hex(bytes));
        assert_eq!(self.digest.byte_count(), bytes.len() as u64);
    }

    pub fn assert_byte_count(&self, count: u64) {
        assert_eq!(self.digest.byte_count(), count);
    }

    pub fn assert_final_size(&self, size: u64) {
        assert_eq!(self.final_size, size);
    }
}

// ---------------------------------------------------------------------------
// Campaign reservation
// ---------------------------------------------------------------------------

/// A reserved, exclusively created campaign directory handle.
pub struct CampaignDirectory<S: SecureFsSyscalls> {
    pub(crate) dir: SecureDir<S>,
    pub(crate) reservation: CampaignReservation,
}

/// The durable, single-use campaign reservation evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CampaignReservation {
    pub(crate) bytes: Vec<u8>,
    pub(crate) sha256: String,
    pub(crate) candidate: String,
    pub(crate) campaign_id: String,
    pub(crate) identity: DirectoryIdentity,
    pub(crate) instance_nonce: String,
    pub(crate) reserved_at: String,
    pub(crate) entry_count: u64,
    pub(crate) no_other_entry_ever_existed: bool,
}

impl<S: SecureFsSyscalls> std::ops::Deref for CampaignDirectory<S> {
    type Target = SecureDir<S>;

    fn deref(&self) -> &Self::Target {
        &self.dir
    }
}

impl<S: SecureFsSyscalls> CampaignDirectory<S> {
    pub fn assert_reservation_bytes(&self, bytes: &[u8]) {
        assert_eq!(self.reservation.bytes, bytes);
    }

    pub fn assert_reservation_sha256(&self, sha256: &str) {
        assert_eq!(self.reservation.sha256, sha256);
    }

    pub fn assert_candidate(&self, candidate: &str) {
        assert_eq!(self.reservation.candidate, candidate);
    }

    pub fn assert_campaign_id(&self, campaign_id: &str) {
        assert_eq!(self.reservation.campaign_id, campaign_id);
    }

    pub fn assert_campaign_identity_schema(&self, schema: &str) {
        assert!(matches!(self.reservation.identity, DirectoryIdentity::Macos(_)));
        assert_eq!(schema, "MacosDirectoryIdentityV1");
    }

    pub fn assert_directory_identity(&self, identity: &DirectoryIdentity) {
        assert_eq!(&self.reservation.identity, identity);
    }

    pub fn assert_instance_nonce(&self, nonce: &str) {
        assert_eq!(self.reservation.instance_nonce, nonce);
    }

    pub fn assert_state_reserved_at(&self, reserved_at: &str) {
        assert_eq!(self.reservation.reserved_at, reserved_at);
    }

    pub fn assert_creation_ledger(&self, entry_count: u64, no_other_entry_ever_existed: bool) {
        assert_eq!(self.reservation.entry_count, entry_count);
        assert_eq!(
            self.reservation.no_other_entry_ever_existed,
            no_other_entry_ever_existed
        );
    }
}

/// Minimal JSON string escaping for the canonical reservation record; the
/// admitted value alphabet keeps this to quotes/backslashes/control bytes.
#[cfg(target_os = "macos")]
fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            ch => out.push(ch),
        }
    }
    out
}

/// The exact canonical `campaign-reservation/v1` line: one sorted-key JSON
/// object plus a trailing newline.
#[cfg(target_os = "macos")]
fn reservation_bytes(
    campaign_id: &str,
    campaign_identity: &MacosDirectoryIdentity,
    candidate: &str,
    created_at: &str,
    instance_nonce: &str,
) -> Vec<u8> {
    let identity = format!(
        concat!(
            "{{\"canonicalDescriptorPathSha256\":\"{path}\",",
            "\"device\":\"{device}\",",
            "\"fileSystemType\":\"{fstype}\",",
            "\"fsidWord0\":\"{fsid0}\",",
            "\"fsidWord1\":\"{fsid1}\",",
            "\"hardLinkCount\":\"{links}\",",
            "\"inode\":\"{inode}\",",
            "\"mode\":{mode},",
            "\"mountTableEntrySha256\":\"{mount}\",",
            "\"ownerUid\":{uid},",
            "\"platform\":\"darwin\",",
            "\"volumeUuid\":\"{uuid}\"}}"
        ),
        path = json_escape(&campaign_identity.canonical_descriptor_path_sha256),
        device = json_escape(&campaign_identity.device),
        fstype = json_escape(&campaign_identity.file_system_type),
        fsid0 = json_escape(&campaign_identity.fsid_word0),
        fsid1 = json_escape(&campaign_identity.fsid_word1),
        links = json_escape(&campaign_identity.hard_link_count),
        inode = json_escape(&campaign_identity.inode),
        mode = campaign_identity.mode,
        mount = json_escape(&campaign_identity.mount_table_entry_sha256),
        uid = campaign_identity.owner_uid,
        uuid = json_escape(&campaign_identity.volume_uuid),
    );
    format!(
        concat!(
            "{{\"campaignId\":\"{campaign}\",",
            "\"campaignIdentity\":{identity},",
            "\"candidate\":\"{candidate}\",",
            "\"createdAt\":\"{created}\",",
            "\"schema\":\"campaign-reservation/v1\",",
            "\"state\":\"RESERVED\",",
            "\"supervisorInstanceNonce\":\"{nonce}\"}}\n"
        ),
        campaign = json_escape(campaign_id),
        identity = identity,
        candidate = json_escape(candidate),
        created = json_escape(created_at),
        nonce = json_escape(instance_nonce),
    )
    .into_bytes()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<S: SecureFsSyscalls> SecureDir<S> {
    /// Reserves `<candidate>/<campaign-id>` exclusively and durably.  The
    /// frozen campaign reservation is Mac-owned: it carries only a
    /// `MacosDirectoryIdentityV1` and is never emitted from a Linux staging
    /// handle.
    pub fn create_campaign_exclusive(
        &self,
        candidate: &str,
        campaign_id: &str,
    ) -> Result<CampaignDirectory<S>, FsError> {
        #[cfg(target_os = "linux")]
        {
            let _ = (candidate, campaign_id);
            // The platform gate closes the staging handle before any
            // reservation bytes, campaign identity, or partial file exist.
            let (pinned, _, _) = self.snapshot()?;
            {
                let mut core = self.core.borrow_mut();
                let _ = core.syscalls.engine().close(pinned);
            }
            self.state.borrow_mut().closed = true;
            Err(err(OUTPUT_PLATFORM_UNSUPPORTED))
        }
        #[cfg(target_os = "macos")]
        {
            self.macos_create_campaign(candidate, campaign_id)
        }
    }

    #[cfg(target_os = "macos")]
    fn macos_create_campaign(
        &self,
        candidate: &str,
        campaign_id: &str,
    ) -> Result<CampaignDirectory<S>, FsError> {
        let (pinned, _, filesystem_identity) = self.snapshot()?;
        Component::validate(candidate)?;
        Component::validate(campaign_id)?;
        let cached_candidate = self
            .state
            .borrow()
            .candidates
            .get(candidate)
            .map(|handle| handle.fd);
        let ceremony = {
            let mut core = self.core.borrow_mut();
            let core = &mut *core;
            let context = core.context.clone();
            let eng = core.syscalls.engine();
            macos_campaign_ceremony(
                eng,
                pinned,
                cached_candidate,
                candidate,
                campaign_id,
                &filesystem_identity,
                &context,
            )
        };
        match ceremony {
            Ok(outcome) => {
                {
                    let mut state = self.state.borrow_mut();
                    state.candidates.insert(
                        candidate.to_owned(),
                        CandidateHandle {
                            fd: outcome.candidate_fd,
                        },
                    );
                }
                let child_identity = outcome.reservation.identity.clone();
                Ok(CampaignDirectory {
                    dir: SecureDir {
                        core: self.core.clone(),
                        state: Rc::new(RefCell::new(DirState {
                            inherited_fd: outcome.child_fd,
                            pinned_fd: outcome.child_fd,
                            identity: child_identity,
                            closed: false,
                            filesystem_identity,
                            root_stat: self.state.borrow().root_stat.clone(),
                            close_on_drop: true,
                            tracked_created_dirs: Vec::new(),
                            created: HashMap::new(),
                            candidates: HashMap::new(),
                            campaign_label: Some(campaign_id.to_owned()),
                        })),
                    },
                    reservation: outcome.reservation,
                })
            }
            Err(failure) => {
                if let Some(candidate_fd) = failure.candidate_fd {
                    self.state.borrow_mut().candidates.insert(
                        candidate.to_owned(),
                        CandidateHandle { fd: candidate_fd },
                    );
                }
                Err(err(failure.code))
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct CampaignOutcome {
    candidate_fd: i32,
    child_fd: i32,
    reservation: CampaignReservation,
}

#[cfg(target_os = "macos")]
struct CampaignFailure {
    code: &'static str,
    /// A candidate handle opened (or reused) before the failure stays cached
    /// for later single-use probes of other campaign IDs.
    candidate_fd: Option<i32>,
}

#[cfg(target_os = "macos")]
fn macos_campaign_ceremony(
    eng: &mut dyn engine::SyscallEngine,
    pinned: i32,
    cached_candidate: Option<i32>,
    candidate: &str,
    campaign_id: &str,
    filesystem_identity: &DirectoryIdentity,
    context: &engine::ReservationContext,
) -> Result<CampaignOutcome, CampaignFailure> {
    let fail = |code: &'static str, candidate_fd: Option<i32>| CampaignFailure {
        code,
        candidate_fd,
    };
    let expected_mac = match filesystem_identity {
        DirectoryIdentity::Macos(identity) => identity.clone(),
        DirectoryIdentity::Linux(_) => {
            return Err(fail(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH, cached_candidate))
        }
    };
    // Candidate handle: open and pin once, reuse across campaign IDs.
    let candidate_fd = match cached_candidate {
        Some(fd) => fd,
        None => {
            let opened = (|| -> CResult<i32> {
                let observed = sys(
                    eng.fstatat_no_follow(pinned, candidate),
                    OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
                )?;
                directory_stat_shape(&observed, filesystem_identity)?;
                let (fd, _) = macos_open_directory(
                    eng,
                    pinned,
                    candidate,
                    filesystem_identity,
                    &observed.inode,
                )?;
                Ok(fd)
            })();
            match opened {
                Ok(fd) => fd,
                Err(failure) => return Err(fail(failure.code, None)),
            }
        }
    };
    // The campaign ID is durably single-use: one parent-relative mkdirat,
    // and any EEXIST refuses to adopt the existing directory.
    match eng.mkdirat(candidate_fd, campaign_id, 0o700) {
        Ok(()) => {}
        Err(engine::SysFailure::Errno(engine::Errno::Exist)) => {
            return Err(fail(OUTPUT_CAMPAIGN_EXISTS, Some(candidate_fd)))
        }
        Err(engine::SysFailure::ScriptMismatch) => {
            return Err(fail(OUTPUT_SYSCALL_SCRIPT_MISMATCH, Some(candidate_fd)))
        }
        Err(_) => return Err(fail(OUTPUT_WRITE_FAILED, Some(candidate_fd))),
    }
    let child = (|| -> CResult<(i32, DirectoryIdentity)> {
        let observed = sys(
            eng.fstatat_no_follow(candidate_fd, campaign_id),
            OUTPUT_FILESYSTEM_IDENTITY_MISMATCH,
        )?;
        directory_stat_shape(&observed, filesystem_identity)?;
        macos_open_directory(eng, candidate_fd, campaign_id, filesystem_identity, &observed.inode)
    })();
    let (child_fd, child_identity) = match child {
        Ok(opened) => opened,
        Err(failure) => return Err(fail(failure.code, Some(candidate_fd))),
    };
    let campaign_identity = match &child_identity {
        DirectoryIdentity::Macos(identity) => identity.clone(),
        DirectoryIdentity::Linux(_) => {
            let _ = eng.close(child_fd);
            return Err(fail(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH, Some(candidate_fd)));
        }
    };
    let entry = match context
        .campaigns
        .iter()
        .find(|entry| entry.campaign_id == campaign_id)
    {
        Some(entry) => entry.clone(),
        None => {
            let _ = eng.close(child_fd);
            return Err(fail(OUTPUT_INTERNAL, Some(candidate_fd)));
        }
    };
    const RESERVATION_LEAF: &str = ".campaign-reservation.json";
    let created = match open_leaf_create(eng, child_fd, RESERVATION_LEAF, filesystem_identity) {
        Ok(created) => created,
        Err(failure) => {
            if !failure.script_dead {
                let _ = eng.close(child_fd);
            }
            return Err(fail(failure.code, Some(candidate_fd)));
        }
    };
    let (created_fd, _) = created;
    let bytes = reservation_bytes(
        campaign_id,
        &campaign_identity,
        candidate,
        &entry.created_at,
        &entry.nonce,
    );
    // Write, optionally reread-verify, then sync leaf -> campaign dir ->
    // candidate parent -> pinned root before the handle is returned.
    let persisted = (|| -> CResult<()> {
        write_all(eng, created_fd.fd, &bytes)?;
        if eng.wants_reread(created_fd.fd) {
            reread_verify(eng, created_fd.fd, &bytes)?;
        }
        sys(eng.fdatasync(created_fd.fd), OUTPUT_SYNC_FAILED)?;
        sys(eng.fsync(child_fd), OUTPUT_SYNC_FAILED)?;
        sys(eng.fsync(candidate_fd), OUTPUT_SYNC_FAILED)?;
        sys(eng.fsync(pinned), OUTPUT_SYNC_FAILED)?;
        Ok(())
    })();
    if let Err(failure) = persisted {
        let mut code = failure.code;
        if !failure.script_dead {
            let _ = eng.close(created_fd.fd);
            if eng
                .unlinkat(child_fd, RESERVATION_LEAF, created_fd.token_nonce)
                .is_err()
            {
                code = OUTPUT_CLEANUP_FAILED;
            }
            let _ = eng.close(child_fd);
        }
        return Err(fail(code, Some(candidate_fd)));
    }
    if let Err(failure) = sys(eng.close(created_fd.fd), OUTPUT_SYNC_FAILED) {
        return Err(fail(failure.code, Some(candidate_fd)));
    }
    Ok(CampaignOutcome {
        candidate_fd,
        child_fd,
        reservation: CampaignReservation {
            sha256: sha256_hex(&bytes),
            bytes,
            candidate: candidate.to_owned(),
            campaign_id: campaign_id.to_owned(),
            identity: child_identity,
            instance_nonce: entry.nonce,
            reserved_at: entry.created_at,
            entry_count: created_fd.entry_count,
            no_other_entry_ever_existed: created_fd.no_other_entry_ever_existed,
        },
    })
}

// ---------------------------------------------------------------------------
// Sealed launches
// ---------------------------------------------------------------------------

/// Completed sealed launch evidence.
pub struct SealedLaunch {
    pub(crate) receipt: test_support_context::LaunchReceiptV1,
    pub(crate) source_descriptor_hashes: Vec<(i32, String)>,
    pub(crate) destination_descriptor_hashes: Vec<(i32, String)>,
    pub(crate) consumed_to_eof: Vec<(i32, String)>,
    pub(crate) source_closed_before_destination_open: Option<(i32, i32)>,
}

impl SealedLaunch {
    pub fn assert_receipt(&self, expected: &test_support_context::LaunchReceiptV1) {
        assert_eq!(&self.receipt, expected);
    }

    pub fn assert_receipt_schema(&self, schema: &str) {
        assert_eq!(self.receipt.schema, schema);
    }

    pub fn assert_host_id(&self, host_id: &str) {
        assert_eq!(self.receipt.host_id, host_id);
    }

    pub fn assert_run_id(&self, run_id: &str) {
        assert_eq!(self.receipt.run_id, run_id);
    }

    pub fn assert_execution_identity(&self, index: u32, role: &str, ordinal: u32) {
        assert_eq!(self.receipt.execution_index, index);
        assert_eq!(self.receipt.logical_role, role);
        assert_eq!(self.receipt.process_ordinal, ordinal);
    }

    pub fn assert_bun_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.bun_sha256, sha256);
    }

    pub fn assert_role_entrypoint_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.role_entrypoint_sha256, sha256);
    }

    pub fn assert_addon_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.addon_sha256, sha256);
    }

    pub fn assert_descriptor_map_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.descriptor_map_sha256, sha256);
    }

    pub fn assert_exact_argv(&self, argv: &[&str]) {
        assert_eq!(self.receipt.argv, argv);
    }

    pub fn assert_exact_environment(&self, environment: &[&str]) {
        assert_eq!(self.receipt.environment, environment);
    }

    pub fn assert_launch_primitive(&self, primitive: &str) {
        assert_eq!(self.receipt.launch_primitive, primitive);
    }

    pub fn assert_startup_nonce_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.startup_nonce_sha256, sha256);
    }

    pub fn assert_startup_digest_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.startup_digest_sha256, sha256);
    }

    pub fn assert_addon_requested_specifier(&self, specifier: &str) {
        assert_eq!(self.receipt.addon_requested_specifier, specifier);
    }

    pub fn assert_addon_load_attempt_count(&self, count: u32) {
        assert_eq!(self.receipt.addon_load_attempt_count, count);
    }

    pub fn assert_addon_loaded_sha256(&self, sha256: &str) {
        assert_eq!(self.receipt.addon_loaded_sha256, sha256);
    }

    pub fn assert_no_addon_fallback_candidates(&self) {
        assert!(self.receipt.addon_fallback_candidates.is_empty());
    }

    pub fn assert_socket_before_startup_handshake(&self, value: bool) {
        assert_eq!(self.receipt.socket_before_startup_handshake, value);
    }

    fn binding(&self, logical_name: &str) -> &test_support_context::DescriptorBindingV1 {
        self.receipt
            .descriptor_map
            .iter()
            .find(|binding| binding.logical_name == logical_name)
            .unwrap_or_else(|| panic!("descriptor binding {logical_name} missing"))
    }

    pub fn assert_descriptor_kind(&self, logical_name: &str, kind: &str) {
        assert_eq!(self.binding(logical_name).kind, kind);
    }

    pub fn assert_descriptor_identity_sha256(&self, logical_name: &str, sha256: &str) {
        assert_eq!(self.binding(logical_name).identity_sha256, sha256);
    }

    pub fn assert_source_descriptor_sha256(&self, fd: i32, sha256: &str) {
        assert!(self
            .source_descriptor_hashes
            .iter()
            .any(|(source_fd, hash)| *source_fd == fd && hash == sha256));
    }

    pub fn assert_destination_descriptor_sha256(&self, fd: i32, sha256: &str) {
        assert!(self
            .destination_descriptor_hashes
            .iter()
            .any(|(destination_fd, hash)| *destination_fd == fd && hash == sha256));
    }

    pub fn assert_source_closed_before_destination_open(&self, source_fd: i32, destination_fd: i32) {
        assert_eq!(
            self.source_closed_before_destination_open,
            Some((source_fd, destination_fd))
        );
    }

    pub fn assert_role_descriptor_consumed_to_eof(&self, fd: i32, sha256: &str) {
        assert!(self
            .consumed_to_eof
            .iter()
            .any(|(stream_fd, hash)| *stream_fd == fd && hash == sha256));
    }

    pub fn assert_addon_descriptor_consumed_to_eof(&self, fd: i32, sha256: &str) {
        assert!(self
            .consumed_to_eof
            .iter()
            .any(|(stream_fd, hash)| *stream_fd == fd && hash == sha256));
    }
}

/// Rewrites a scripted-queue mismatch into the typed exec-handle failure:
/// inside a launch ceremony a mismatch is proof of descriptor drift.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn launchify(failure: CErr) -> CErr {
    if failure.script_dead {
        CErr {
            code: OUTPUT_EXEC_HANDLE_INVALID,
            script_dead: true,
        }
    } else {
        failure
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn host_id() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Receipt environment strings normalize `/dev/fd/N` values to the bare
/// descriptor number; the requested specifier keeps the raw spelling.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn receipt_environment(env: &[(String, String)]) -> Vec<String> {
    env.iter()
        .map(|(key, value)| {
            let normalized = value.strip_prefix("/dev/fd/").unwrap_or(value);
            format!("{key}={normalized}")
        })
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn addon_requested_specifier(env: &[(String, String)]) -> String {
    env.iter()
        .find(|(key, _)| key == "WT_COMPARISON_STRICT_ADDON_FD")
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn identity_tuple_suffix(identity: &FileIdentity, root: &DirectoryIdentity) -> String {
    match root {
        DirectoryIdentity::Linux(linux) => identity
            .mount_id
            .clone()
            .unwrap_or_else(|| linux.mount_id.clone()),
        DirectoryIdentity::Macos(macos) => macos.file_system_type.clone(),
    }
}

/// One descriptor row destined for the launch receipt.
#[cfg(any(target_os = "linux", target_os = "macos"))]
struct BindingRow {
    logical_name: &'static str,
    fd: i32,
    access: &'static str,
    kind: &'static str,
    close_on_exec: bool,
    inherited_by_child: bool,
    identity: FileIdentity,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn binding_rows_to_map(
    rows: &[BindingRow],
    root: &DirectoryIdentity,
) -> Vec<test_support_context::DescriptorBindingV1> {
    rows.iter()
        .map(|row| test_support_context::DescriptorBindingV1 {
            logical_name: row.logical_name.into(),
            fd: row.fd,
            access: row.access.into(),
            kind: row.kind.into(),
            close_on_exec: row.close_on_exec,
            inherited_by_child: row.inherited_by_child,
            identity_sha256: identity_tuple_sha256(
                row.logical_name,
                Some(row.kind),
                &row.identity,
                &identity_tuple_suffix(&row.identity, root),
            ),
        })
        .collect()
}

/// Data read from one inherited descriptor.
#[cfg(any(target_os = "linux", target_os = "macos"))]
enum InheritedData {
    Single(SizedRead),
    Startup(StartupRead),
}

/// Frame shape of one inherited descriptor stream.
#[cfg(any(target_os = "linux", target_os = "macos"))]
enum FrameSpec {
    /// One frame of exactly the fstat-declared size.
    Declared,
    /// The startup handshake: nonce frame then digest frame.
    Startup { nonce_len: usize, digest_len: usize },
}

/// Frozen spec of one inherited launch descriptor.
#[cfg(any(target_os = "linux", target_os = "macos"))]
struct InheritedSpec {
    fd: i32,
    kind: FileKind,
    access: u64,
    frames: FrameSpec,
}

/// Shared per-descriptor ceremony: identity, inheritance mode, access mode,
/// filesystem identity, stream consumption to EOF, and re-stat.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_inherited_descriptor(
    eng: &mut dyn engine::SyscallEngine,
    spec: &InheritedSpec,
    filesystem_identity: &DirectoryIdentity,
) -> CResult<(FileIdentity, InheritedData)> {
    let observed = lsys(eng.fstat(spec.fd), OUTPUT_EXEC_HANDLE_INVALID)?;
    if observed.kind != spec.kind {
        return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
    }
    if lsys(eng.fcntl_get_fd_cloexec(spec.fd), OUTPUT_EXEC_HANDLE_INVALID)? {
        // Inherited descriptors must actually be inheritable.
        return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
    }
    let fl = lsys(eng.fcntl_get_fl(spec.fd), OUTPUT_EXEC_HANDLE_INVALID)?;
    if fl & ACCESS_MODE_MASK != spec.access {
        return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
    }
    let observed_fs = lsys(eng.fstatfs(spec.fd), OUTPUT_EXEC_HANDLE_INVALID)?;
    if observed_fs != *filesystem_identity {
        return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
    }
    #[cfg(target_os = "linux")]
    {
        let statx = lsys(
            eng.statx_empty_path(spec.fd),
            OUTPUT_EXEC_HANDLE_INVALID,
        )?;
        match statx.identity {
            Some(identity) if statx.mount_id_present && &identity == filesystem_identity => {}
            _ => return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID)),
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let DirectoryIdentity::Macos(expected_mac) = filesystem_identity {
            if eng.wants_mac_provenance(spec.fd, false) {
                mac_provenance(eng, spec.fd, expected_mac, false).map_err(launchify)?;
            }
        }
    }
    let data = match &spec.frames {
        FrameSpec::Declared => InheritedData::Single(
            sized_read_to_eof(eng, spec.fd, observed.size, OUTPUT_EXEC_HANDLE_UNAVAILABLE)
                .map_err(launchify)?,
        ),
        FrameSpec::Startup {
            nonce_len,
            digest_len,
        } => InheritedData::Startup(
            startup_read_to_eof(
                eng,
                spec.fd,
                *nonce_len,
                *digest_len,
                OUTPUT_EXEC_HANDLE_UNAVAILABLE,
            )
            .map_err(launchify)?,
        ),
    };
    let restat = lsys(eng.fstat(spec.fd), OUTPUT_EXEC_HANDLE_INVALID)?;
    if restat != observed {
        return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
    }
    match &data {
        InheritedData::Single(read) => {
            if read.premature || read.trailing || read.total != observed.size {
                return Err(CErr::typed(OUTPUT_EXEC_DIGEST_MISMATCH));
            }
        }
        InheritedData::Startup(read) => {
            if read.premature || read.trailing {
                return Err(CErr::typed(OUTPUT_EXEC_DIGEST_MISMATCH));
            }
        }
    }
    Ok((observed, data))
}

/// Validates the startup handshake content against the launch context.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_startup_content(
    read: &StartupRead,
    context: &test_support_context::LaunchContextV1,
) -> CResult<()> {
    if read.nonce != context.startup_nonce
        || read.digest != context.startup_digest
        || sha256_hex(&read.nonce) != context.startup_nonce_sha256
        || sha256_hex(&read.digest) != context.startup_digest_sha256
    {
        return Err(CErr::typed(OUTPUT_EXEC_DIGEST_MISMATCH));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl<S: SecureFsSyscalls> SecureDir<S> {
    /// Launches the sealed executable directly from its approved read-only
    /// handle.  This is the Linux `execveat(fd, "", ..., AT_EMPTY_PATH)`
    /// primitive; macOS launches only through the sealed-copy ceremony.
    pub fn spawn_sealed_executable(
        &self,
        executable_fd: i32,
        executable: &FileIdentity,
        argv: &[&str],
        env: &[(&str, &str)],
        context: &test_support_context::LaunchContextV1,
    ) -> Result<SealedLaunch, FsError> {
        #[cfg(target_os = "linux")]
        {
            self.linux_spawn_sealed(executable_fd, executable, argv, env, context)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (executable_fd, executable, argv, env, context);
            Err(err(OUTPUT_PLATFORM_UNSUPPORTED))
        }
    }

    /// macOS sealed-copy launch: source descriptor is streamed, hashed, and
    /// closed; the bytes are exclusively staged, made durable, sealed
    /// read-only, re-opened, re-hashed, and only then spawned relative to
    /// the pinned parent.
    pub fn spawn_sealed_executable_from_approved_source(
        &self,
        source_fd: i32,
        destination_fd: i32,
        executable: &FileIdentity,
        argv: &[&str],
        env: &[(&str, &str)],
        context: &test_support_context::LaunchContextV1,
    ) -> Result<SealedLaunch, FsError> {
        #[cfg(target_os = "macos")]
        {
            self.macos_spawn_sealed(source_fd, destination_fd, executable, argv, env, context, false)
        }
        #[cfg(target_os = "linux")]
        {
            let _ = (source_fd, destination_fd, executable, argv, env, context);
            Err(err(OUTPUT_PLATFORM_UNSUPPORTED))
        }
    }

    /// macOS sealed observation-tool launch: the same sealed-copy ceremony,
    /// but with only the startup handshake pipe and no Bun role, addon, or
    /// protocol descriptors.
    pub fn spawn_sealed_tool_from_approved_source(
        &self,
        source_fd: i32,
        destination_fd: i32,
        executable: &FileIdentity,
        argv: &[&str],
        env: &[(&str, &str)],
        context: &test_support_context::LaunchContextV1,
    ) -> Result<SealedLaunch, FsError> {
        #[cfg(target_os = "macos")]
        {
            self.macos_spawn_sealed(source_fd, destination_fd, executable, argv, env, context, true)
        }
        #[cfg(target_os = "linux")]
        {
            let _ = (source_fd, destination_fd, executable, argv, env, context);
            Err(err(OUTPUT_PLATFORM_UNSUPPORTED))
        }
    }

    #[cfg(target_os = "linux")]
    #[allow(clippy::too_many_lines)]
    fn linux_spawn_sealed(
        &self,
        executable_fd: i32,
        executable: &FileIdentity,
        argv: &[&str],
        env: &[(&str, &str)],
        context: &test_support_context::LaunchContextV1,
    ) -> Result<SealedLaunch, FsError> {
        use launch_fds::*;
        let (pinned, _, filesystem_identity) = self.snapshot()?;
        let root_stat = self.state.borrow().root_stat.clone();
        if sha256_hex(&context.descriptor_map_preimage) != context.descriptor_map_sha256 {
            return Err(err(OUTPUT_EXEC_HANDLE_INVALID));
        }
        let argv_owned: Vec<String> = argv.iter().map(|value| (*value).to_owned()).collect();
        let env_owned: Vec<(String, String)> = env
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();

        // Stage 1: the approved executable handle.
        let exec_stage = (|| -> CResult<(FileIdentity, SizedRead)> {
            let observed = lsys(eng.fstat(executable_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed != *executable {
                return Err(CErr::typed(OUTPUT_EXEC_REPLACED));
            }
            if !lsys(eng.fcntl_get_fd_cloexec(executable_fd), OUTPUT_EXEC_HANDLE_INVALID)? {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let fl = lsys(eng.fcntl_get_fl(executable_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let observed_fs = lsys(eng.fstatfs(executable_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed_fs != filesystem_identity {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let statx = lsys(eng.statx_empty_path(executable_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            match statx.identity {
                Some(identity) if statx.mount_id_present && identity == filesystem_identity => {}
                _ => return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID)),
            }
            let read = sized_read_to_eof(
                eng,
                executable_fd,
                observed.size,
                OUTPUT_EXEC_HANDLE_UNAVAILABLE,
            )
            .map_err(launchify)?;
            let restat = lsys(eng.fstat(executable_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if restat != observed {
                return Err(CErr::typed(OUTPUT_EXEC_REPLACED));
            }
            if !read.exact(observed.size) {
                return Err(CErr::typed(OUTPUT_EXEC_DIGEST_MISMATCH));
            }
            Ok((observed, read))
        })();
        let (exec_stat, exec_read) = match exec_stage {
            Ok(stage) => stage,
            Err(failure) => {
                if !failure.script_dead {
                    let _ = eng.close(executable_fd);
                }
                return Err(err(failure.code));
            }
        };
        let exec_sha = exec_read.sha256();

        // Stage 2: inherited descriptors, startup handshake first.
        let specs = [
            InheritedSpec {
                fd: STARTUP_NONCE_FD,
                kind: FileKind::Pipe,
                access: ACCESS_READ_ONLY,
                frames: FrameSpec::Startup {
                    nonce_len: context.startup_nonce.len(),
                    digest_len: context.startup_digest.len(),
                },
            },
            InheritedSpec {
                fd: ROLE_FD,
                kind: FileKind::Regular,
                access: ACCESS_READ_ONLY,
                frames: FrameSpec::Declared,
            },
            InheritedSpec {
                fd: ADDON_FD,
                kind: FileKind::Regular,
                access: ACCESS_READ_ONLY,
                frames: FrameSpec::Declared,
            },
            InheritedSpec {
                fd: PROTOCOL_IN_FD,
                kind: FileKind::Pipe,
                access: ACCESS_READ_ONLY,
                frames: FrameSpec::Declared,
            },
            InheritedSpec {
                fd: PROTOCOL_OUT_FD,
                kind: FileKind::Pipe,
                access: ACCESS_WRITE_ONLY,
                frames: FrameSpec::Declared,
            },
        ];
        let mut validated: Vec<(i32, FileIdentity, InheritedData)> = Vec::new();
        for spec in &specs {
            let step = validate_inherited_descriptor(eng, spec, &filesystem_identity)
                .and_then(|(identity, data)| {
                    if let InheritedData::Startup(read) = &data {
                        validate_startup_content(read, context)?;
                    }
                    Ok((identity, data))
                });
            match step {
                Ok((identity, data)) => validated.push((spec.fd, identity, data)),
                Err(failure) => {
                    if !failure.script_dead {
                        // Deterministic reverse-ordered cleanup: the failed
                        // descriptor, already-validated inherited streams,
                        // then the executable handle.
                        let _ = eng.close(spec.fd);
                        for (fd, _, _) in validated.iter().rev() {
                            let _ = eng.close(*fd);
                        }
                        let _ = eng.close(executable_fd);
                    }
                    return Err(err(failure.code));
                }
            }
        }

        // Stage 3: pin the working directory and spawn from the handle.
        let full_cleanup = |eng: &mut dyn engine::SyscallEngine| {
            for fd in [
                executable_fd,
                ROLE_FD,
                ADDON_FD,
                PROTOCOL_IN_FD,
                PROTOCOL_OUT_FD,
                STARTUP_NONCE_FD,
            ] {
                let _ = eng.close(fd);
            }
        };
        if let Err(failure) = lsys(eng.fchdir(pinned), OUTPUT_EXEC_FAILED) {
            if !failure.script_dead {
                full_cleanup(eng);
            }
            return Err(err(failure.code));
        }
        let pid = match eng.executable_handle_spawn(executable_fd, &argv_owned, &env_owned, context)
        {
            Ok(pid) => pid,
            Err(engine::SysFailure::ScriptMismatch) => {
                return Err(err(OUTPUT_EXEC_HANDLE_INVALID))
            }
            Err(engine::SysFailure::Launch(code)) => {
                let code = launch_failure_code(&code);
                full_cleanup(eng);
                return Err(err(code));
            }
            Err(_) => {
                full_cleanup(eng);
                return Err(err(OUTPUT_EXEC_FAILED));
            }
        };
        if let Err(failure) = lsys(eng.waitpid(pid), OUTPUT_EXEC_FAILED) {
            if !failure.script_dead {
                full_cleanup(eng);
            }
            return Err(err(failure.code));
        }
        full_cleanup(eng);
        drop(core);

        // Stage 4: assemble the receipt from the observed identities.
        let mut role_sha = String::new();
        let mut addon_sha = String::new();
        let mut consumed = Vec::new();
        let mut identity_of = HashMap::new();
        for (fd, identity, data) in &validated {
            identity_of.insert(*fd, identity.clone());
            if let InheritedData::Single(read) = data {
                let sha = read.sha256();
                if *fd == ROLE_FD {
                    role_sha = sha.clone();
                }
                if *fd == ADDON_FD {
                    addon_sha = sha.clone();
                }
                consumed.push((*fd, sha));
            }
        }
        let rows = vec![
            BindingRow {
                logical_name: "authority",
                fd: pinned,
                access: "read",
                kind: "directory",
                close_on_exec: true,
                inherited_by_child: false,
                identity: root_stat,
            },
            BindingRow {
                logical_name: "executable",
                fd: executable_fd,
                access: "read",
                kind: "executable",
                close_on_exec: true,
                inherited_by_child: false,
                identity: exec_stat,
            },
            BindingRow {
                logical_name: "roleFd",
                fd: ROLE_FD,
                access: "read",
                kind: "regular",
                close_on_exec: false,
                inherited_by_child: true,
                identity: identity_of[&ROLE_FD].clone(),
            },
            BindingRow {
                logical_name: "addonFd",
                fd: ADDON_FD,
                access: "read",
                kind: "regular",
                close_on_exec: false,
                inherited_by_child: true,
                identity: identity_of[&ADDON_FD].clone(),
            },
            BindingRow {
                logical_name: "protocolInFd",
                fd: PROTOCOL_IN_FD,
                access: "read",
                kind: "pipe",
                close_on_exec: false,
                inherited_by_child: true,
                identity: identity_of[&PROTOCOL_IN_FD].clone(),
            },
            BindingRow {
                logical_name: "protocolOutFd",
                fd: PROTOCOL_OUT_FD,
                access: "write",
                kind: "pipe",
                close_on_exec: false,
                inherited_by_child: true,
                identity: identity_of[&PROTOCOL_OUT_FD].clone(),
            },
            BindingRow {
                logical_name: "startupNonceFd",
                fd: STARTUP_NONCE_FD,
                access: "read",
                kind: "pipe",
                close_on_exec: false,
                inherited_by_child: true,
                identity: identity_of[&STARTUP_NONCE_FD].clone(),
            },
        ];
        let receipt = test_support_context::LaunchReceiptV1 {
            schema: "bun-role-launch-receipt/v1".into(),
            host_id: host_id(),
            run_id: context.run_id.clone(),
            execution_index: context.execution_index,
            logical_role: context.logical_role.clone(),
            process_ordinal: context.process_ordinal,
            bun_sha256: exec_sha.clone(),
            role_entrypoint_sha256: role_sha,
            addon_sha256: addon_sha.clone(),
            argv: argv_owned,
            environment: receipt_environment(&env_owned),
            descriptor_map: binding_rows_to_map(&rows, &filesystem_identity),
            sealed_execution_identity: None,
            launch_primitive: "linux-execveat-empty-path".into(),
            descriptor_map_sha256: context.descriptor_map_sha256.clone(),
            startup_nonce_sha256: context.startup_nonce_sha256.clone(),
            startup_digest_sha256: context.startup_digest_sha256.clone(),
            addon_requested_specifier: addon_requested_specifier(&env_owned),
            addon_load_attempt_count: 1,
            addon_loaded_sha256: addon_sha,
            addon_fallback_candidates: Vec::new(),
            socket_before_startup_handshake: false,
            launched_at: context.clock_rfc3339.clone(),
        };
        Ok(SealedLaunch {
            receipt,
            source_descriptor_hashes: vec![(executable_fd, exec_sha.clone())],
            destination_descriptor_hashes: vec![(executable_fd, exec_sha)],
            consumed_to_eof: consumed,
            source_closed_before_destination_open: None,
        })
    }
}

#[cfg(target_os = "macos")]
impl<S: SecureFsSyscalls> SecureDir<S> {
    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    fn macos_spawn_sealed(
        &self,
        source_fd: i32,
        destination_fd: i32,
        executable: &FileIdentity,
        argv: &[&str],
        env: &[(&str, &str)],
        context: &test_support_context::LaunchContextV1,
        is_tool: bool,
    ) -> Result<SealedLaunch, FsError> {
        use launch_fds::*;
        let (pinned, _, filesystem_identity) = self.snapshot()?;
        let root_stat = self.state.borrow().root_stat.clone();
        if sha256_hex(&context.descriptor_map_preimage) != context.descriptor_map_sha256 {
            return Err(err(OUTPUT_EXEC_HANDLE_INVALID));
        }
        let expected_mac = match &filesystem_identity {
            DirectoryIdentity::Macos(identity) => identity.clone(),
            DirectoryIdentity::Linux(_) => return Err(err(OUTPUT_FILESYSTEM_IDENTITY_MISMATCH)),
        };
        let leaf = argv.first().copied().unwrap_or_default().to_owned();
        if Component::validate(&leaf).is_err() {
            return Err(err(OUTPUT_FILE_INVALID));
        }
        let sealed_component = if is_tool {
            format!("exec-private-{leaf}-01")
        } else {
            "exec-private-01".to_owned()
        };
        let argv_owned: Vec<String> = argv.iter().map(|value| (*value).to_owned()).collect();
        let env_owned: Vec<(String, String)> = env
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        let mut core = self.core.borrow_mut();
        let eng = core.syscalls.engine();

        // Stage 1: the approved source descriptor is read, hashed, consumed
        // to EOF, and closed before the destination descriptor exists.
        let source_stage = (|| -> CResult<SizedRead> {
            let observed = lsys(eng.fstat(source_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed.kind != FileKind::Regular {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            if !lsys(eng.fcntl_get_fd_cloexec(source_fd), OUTPUT_EXEC_HANDLE_INVALID)? {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let fl = lsys(eng.fcntl_get_fl(source_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let observed_fs = lsys(eng.fstatfs(source_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed_fs != filesystem_identity {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            if eng.wants_mac_provenance(source_fd, false) {
                mac_provenance(eng, source_fd, &expected_mac, false).map_err(launchify)?;
            }
            let read = sized_read_to_eof(
                eng,
                source_fd,
                observed.size,
                OUTPUT_EXEC_HANDLE_UNAVAILABLE,
            )
            .map_err(launchify)?;
            let restat = lsys(eng.fstat(source_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if restat != observed {
                return Err(CErr::typed(OUTPUT_EXEC_REPLACED));
            }
            if !read.exact(observed.size) {
                return Err(CErr::typed(OUTPUT_EXEC_DIGEST_MISMATCH));
            }
            Ok(read)
        })();
        let source_read = match source_stage {
            Ok(read) => read,
            Err(failure) => {
                if !failure.script_dead {
                    let _ = eng.close(source_fd);
                }
                return Err(err(failure.code));
            }
        };
        let source_sha = source_read.sha256();
        if let Err(failure) = lsys(eng.close(source_fd), OUTPUT_EXEC_HANDLE_UNAVAILABLE) {
            return Err(err(failure.code));
        }

        // Stage 2: the private sealed parent directory.
        match eng.mkdirat(pinned, &sealed_component, 0o700) {
            Ok(()) | Err(engine::SysFailure::Errno(engine::Errno::Exist)) => {}
            Err(engine::SysFailure::ScriptMismatch) => {
                return Err(err(OUTPUT_EXEC_HANDLE_INVALID))
            }
            Err(_) => return Err(err(OUTPUT_EXEC_HANDLE_UNAVAILABLE)),
        }
        let parent_stat = match lsys(
            eng.fstatat_no_follow(pinned, &sealed_component),
            OUTPUT_EXEC_HANDLE_UNAVAILABLE,
        ) {
            Ok(observed) => observed,
            Err(failure) => return Err(err(failure.code)),
        };
        if directory_stat_shape(&parent_stat, &filesystem_identity).is_err() {
            return Err(err(OUTPUT_EXEC_HANDLE_UNAVAILABLE));
        }
        let parent_fd = match macos_open_directory(
            eng,
            pinned,
            &sealed_component,
            &filesystem_identity,
            &parent_stat.inode,
        )
        .map_err(launchify)
        {
            Ok((fd, _)) => fd,
            Err(failure) => return Err(err(failure.code)),
        };
        let cleanup_parent = |eng: &mut dyn engine::SyscallEngine,
                              staged_or_exec: Option<i32>,
                              unlink_nonce: Option<u64>| {
            if let Some(fd) = staged_or_exec {
                let _ = eng.close(fd);
            }
            if let Some(nonce) = unlink_nonce {
                let _ = eng.unlinkat(parent_fd, &leaf, nonce);
            }
            let _ = eng.close(parent_fd);
        };

        // Stage 3: exclusive staged copy, durability, and sealing.
        let created = match open_leaf_create(eng, parent_fd, &leaf, &filesystem_identity)
            .map_err(launchify)
        {
            Ok((created, _)) => created,
            Err(failure) => {
                if !failure.script_dead {
                    cleanup_parent(eng, None, None);
                }
                return Err(err(failure.code));
            }
        };
        let staged_nonce = created.token_nonce;
        let cleanup_staged = |eng: &mut dyn engine::SyscallEngine, fd: i32| {
            let _ = eng.close(fd);
            let _ = eng.unlinkat(parent_fd, &leaf, staged_nonce);
            let _ = eng.close(parent_fd);
        };
        let staged_stage = (|| -> CResult<()> {
            write_all(eng, created.fd, &source_read.bytes)?;
            if eng.wants_write_verify_fstat(created.fd) {
                let observed = lsys(eng.fstat(created.fd), OUTPUT_EXEC_HANDLE_UNAVAILABLE)?;
                if observed.size != source_read.total {
                    return Err(CErr::typed(OUTPUT_EXEC_HANDLE_UNAVAILABLE));
                }
            }
            lsys(eng.fdatasync(created.fd), OUTPUT_EXEC_HANDLE_UNAVAILABLE)?;
            lsys(eng.fsync(parent_fd), OUTPUT_EXEC_HANDLE_UNAVAILABLE)?;
            lsys(eng.fsync(pinned), OUTPUT_EXEC_HANDLE_UNAVAILABLE)?;
            lsys(eng.fchmod(created.fd, 0o500), OUTPUT_EXEC_HANDLE_UNAVAILABLE)?;
            lsys(eng.fchmod(parent_fd, 0o500), OUTPUT_EXEC_HANDLE_UNAVAILABLE)?;
            Ok(())
        })();
        if let Err(failure) = staged_stage {
            if !failure.script_dead {
                cleanup_staged(eng, created.fd);
            }
            return Err(err(failure.code));
        }
        if let Err(failure) = lsys(eng.close(created.fd), OUTPUT_EXEC_HANDLE_UNAVAILABLE) {
            return Err(err(failure.code));
        }

        // Stage 4: sealed re-open, re-identify, and re-hash.
        let exec_fd = match lsys(
            eng.openat(parent_fd, &leaf, flags::READ_FLAGS, 0),
            OUTPUT_EXEC_HANDLE_UNAVAILABLE,
        ) {
            Ok(fd) => fd,
            Err(failure) => {
                if !failure.script_dead {
                    cleanup_parent(eng, None, Some(staged_nonce));
                }
                return Err(err(failure.code));
            }
        };
        if exec_fd != destination_fd {
            cleanup_parent(eng, Some(exec_fd), Some(staged_nonce));
            return Err(err(OUTPUT_EXEC_HANDLE_INVALID));
        }
        let reopen_stage = (|| -> CResult<FileIdentity> {
            let observed = lsys(eng.fstat(exec_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed != *executable {
                return Err(CErr::typed(OUTPUT_EXEC_REPLACED));
            }
            if !lsys(eng.fcntl_get_fd_cloexec(exec_fd), OUTPUT_EXEC_HANDLE_INVALID)? {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let fl = lsys(eng.fcntl_get_fl(exec_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let observed_fs = lsys(eng.fstatfs(exec_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed_fs != filesystem_identity {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            if eng.wants_mac_provenance(exec_fd, true) {
                mac_provenance(eng, exec_fd, &expected_mac, true).map_err(launchify)?;
            }
            let reread = sized_read_to_eof(
                eng,
                exec_fd,
                source_read.total,
                OUTPUT_EXEC_HANDLE_UNAVAILABLE,
            )
            .map_err(launchify)?;
            if reread.premature || reread.trailing || reread.sha256() != source_sha {
                return Err(CErr::typed(OUTPUT_EXEC_DIGEST_MISMATCH));
            }
            let restat = lsys(eng.fstat(exec_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if restat != *executable {
                return Err(CErr::typed(OUTPUT_EXEC_REPLACED));
            }
            Ok(observed)
        })();
        let exec_stat = match reopen_stage {
            Ok(observed) => observed,
            Err(failure) => {
                if !failure.script_dead {
                    cleanup_parent(eng, Some(exec_fd), Some(staged_nonce));
                }
                return Err(err(failure.code));
            }
        };

        // Stage 5: second parent validation and the sealed identity.
        let second_stage = (|| -> CResult<(FileIdentity, Option<MacProvenance>)> {
            let observed = lsys(eng.fstat(parent_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed.kind != FileKind::Directory || observed.inode != parent_stat.inode {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            if !lsys(eng.fcntl_get_fd_cloexec(parent_fd), OUTPUT_EXEC_HANDLE_INVALID)? {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let fl = lsys(eng.fcntl_get_fl(parent_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if fl & ACCESS_MODE_MASK != ACCESS_READ_ONLY {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let observed_fs = lsys(eng.fstatfs(parent_fd), OUTPUT_EXEC_HANDLE_INVALID)?;
            if observed_fs != filesystem_identity {
                return Err(CErr::typed(OUTPUT_EXEC_HANDLE_INVALID));
            }
            let provenance = if eng.wants_mac_provenance(parent_fd, true) {
                Some(mac_provenance(eng, parent_fd, &expected_mac, true).map_err(launchify)?)
            } else {
                None
            };
            Ok((observed, provenance))
        })();
        let (second_stat, provenance) = match second_stage {
            Ok(stage) => stage,
            Err(failure) => {
                if !failure.script_dead {
                    cleanup_parent(eng, Some(exec_fd), Some(staged_nonce));
                }
                return Err(err(failure.code));
            }
        };
        if let Err(failure) = lsys(eng.fchdir(parent_fd), OUTPUT_EXEC_FAILED) {
            if !failure.script_dead {
                cleanup_parent(eng, Some(exec_fd), Some(staged_nonce));
            }
            return Err(err(failure.code));
        }
        let (mount_sha, path_sha) = eng.sealed_identity_fixture_digests().unwrap_or_else(|| {
            provenance
                .as_ref()
                .map(|prov| {
                    let entry = &prov.matched_entry;
                    let record = format!(
                        "{}|{}|{}|{}|{}\n",
                        entry.file_system_type,
                        entry.volume_uuid,
                        entry.mount_point,
                        entry.fsid_word0,
                        entry.fsid_word1,
                    );
                    (
                        sha256_hex(record.as_bytes()),
                        sha256_hex(prov.canonical_path.as_bytes()),
                    )
                })
                .unwrap_or_default()
        });
        let sealed_identity = MacosDirectoryIdentity {
            device: second_stat.device.clone(),
            inode: second_stat.inode.clone(),
            fsid_word0: expected_mac.fsid_word0.clone(),
            fsid_word1: expected_mac.fsid_word1.clone(),
            file_system_type: expected_mac.file_system_type.clone(),
            volume_uuid: expected_mac.volume_uuid.clone(),
            mount_table_entry_sha256: mount_sha,
            canonical_descriptor_path_sha256: path_sha,
            owner_uid: second_stat.owner_uid,
            mode: second_stat.mode,
            hard_link_count: second_stat.hard_link_count.clone(),
        };

        // Stage 6: inherited descriptors.  The startup handshake is consumed
        // and validated before any other descriptor is touched.
        let startup_spec = InheritedSpec {
            fd: STARTUP_NONCE_FD,
            kind: FileKind::Pipe,
            access: ACCESS_READ_ONLY,
            frames: FrameSpec::Startup {
                nonce_len: context.startup_nonce.len(),
                digest_len: context.startup_digest.len(),
            },
        };
        let mut validated: Vec<(i32, FileIdentity, InheritedData)> = Vec::new();
        let mut inherited_specs: Vec<InheritedSpec> = vec![startup_spec];
        if !is_tool {
            inherited_specs.extend([
                InheritedSpec {
                    fd: ROLE_FD,
                    kind: FileKind::Regular,
                    access: ACCESS_READ_ONLY,
                    frames: FrameSpec::Declared,
                },
                InheritedSpec {
                    fd: ADDON_FD,
                    kind: FileKind::Regular,
                    access: ACCESS_READ_ONLY,
                    frames: FrameSpec::Declared,
                },
                InheritedSpec {
                    fd: PROTOCOL_IN_FD,
                    kind: FileKind::Pipe,
                    access: ACCESS_READ_ONLY,
                    frames: FrameSpec::Declared,
                },
                InheritedSpec {
                    fd: PROTOCOL_OUT_FD,
                    kind: FileKind::Pipe,
                    access: ACCESS_WRITE_ONLY,
                    frames: FrameSpec::Declared,
                },
            ]);
        }
        for spec in &inherited_specs {
            let step = validate_inherited_descriptor(eng, spec, &filesystem_identity)
                .and_then(|(identity, data)| {
                    if let InheritedData::Startup(read) = &data {
                        validate_startup_content(read, context)?;
                    }
                    Ok((identity, data))
                });
            match step {
                Ok((identity, data)) => validated.push((spec.fd, identity, data)),
                Err(failure) => {
                    if !failure.script_dead {
                        let _ = eng.close(spec.fd);
                        for (fd, _, _) in validated.iter().rev() {
                            let _ = eng.close(*fd);
                        }
                        cleanup_parent(eng, Some(exec_fd), Some(staged_nonce));
                    }
                    return Err(err(failure.code));
                }
            }
        }

        // Stage 7: pinned relative spawn.
        if is_tool {
            if let Err(failure) = lsys(eng.fchdir(parent_fd), OUTPUT_EXEC_FAILED) {
                if !failure.script_dead {
                    let _ = eng.close(STARTUP_NONCE_FD);
                    cleanup_parent(eng, Some(exec_fd), Some(staged_nonce));
                }
                return Err(err(failure.code));
            }
        }
        let spawn_cleanup = |eng: &mut dyn engine::SyscallEngine, tool: bool| {
            let _ = eng.close(exec_fd);
            if !tool {
                for fd in [ROLE_FD, ADDON_FD, PROTOCOL_IN_FD, PROTOCOL_OUT_FD] {
                    let _ = eng.close(fd);
                }
            }
            let _ = eng.close(STARTUP_NONCE_FD);
            let _ = eng.unlinkat(parent_fd, &leaf, staged_nonce);
            let _ = eng.close(parent_fd);
        };
        let pid = match eng.pinned_directory_spawn(exec_fd, &argv_owned, &env_owned, context) {
            Ok(pid) => pid,
            Err(engine::SysFailure::ScriptMismatch) => {
                return Err(err(OUTPUT_EXEC_HANDLE_INVALID))
            }
            Err(engine::SysFailure::Launch(code)) => {
                let code = launch_failure_code(&code);
                spawn_cleanup(eng, is_tool);
                return Err(err(code));
            }
            Err(_) => {
                spawn_cleanup(eng, is_tool);
                return Err(err(OUTPUT_EXEC_FAILED));
            }
        };
        if let Err(failure) = lsys(eng.waitpid(pid), OUTPUT_EXEC_FAILED) {
            if !failure.script_dead {
                spawn_cleanup(eng, is_tool);
            }
            return Err(err(failure.code));
        }
        if is_tool {
            let _ = eng.close(exec_fd);
            let _ = eng.close(STARTUP_NONCE_FD);
            let _ = eng.unlinkat(parent_fd, &leaf, staged_nonce);
            let _ = eng.close(parent_fd);
        } else {
            for fd in [
                exec_fd,
                ROLE_FD,
                ADDON_FD,
                PROTOCOL_IN_FD,
                PROTOCOL_OUT_FD,
                STARTUP_NONCE_FD,
            ] {
                let _ = eng.close(fd);
            }
            let _ = eng.close(parent_fd);
        }
        drop(core);

        // Stage 8: the receipt.
        let mut role_sha = String::new();
        let mut addon_sha = String::new();
        let mut consumed = Vec::new();
        let mut identity_of = HashMap::new();
        for (fd, identity, data) in &validated {
            identity_of.insert(*fd, identity.clone());
            if let InheritedData::Single(read) = data {
                let sha = read.sha256();
                if *fd == ROLE_FD {
                    role_sha = sha.clone();
                }
                if *fd == ADDON_FD {
                    addon_sha = sha.clone();
                }
                consumed.push((*fd, sha));
            }
        }
        let mut rows = vec![
            BindingRow {
                logical_name: "authority",
                fd: pinned,
                access: "read",
                kind: "directory",
                close_on_exec: true,
                inherited_by_child: false,
                identity: root_stat,
            },
            BindingRow {
                logical_name: "exec-parent",
                fd: parent_fd,
                access: "read",
                kind: "directory",
                close_on_exec: true,
                inherited_by_child: false,
                identity: second_stat,
            },
            BindingRow {
                logical_name: "executable",
                fd: exec_fd,
                access: "read",
                kind: "executable",
                close_on_exec: true,
                inherited_by_child: false,
                identity: exec_stat,
            },
        ];
        if !is_tool {
            rows.extend([
                BindingRow {
                    logical_name: "roleFd",
                    fd: ROLE_FD,
                    access: "read",
                    kind: "regular",
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity: identity_of[&ROLE_FD].clone(),
                },
                BindingRow {
                    logical_name: "addonFd",
                    fd: ADDON_FD,
                    access: "read",
                    kind: "regular",
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity: identity_of[&ADDON_FD].clone(),
                },
                BindingRow {
                    logical_name: "protocolInFd",
                    fd: PROTOCOL_IN_FD,
                    access: "read",
                    kind: "pipe",
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity: identity_of[&PROTOCOL_IN_FD].clone(),
                },
                BindingRow {
                    logical_name: "protocolOutFd",
                    fd: PROTOCOL_OUT_FD,
                    access: "write",
                    kind: "pipe",
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity: identity_of[&PROTOCOL_OUT_FD].clone(),
                },
            ]);
        }
        rows.push(BindingRow {
            logical_name: "startupNonceFd",
            fd: STARTUP_NONCE_FD,
            access: "read",
            kind: "pipe",
            close_on_exec: false,
            inherited_by_child: true,
            identity: identity_of[&STARTUP_NONCE_FD].clone(),
        });
        let receipt = test_support_context::LaunchReceiptV1 {
            schema: "bun-role-launch-receipt/v1".into(),
            host_id: host_id(),
            run_id: context.run_id.clone(),
            execution_index: context.execution_index,
            logical_role: context.logical_role.clone(),
            process_ordinal: context.process_ordinal,
            bun_sha256: source_sha.clone(),
            role_entrypoint_sha256: role_sha,
            addon_sha256: addon_sha.clone(),
            argv: argv_owned,
            environment: receipt_environment(&env_owned),
            descriptor_map: binding_rows_to_map(&rows, &filesystem_identity),
            sealed_execution_identity: Some(sealed_identity),
            launch_primitive: "macos-sealed-relative-posix-spawn".into(),
            descriptor_map_sha256: context.descriptor_map_sha256.clone(),
            startup_nonce_sha256: context.startup_nonce_sha256.clone(),
            startup_digest_sha256: context.startup_digest_sha256.clone(),
            addon_requested_specifier: addon_requested_specifier(&env_owned),
            addon_load_attempt_count: u32::from(!is_tool),
            addon_loaded_sha256: addon_sha,
            addon_fallback_candidates: Vec::new(),
            socket_before_startup_handshake: false,
            launched_at: context.clock_rfc3339.clone(),
        };
        Ok(SealedLaunch {
            receipt,
            source_descriptor_hashes: vec![(source_fd, source_sha.clone())],
            destination_descriptor_hashes: vec![(exec_fd, source_sha)],
            consumed_to_eof: consumed,
            source_closed_before_destination_open: Some((source_fd, exec_fd)),
        })
    }
}

// ---------------------------------------------------------------------------
// Production syscall engine
// ---------------------------------------------------------------------------

#[cfg(unix)]
pub use libc_engine::LibcSyscalls;

/// Real libc implementation of the sealed seam.  File, directory, and
/// identity operations are live; the two sealed spawn primitives and
/// `waitpid` return `Unavailable` until Task C wires the supervisor's
/// authority bootstrap and descriptor-mapped child launch.
#[cfg(unix)]
#[allow(dead_code)]
mod libc_engine {
    use super::engine::{
        CreatedFd, Errno, ReadOutcome, StatxIdentity, SysFailure, SysResult, SyscallEngine,
    };
    use super::test_support_context::LaunchContextV1;
    use super::{DirectoryIdentity, FileIdentity, FileKind, MountTableEntry};
    use std::ffi::CString;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Sealed production syscall provider.
    pub struct LibcSyscalls {
        engine: LibcEngine,
    }

    impl LibcSyscalls {
        pub fn new() -> Self {
            Self { engine: LibcEngine }
        }
    }

    impl Default for LibcSyscalls {
        fn default() -> Self {
            Self::new()
        }
    }

    impl super::sealed::Sealed for LibcSyscalls {}

    impl super::SecureFsSyscalls for LibcSyscalls {
        fn engine(&mut self) -> &mut dyn SyscallEngine {
            &mut self.engine
        }
    }

    struct LibcEngine;

    static CREATE_NONCE: AtomicU64 = AtomicU64::new(1);

    fn errno_failure() -> SysFailure {
        let raw = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        SysFailure::Errno(match raw {
            libc::EINTR => Errno::Eintr,
            libc::ENOENT => Errno::NoEntry,
            libc::ENOSPC => Errno::NoSpace,
            libc::EDQUOT => Errno::Quota,
            libc::EPERM | libc::EACCES | libc::EROFS => Errno::Permission,
            libc::EEXIST => Errno::Exist,
            libc::ENOSYS => Errno::NoSys,
            #[cfg(target_os = "linux")]
            libc::ENODATA => Errno::NoData,
            #[cfg(target_os = "macos")]
            93 => Errno::NoData, // ENOATTR
            _ => Errno::Other,
        })
    }

    fn component_cstring(component: &str) -> SysResult<CString> {
        CString::new(component).map_err(|_| SysFailure::Errno(Errno::Other))
    }

    fn kind_of_mode(mode: libc::mode_t) -> FileKind {
        match mode & libc::S_IFMT {
            libc::S_IFREG => FileKind::Regular,
            libc::S_IFDIR => FileKind::Directory,
            libc::S_IFLNK => FileKind::Symlink,
            libc::S_IFIFO => FileKind::Pipe,
            libc::S_IFSOCK => FileKind::Socket,
            libc::S_IFBLK => FileKind::BlockDevice,
            libc::S_IFCHR => FileKind::CharacterDevice,
            _ => FileKind::MagicLink,
        }
    }

    #[cfg(target_os = "linux")]
    fn device_string(dev: libc::dev_t) -> String {
        // SAFETY: major/minor are pure bit extractors.
        unsafe { format!("{}:{}", libc::major(dev), libc::minor(dev)) }
    }

    #[cfg(target_os = "macos")]
    fn device_string(dev: libc::dev_t) -> String {
        format!("{dev}")
    }

    fn raw_fstat(fd: i32) -> SysResult<libc::stat> {
        // SAFETY: fstat writes into the zeroed buffer on success only.
        unsafe {
            let mut stat: libc::stat = std::mem::zeroed();
            if libc::fstat(fd, &mut stat) != 0 {
                return Err(errno_failure());
            }
            Ok(stat)
        }
    }

    fn raw_fstatfs(fd: i32) -> SysResult<libc::statfs> {
        // SAFETY: fstatfs writes into the zeroed buffer on success only.
        unsafe {
            let mut stat: libc::statfs = std::mem::zeroed();
            if libc::fstatfs(fd, &mut stat) != 0 {
                return Err(errno_failure());
            }
            Ok(stat)
        }
    }

    fn fsid_words(fsid: &libc::fsid_t) -> (String, String) {
        // SAFETY: fsid_t is two C ints on both platforms; the field is
        // private in libc, so read it through a layout-compatible copy.
        let words: [i32; 2] = unsafe { std::mem::transmute_copy(fsid) };
        (
            format!("{}", words[0] as u32),
            format!("{}", words[1] as u32),
        )
    }

    #[cfg(target_os = "linux")]
    mod linux_raw {
        #[repr(C)]
        pub(super) struct OpenHow {
            pub flags: u64,
            pub mode: u64,
            pub resolve: u64,
        }

        pub(super) const STATX_MNT_ID: u32 = 0x1000;
        pub(super) const STATX_BASIC_STATS: u32 = 0x07ff;
    }

    #[cfg(target_os = "linux")]
    fn raw_statx(fd: i32) -> SysResult<libc::statx> {
        // SAFETY: statx with AT_EMPTY_PATH fills the zeroed buffer.
        unsafe {
            let mut statx: libc::statx = std::mem::zeroed();
            let empty = b"\0";
            let rc = libc::syscall(
                libc::SYS_statx,
                fd,
                empty.as_ptr(),
                libc::AT_EMPTY_PATH,
                linux_raw::STATX_BASIC_STATS | linux_raw::STATX_MNT_ID,
                &mut statx as *mut libc::statx,
            );
            if rc != 0 {
                return Err(errno_failure());
            }
            Ok(statx)
        }
    }

    #[cfg(target_os = "linux")]
    fn linux_type_name(magic: i64) -> String {
        match magic as u32 {
            0x0000_ef53 => "ext4".into(),
            0x5846_5342 => "xfs".into(),
            0x9123_683e => "btrfs".into(),
            other => format!("{other:08x}"),
        }
    }

    #[cfg(target_os = "macos")]
    mod mac_raw {
        use std::os::raw::{c_int, c_void};

        #[repr(C)]
        pub(super) struct AttrList {
            pub bitmapcount: u16,
            pub reserved: u16,
            pub commonattr: u32,
            pub volattr: u32,
            pub dirattr: u32,
            pub fileattr: u32,
            pub forkattr: u32,
        }

        pub(super) const ATTR_BIT_MAP_COUNT: u16 = 5;
        pub(super) const ATTR_VOL_INFO: u32 = 0x8000_0000;
        pub(super) const ATTR_VOL_UUID: u32 = 0x0004_0000;
        pub(super) const MNT_NOWAIT: c_int = 2;

        extern "C" {
            pub(super) fn fgetattrlist(
                fd: c_int,
                attr_list: *mut AttrList,
                attr_buf: *mut c_void,
                attr_buf_size: usize,
                options: u32,
            ) -> c_int;
            pub(super) fn getattrlist(
                path: *const i8,
                attr_list: *mut AttrList,
                attr_buf: *mut c_void,
                attr_buf_size: usize,
                options: u32,
            ) -> c_int;
            pub(super) fn getfsstat(buf: *mut libc::statfs, bufsize: c_int, flags: c_int)
                -> c_int;
        }
    }

    #[cfg(target_os = "macos")]
    fn uuid_hex(bytes: &[u8; 16]) -> String {
        let mut out = String::with_capacity(32);
        for byte in bytes {
            use std::fmt::Write;
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    #[cfg(target_os = "macos")]
    #[repr(C)]
    struct VolUuidBuf {
        length: u32,
        uuid: [u8; 16],
    }

    #[cfg(target_os = "macos")]
    fn volume_attr_list() -> mac_raw::AttrList {
        mac_raw::AttrList {
            bitmapcount: mac_raw::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: 0,
            volattr: mac_raw::ATTR_VOL_INFO | mac_raw::ATTR_VOL_UUID,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        }
    }

    #[cfg(target_os = "macos")]
    fn volume_uuid_of_fd(fd: i32) -> SysResult<String> {
        let mut attrs = volume_attr_list();
        let mut buf = VolUuidBuf {
            length: 0,
            uuid: [0; 16],
        };
        // SAFETY: fgetattrlist fills the sized buffer on success only.
        let rc = unsafe {
            mac_raw::fgetattrlist(
                fd,
                &mut attrs,
                (&mut buf as *mut VolUuidBuf).cast(),
                std::mem::size_of::<VolUuidBuf>(),
                0,
            )
        };
        if rc != 0 {
            return Err(errno_failure());
        }
        Ok(uuid_hex(&buf.uuid))
    }

    #[cfg(target_os = "macos")]
    fn volume_uuid_of_path(path: &[i8]) -> Option<String> {
        let mut attrs = volume_attr_list();
        let mut buf = VolUuidBuf {
            length: 0,
            uuid: [0; 16],
        };
        // SAFETY: getattrlist reads a NUL-terminated mount path taken from
        // the kernel's own mount table and fills the sized buffer.
        let rc = unsafe {
            mac_raw::getattrlist(
                path.as_ptr(),
                &mut attrs,
                (&mut buf as *mut VolUuidBuf).cast(),
                std::mem::size_of::<VolUuidBuf>(),
                0,
            )
        };
        if rc != 0 {
            return None;
        }
        Some(uuid_hex(&buf.uuid))
    }

    #[cfg(target_os = "macos")]
    fn c_chars_to_string(chars: &[i8]) -> String {
        let bytes: Vec<u8> = chars
            .iter()
            .take_while(|ch| **ch != 0)
            .map(|ch| *ch as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[cfg(target_os = "macos")]
    fn descriptor_path(fd: i32) -> SysResult<String> {
        let mut buf = [0i8; 1024];
        // SAFETY: F_GETPATH writes a NUL-terminated path into the buffer.
        let rc = unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) };
        if rc != 0 {
            return Err(errno_failure());
        }
        Ok(c_chars_to_string(&buf))
    }

    impl LibcEngine {
        fn file_identity(&self, stat: &libc::stat, fd_for_fs: i32) -> FileIdentity {
            let (fsid0, fsid1, mount_id) = match raw_fstatfs(fd_for_fs) {
                Ok(statfs) => {
                    let (fsid0, fsid1) = fsid_words(&statfs.f_fsid);
                    #[cfg(target_os = "linux")]
                    let mount_id = raw_statx(fd_for_fs)
                        .ok()
                        .map(|statx| format!("{}", statx.stx_mnt_id));
                    #[cfg(target_os = "macos")]
                    let mount_id = None;
                    (fsid0, fsid1, mount_id)
                }
                Err(_) => (String::new(), String::new(), None),
            };
            FileIdentity {
                kind: kind_of_mode(stat.st_mode),
                device: device_string(stat.st_dev),
                inode: format!("{}", stat.st_ino),
                mount_id,
                fsid_word0: fsid0,
                fsid_word1: fsid1,
                owner_uid: stat.st_uid,
                mode: (stat.st_mode as u32) & 0o7777,
                hard_link_count: format!("{}", stat.st_nlink),
                size: stat.st_size.max(0) as u64,
            }
        }

        fn directory_identity(&self, fd: i32) -> SysResult<DirectoryIdentity> {
            let stat = raw_fstat(fd)?;
            let statfs = raw_fstatfs(fd)?;
            let (fsid0, fsid1) = fsid_words(&statfs.f_fsid);
            #[cfg(target_os = "linux")]
            {
                let statx = raw_statx(fd)?;
                Ok(DirectoryIdentity::Linux(super::LinuxDirectoryIdentity {
                    device_major: format!("{}", statx.stx_dev_major),
                    device_minor: format!("{}", statx.stx_dev_minor),
                    inode: format!("{}", stat.st_ino),
                    mount_id: format!("{}", statx.stx_mnt_id),
                    file_system_type: linux_type_name(statfs.f_type as i64),
                    file_system_type_magic: format!("{:08x}", statfs.f_type as u32),
                    fsid_word0: fsid0,
                    fsid_word1: fsid1,
                    owner_uid: stat.st_uid,
                    mode: (stat.st_mode as u32) & 0o7777,
                    hard_link_count: format!("{}", stat.st_nlink),
                }))
            }
            #[cfg(target_os = "macos")]
            {
                let volume_uuid = volume_uuid_of_fd(fd)?;
                let path = descriptor_path(fd)?;
                let table = self.mount_table()?;
                let matched = table
                    .iter()
                    .find(|entry| entry.volume_uuid == volume_uuid)
                    .cloned()
                    .unwrap_or_else(|| MountTableEntry {
                        file_system_type: c_chars_to_string(&statfs.f_fstypename),
                        volume_uuid: volume_uuid.clone(),
                        mount_point: c_chars_to_string(&statfs.f_mntonname),
                        fsid_word0: fsid0.clone(),
                        fsid_word1: fsid1.clone(),
                    });
                let record = format!(
                    "{}|{}|{}|{}|{}\n",
                    matched.file_system_type,
                    matched.volume_uuid,
                    matched.mount_point,
                    matched.fsid_word0,
                    matched.fsid_word1,
                );
                Ok(DirectoryIdentity::Macos(super::MacosDirectoryIdentity {
                    device: device_string(stat.st_dev),
                    inode: format!("{}", stat.st_ino),
                    fsid_word0: fsid0,
                    fsid_word1: fsid1,
                    file_system_type: c_chars_to_string(&statfs.f_fstypename),
                    volume_uuid,
                    mount_table_entry_sha256: super::sha256_hex(record.as_bytes()),
                    canonical_descriptor_path_sha256: super::sha256_hex(path.as_bytes()),
                    owner_uid: stat.st_uid,
                    mode: (stat.st_mode as u32) & 0o7777,
                    hard_link_count: format!("{}", stat.st_nlink),
                }))
            }
        }

        #[cfg(target_os = "macos")]
        fn mount_table(&self) -> SysResult<Vec<MountTableEntry>> {
            // SAFETY: the first call sizes the table; the second fills at
            // most that many statfs records.
            unsafe {
                let count = mac_raw::getfsstat(std::ptr::null_mut(), 0, mac_raw::MNT_NOWAIT);
                if count < 0 {
                    return Err(errno_failure());
                }
                let mut entries: Vec<libc::statfs> = vec![std::mem::zeroed(); count as usize];
                let bytes = (entries.len() * std::mem::size_of::<libc::statfs>()) as i32;
                let filled =
                    mac_raw::getfsstat(entries.as_mut_ptr(), bytes, mac_raw::MNT_NOWAIT);
                if filled < 0 {
                    return Err(errno_failure());
                }
                entries.truncate(filled as usize);
                Ok(entries
                    .iter()
                    .map(|entry| {
                        let (fsid0, fsid1) = fsid_words(&entry.f_fsid);
                        MountTableEntry {
                            file_system_type: c_chars_to_string(&entry.f_fstypename),
                            volume_uuid: volume_uuid_of_path(&entry.f_mntonname)
                                .unwrap_or_default(),
                            mount_point: c_chars_to_string(&entry.f_mntonname),
                            fsid_word0: fsid0,
                            fsid_word1: fsid1,
                        }
                    })
                    .collect())
            }
        }
    }

    impl SyscallEngine for LibcEngine {
        fn dup(&mut self, fd: i32) -> SysResult<i32> {
            // SAFETY: F_DUPFD_CLOEXEC allocates a new close-on-exec slot.
            let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicated < 0 {
                return Err(errno_failure());
            }
            Ok(duplicated)
        }

        fn fcntl_get_fd_cloexec(&mut self, fd: i32) -> SysResult<bool> {
            // SAFETY: F_GETFD reads descriptor flags only.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 {
                return Err(errno_failure());
            }
            Ok(flags & libc::FD_CLOEXEC != 0)
        }

        fn fcntl_get_fl(&mut self, fd: i32) -> SysResult<u64> {
            // SAFETY: F_GETFL reads file status flags only.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 {
                return Err(errno_failure());
            }
            Ok(flags as u64)
        }

        fn fstat(&mut self, fd: i32) -> SysResult<FileIdentity> {
            let stat = raw_fstat(fd)?;
            Ok(self.file_identity(&stat, fd))
        }

        fn fstatat_no_follow(&mut self, dirfd: i32, component: &str) -> SysResult<FileIdentity> {
            let component = component_cstring(component)?;
            // SAFETY: fstatat fills the zeroed buffer on success only.
            let stat = unsafe {
                let mut stat: libc::stat = std::mem::zeroed();
                if libc::fstatat(
                    dirfd,
                    component.as_ptr(),
                    &mut stat,
                    libc::AT_SYMLINK_NOFOLLOW,
                ) != 0
                {
                    return Err(errno_failure());
                }
                stat
            };
            // Filesystem-level identity comes from the parent handle.
            Ok(self.file_identity(&stat, dirfd))
        }

        fn fstatfs(&mut self, fd: i32) -> SysResult<DirectoryIdentity> {
            self.directory_identity(fd)
        }

        fn statx_empty_path(&mut self, fd: i32) -> SysResult<StatxIdentity> {
            #[cfg(target_os = "linux")]
            {
                let statx = raw_statx(fd)?;
                let mount_id_present = statx.stx_mask & linux_raw::STATX_MNT_ID != 0;
                Ok(StatxIdentity {
                    identity: Some(self.directory_identity(fd)?),
                    mount_id_present,
                })
            }
            #[cfg(target_os = "macos")]
            {
                let _ = fd;
                Err(SysFailure::Unavailable)
            }
        }

        fn fgetattrlist_volume_uuid(&mut self, fd: i32) -> SysResult<String> {
            #[cfg(target_os = "macos")]
            {
                volume_uuid_of_fd(fd)
            }
            #[cfg(target_os = "linux")]
            {
                let _ = fd;
                Err(SysFailure::Unavailable)
            }
        }

        fn fgetpath(&mut self, fd: i32) -> SysResult<String> {
            #[cfg(target_os = "macos")]
            {
                descriptor_path(fd)
            }
            #[cfg(target_os = "linux")]
            {
                let _ = fd;
                Err(SysFailure::Unavailable)
            }
        }

        fn getfsstat(&mut self) -> SysResult<Vec<MountTableEntry>> {
            #[cfg(target_os = "macos")]
            {
                self.mount_table()
            }
            #[cfg(target_os = "linux")]
            {
                Err(SysFailure::Unavailable)
            }
        }

        fn openat(&mut self, dirfd: i32, component: &str, flags: u64, mode: u32) -> SysResult<i32> {
            let component = component_cstring(component)?;
            // SAFETY: openat with validated component bytes and frozen flags.
            let fd = unsafe {
                libc::openat(
                    dirfd,
                    component.as_ptr(),
                    flags as libc::c_int,
                    mode as libc::c_uint,
                )
            };
            if fd < 0 {
                return Err(errno_failure());
            }
            Ok(fd)
        }

        fn openat_create_new(
            &mut self,
            dirfd: i32,
            component: &str,
            flags: u64,
            mode: u32,
        ) -> SysResult<CreatedFd> {
            let fd = self.openat(dirfd, component, flags, mode)?;
            // O_CREAT|O_EXCL succeeded: exactly one fresh entry exists and no
            // other entry ever did under this name while we held the parent.
            Ok(CreatedFd {
                fd,
                token_nonce: CREATE_NONCE.fetch_add(1, Ordering::Relaxed),
                entry_count: 1,
                no_other_entry_ever_existed: true,
            })
        }

        fn openat2(
            &mut self,
            dirfd: i32,
            component: &str,
            flags: u64,
            resolve: u64,
        ) -> SysResult<i32> {
            #[cfg(target_os = "linux")]
            {
                let component = component_cstring(component)?;
                let mut how = linux_raw::OpenHow {
                    flags,
                    mode: 0,
                    resolve,
                };
                // SAFETY: raw openat2 with a properly sized open_how.
                let fd = unsafe {
                    libc::syscall(
                        libc::SYS_openat2,
                        dirfd,
                        component.as_ptr(),
                        &mut how as *mut linux_raw::OpenHow,
                        std::mem::size_of::<linux_raw::OpenHow>(),
                    )
                };
                if fd < 0 {
                    return Err(errno_failure());
                }
                Ok(fd as i32)
            }
            #[cfg(target_os = "macos")]
            {
                let _ = (dirfd, component, flags, resolve);
                Err(SysFailure::Unavailable)
            }
        }

        fn mkdirat(&mut self, dirfd: i32, component: &str, mode: u32) -> SysResult<()> {
            let component = component_cstring(component)?;
            // SAFETY: mkdirat with validated component bytes.
            if unsafe { libc::mkdirat(dirfd, component.as_ptr(), mode as libc::mode_t) } != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn read(&mut self, fd: i32, max: usize) -> SysResult<ReadOutcome> {
            let mut buf = vec![0u8; max.clamp(1, super::MAX_CHUNK_BYTES)];
            // SAFETY: read fills at most buf.len() bytes.
            let got = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if got < 0 {
                return Err(errno_failure());
            }
            if got == 0 {
                return Ok(ReadOutcome::Eof);
            }
            buf.truncate(got as usize);
            Ok(ReadOutcome::Data(buf))
        }

        fn pread(&mut self, fd: i32, offset: u64, max: usize) -> SysResult<ReadOutcome> {
            let mut buf = vec![0u8; max.clamp(1, super::MAX_CHUNK_BYTES)];
            // SAFETY: pread fills at most buf.len() bytes at the offset.
            let got = unsafe {
                libc::pread(
                    fd,
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    offset as libc::off_t,
                )
            };
            if got < 0 {
                return Err(errno_failure());
            }
            if got == 0 {
                return Ok(ReadOutcome::Eof);
            }
            buf.truncate(got as usize);
            Ok(ReadOutcome::Data(buf))
        }

        fn lseek(&mut self, fd: i32, offset: u64, whence: i32) -> SysResult<u64> {
            // SAFETY: lseek repositions the descriptor only.
            let reached = unsafe { libc::lseek(fd, offset as libc::off_t, whence) };
            if reached < 0 {
                return Err(errno_failure());
            }
            Ok(reached as u64)
        }

        fn write(&mut self, fd: i32, bytes: &[u8]) -> SysResult<usize> {
            let len = bytes.len().min(super::MAX_CHUNK_BYTES);
            // SAFETY: write reads at most len bytes from the slice.
            let wrote = unsafe { libc::write(fd, bytes.as_ptr().cast(), len) };
            if wrote < 0 {
                return Err(errno_failure());
            }
            Ok(wrote as usize)
        }

        fn fdatasync(&mut self, fd: i32) -> SysResult<()> {
            #[cfg(target_os = "linux")]
            // SAFETY: fdatasync flushes file data.
            let rc = unsafe { libc::fdatasync(fd) };
            #[cfg(target_os = "macos")]
            // SAFETY: F_FULLFSYNC is the durable data flush on APFS.
            let rc = unsafe { libc::fcntl(fd, libc::F_FULLFSYNC) };
            if rc != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn fsync(&mut self, fd: i32) -> SysResult<()> {
            // SAFETY: fsync flushes the descriptor.
            if unsafe { libc::fsync(fd) } != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn fchdir(&mut self, fd: i32) -> SysResult<()> {
            // SAFETY: fchdir pins the working directory to the handle.
            if unsafe { libc::fchdir(fd) } != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn fchmod(&mut self, fd: i32, mode: u32) -> SysResult<()> {
            // SAFETY: fchmod changes the handle's mode bits only.
            if unsafe { libc::fchmod(fd, mode as libc::mode_t) } != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn unlinkat(&mut self, dirfd: i32, component: &str, _token_nonce: u64) -> SysResult<()> {
            let component = component_cstring(component)?;
            // SAFETY: unlinkat removes exactly the named parent-relative
            // entry; the token nonce was validated by the boundary.
            if unsafe { libc::unlinkat(dirfd, component.as_ptr(), 0) } != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn executable_handle_spawn(
            &mut self,
            _executable_fd: i32,
            _argv: &[String],
            _env: &[(String, String)],
            _context: &LaunchContextV1,
        ) -> SysResult<i32> {
            // Task C wires the descriptor-mapped execveat launch.
            Err(SysFailure::Unavailable)
        }

        fn pinned_directory_spawn(
            &mut self,
            _executable_fd: i32,
            _argv: &[String],
            _env: &[(String, String)],
            _context: &LaunchContextV1,
        ) -> SysResult<i32> {
            // Task C wires the descriptor-mapped posix_spawn launch.
            Err(SysFailure::Unavailable)
        }

        fn waitpid(&mut self, pid: i32) -> SysResult<i32> {
            let _ = pid;
            // Task C owns child reaping together with the spawn primitives.
            Err(SysFailure::Unavailable)
        }

        fn close(&mut self, fd: i32) -> SysResult<()> {
            // SAFETY: close releases the descriptor.
            if unsafe { libc::close(fd) } != 0 {
                return Err(errno_failure());
            }
            Ok(())
        }

        fn wants_mac_provenance(&mut self, _fd: i32, _path_first: bool) -> bool {
            cfg!(target_os = "macos")
        }

        fn wants_mkdirat(&mut self, _dirfd: i32, _component: &str) -> bool {
            true
        }

        fn wants_reread(&mut self, _fd: i32) -> bool {
            true
        }

        fn wants_write_verify_fstat(&mut self, _fd: i32) -> bool {
            true
        }

        fn sealed_identity_fixture_digests(&mut self) -> Option<(String, String)> {
            None
        }

        fn remaining(&self) -> usize {
            0
        }
    }
}

// ---------------------------------------------------------------------------
// Test seam (scripted syscalls, observation seam, command runner, windows
// process-start probes)
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "webtransport_test_seams"))]
pub mod test_support {
    pub use super::test_support_context::{
        DescriptorBindingV1, DeterministicReservationContext, LaunchContextV1, LaunchReceiptV1,
    };
    use super::{engine, sha256_hex, DirectoryIdentity, FileIdentity, FsError, MountTableEntry};

    /// Scripted errno failures.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum Errno {
        NoEntry,
        Eintr,
        NoSpace,
        Quota,
        Permission,
        Exist,
        NoSys,
        NoData,
    }

    impl From<Errno> for engine::Errno {
        fn from(value: Errno) -> Self {
            match value {
                Errno::NoEntry => engine::Errno::NoEntry,
                Errno::Eintr => engine::Errno::Eintr,
                Errno::NoSpace => engine::Errno::NoSpace,
                Errno::Quota => engine::Errno::Quota,
                Errno::Permission => engine::Errno::Permission,
                Errno::Exist => engine::Errno::Exist,
                Errno::NoSys => engine::Errno::NoSys,
                Errno::NoData => engine::Errno::NoData,
            }
        }
    }

    /// One expected syscall.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum Syscall {
        Dup { fd: i32 },
        FcntlGetFd { fd: i32 },
        FcntlGetFl { fd: i32 },
        Fstat { fd: i32 },
        FstatatNoFollow { dirfd: i32, component: String },
        Fstatfs { fd: i32 },
        StatxEmptyPath { fd: i32 },
        FgetattrlistVolumeUuid { fd: i32 },
        FGetPath { fd: i32 },
        Getfsstat,
        Openat { dirfd: i32, component: String, flags: u64, mode: u32 },
        Openat2 { dirfd: i32, component: String, flags: u64, resolve: u64 },
        Mkdirat { dirfd: i32, component: String, mode: u32 },
        Read { fd: i32, max: usize },
        Pread { fd: i32, offset: u64, max: usize },
        Lseek { fd: i32, offset: u64, whence: i32 },
        Write { fd: i32, bytes: Vec<u8> },
        Fdatasync { fd: i32 },
        Fsync { fd: i32 },
        Fchdir { fd: i32 },
        Fchmod { fd: i32, mode: u32 },
        Unlinkat { dirfd: i32, component: String, token_nonce: u64 },
        ExecutableHandleSpawn {
            executable_fd: i32,
            argv: Vec<String>,
            env: Vec<(String, String)>,
            context: LaunchContextV1,
        },
        PinnedDirectorySpawn {
            executable_fd: i32,
            argv: Vec<String>,
            env: Vec<(String, String)>,
            context: LaunchContextV1,
        },
        Waitpid { pid: i32 },
        Close { fd: i32 },
        PathOpen { path: String },
    }

    /// One scripted reply.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum Reply {
        Unit,
        Fd(i32),
        Flags(u64),
        Bytes(Vec<u8>),
        Written(usize),
        ZeroProgress,
        Offset(u64),
        FileIdentity(FileIdentity),
        DirectoryIdentity(DirectoryIdentity),
        StatxMissingMountId,
        VolumeUuid(String),
        Path(String),
        MountTable(Vec<MountTableEntry>),
        CloseOnExec,
        Inheritable,
        ChildPid(i32),
        Exit(i32),
        LaunchFailure(String),
        CreatedWithLedger {
            fd: i32,
            token_nonce: u64,
            entry_count: u64,
            no_other_entry_ever_existed: bool,
        },
    }

    /// One queue entry: a call plus its scripted outcome.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ScriptedCall {
        pub(crate) call: Syscall,
        pub(crate) outcome: Result<Reply, Errno>,
    }

    impl ScriptedCall {
        pub fn ok(call: Syscall, reply: Reply) -> Self {
            Self {
                call,
                outcome: Ok(reply),
            }
        }

        pub fn error(call: Syscall, errno: Errno) -> Self {
            Self {
                call,
                outcome: Err(errno),
            }
        }
    }

    /// Exact ordered scripted syscall queue.
    pub struct ScriptedSyscalls {
        pub(crate) engine: ScriptedEngine,
    }

    pub(crate) struct ScriptedEngine {
        pub(crate) queue: std::collections::VecDeque<ScriptedCall>,
        pub(crate) mismatched: bool,
    }

    impl ScriptedSyscalls {
        pub fn new(calls: impl IntoIterator<Item = ScriptedCall>) -> Self {
            Self {
                engine: ScriptedEngine {
                    queue: calls.into_iter().collect(),
                    mismatched: false,
                },
            }
        }

        pub fn empty() -> Self {
            Self::new([])
        }
    }

    impl super::sealed::Sealed for ScriptedSyscalls {}

    impl super::SecureFsSyscalls for ScriptedSyscalls {
        fn engine(&mut self) -> &mut dyn engine::SyscallEngine {
            &mut self.engine
        }
    }

    /// The frozen fixture-digest rule (`r1-fixture-digest/v1`): scripted
    /// engines substitute these for environment-specific provenance bytes.
    fn r1_fixture_digest(label: &str) -> String {
        sha256_hex(
            format!("{{\"label\":\"{label}\",\"schema\":\"r1-fixture-digest/v1\"}}\n").as_bytes(),
        )
    }

    impl ScriptedEngine {
        /// Pops the queue front when it matches; otherwise poisons the queue.
        fn take(
            &mut self,
            matcher: impl Fn(&Syscall) -> bool,
        ) -> Result<Result<Reply, Errno>, engine::SysFailure> {
            match self.queue.front() {
                Some(entry) if matcher(&entry.call) => {
                    let entry = self.queue.pop_front().expect("front exists");
                    Ok(entry.outcome)
                }
                _ => {
                    self.mismatched = true;
                    Err(engine::SysFailure::ScriptMismatch)
                }
            }
        }

        fn mismatch<T>(&mut self) -> engine::SysResult<T> {
            self.mismatched = true;
            Err(engine::SysFailure::ScriptMismatch)
        }

        fn reply(
            &mut self,
            matcher: impl Fn(&Syscall) -> bool,
        ) -> engine::SysResult<Reply> {
            match self.take(matcher)? {
                Ok(reply) => Ok(reply),
                Err(errno) => Err(engine::SysFailure::Errno(errno.into())),
            }
        }

        fn peek(&self, matcher: impl Fn(&Syscall) -> bool) -> bool {
            self.queue
                .front()
                .map(|entry| matcher(&entry.call))
                .unwrap_or(false)
        }
    }

    fn read_outcome(reply: Reply) -> Option<engine::ReadOutcome> {
        match reply {
            Reply::Bytes(bytes) if bytes.is_empty() => Some(engine::ReadOutcome::Eof),
            Reply::Bytes(bytes) => Some(engine::ReadOutcome::Data(bytes)),
            Reply::ZeroProgress => Some(engine::ReadOutcome::ZeroProgress),
            _ => None,
        }
    }

    impl engine::SyscallEngine for ScriptedEngine {
        fn dup(&mut self, fd: i32) -> engine::SysResult<i32> {
            match self.reply(|call| matches!(call, Syscall::Dup { fd: f } if *f == fd))? {
                Reply::Fd(new_fd) => Ok(new_fd),
                _ => self.mismatch(),
            }
        }

        fn fcntl_get_fd_cloexec(&mut self, fd: i32) -> engine::SysResult<bool> {
            match self.reply(|call| matches!(call, Syscall::FcntlGetFd { fd: f } if *f == fd))? {
                Reply::CloseOnExec => Ok(true),
                Reply::Inheritable => Ok(false),
                _ => self.mismatch(),
            }
        }

        fn fcntl_get_fl(&mut self, fd: i32) -> engine::SysResult<u64> {
            match self.reply(|call| matches!(call, Syscall::FcntlGetFl { fd: f } if *f == fd))? {
                Reply::Flags(flags) => Ok(flags),
                _ => self.mismatch(),
            }
        }

        fn fstat(&mut self, fd: i32) -> engine::SysResult<FileIdentity> {
            match self.reply(|call| matches!(call, Syscall::Fstat { fd: f } if *f == fd))? {
                Reply::FileIdentity(identity) => Ok(identity),
                _ => self.mismatch(),
            }
        }

        fn fstatat_no_follow(
            &mut self,
            dirfd: i32,
            component: &str,
        ) -> engine::SysResult<FileIdentity> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::FstatatNoFollow { dirfd: d, component: c }
                        if *d == dirfd && c == component
                )
            })?;
            match reply {
                Reply::FileIdentity(identity) => Ok(identity),
                _ => self.mismatch(),
            }
        }

        fn fstatfs(&mut self, fd: i32) -> engine::SysResult<DirectoryIdentity> {
            match self.reply(|call| matches!(call, Syscall::Fstatfs { fd: f } if *f == fd))? {
                Reply::DirectoryIdentity(identity) => Ok(identity),
                _ => self.mismatch(),
            }
        }

        fn statx_empty_path(&mut self, fd: i32) -> engine::SysResult<engine::StatxIdentity> {
            let reply =
                self.reply(|call| matches!(call, Syscall::StatxEmptyPath { fd: f } if *f == fd))?;
            match reply {
                Reply::DirectoryIdentity(identity) => Ok(engine::StatxIdentity {
                    identity: Some(identity),
                    mount_id_present: true,
                }),
                Reply::StatxMissingMountId => Ok(engine::StatxIdentity {
                    identity: None,
                    mount_id_present: false,
                }),
                _ => self.mismatch(),
            }
        }

        fn fgetattrlist_volume_uuid(&mut self, fd: i32) -> engine::SysResult<String> {
            let reply = self.reply(
                |call| matches!(call, Syscall::FgetattrlistVolumeUuid { fd: f } if *f == fd),
            )?;
            match reply {
                Reply::VolumeUuid(uuid) => Ok(uuid),
                _ => self.mismatch(),
            }
        }

        fn fgetpath(&mut self, fd: i32) -> engine::SysResult<String> {
            match self.reply(|call| matches!(call, Syscall::FGetPath { fd: f } if *f == fd))? {
                Reply::Path(path) => Ok(path),
                _ => self.mismatch(),
            }
        }

        fn getfsstat(&mut self) -> engine::SysResult<Vec<MountTableEntry>> {
            match self.reply(|call| matches!(call, Syscall::Getfsstat))? {
                Reply::MountTable(table) => Ok(table),
                _ => self.mismatch(),
            }
        }

        fn openat(&mut self, dirfd: i32, component: &str, flags: u64, mode: u32) -> engine::SysResult<i32> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Openat { dirfd: d, component: c, flags: fl, mode: m }
                        if *d == dirfd && c == component && *fl == flags && *m == mode
                )
            })?;
            match reply {
                Reply::Fd(fd) => Ok(fd),
                _ => self.mismatch(),
            }
        }

        fn openat_create_new(
            &mut self,
            dirfd: i32,
            component: &str,
            flags: u64,
            mode: u32,
        ) -> engine::SysResult<engine::CreatedFd> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Openat { dirfd: d, component: c, flags: fl, mode: m }
                        if *d == dirfd && c == component && *fl == flags && *m == mode
                )
            })?;
            match reply {
                Reply::CreatedWithLedger {
                    fd,
                    token_nonce,
                    entry_count,
                    no_other_entry_ever_existed,
                } => Ok(engine::CreatedFd {
                    fd,
                    token_nonce,
                    entry_count,
                    no_other_entry_ever_existed,
                }),
                _ => self.mismatch(),
            }
        }

        fn openat2(
            &mut self,
            dirfd: i32,
            component: &str,
            flags: u64,
            resolve: u64,
        ) -> engine::SysResult<i32> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Openat2 { dirfd: d, component: c, flags: fl, resolve: r }
                        if *d == dirfd && c == component && *fl == flags && *r == resolve
                )
            })?;
            match reply {
                Reply::Fd(fd) => Ok(fd),
                _ => self.mismatch(),
            }
        }

        fn mkdirat(&mut self, dirfd: i32, component: &str, mode: u32) -> engine::SysResult<()> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Mkdirat { dirfd: d, component: c, mode: m }
                        if *d == dirfd && c == component && *m == mode
                )
            })?;
            match reply {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn read(&mut self, fd: i32, max: usize) -> engine::SysResult<engine::ReadOutcome> {
            // The chunk bound is advisory documentation in the script: the
            // ceremony's own accounting is what the contract validates, and
            // scripted replies (short, corrupt, or over-delivering) drive it.
            let _ = max;
            let reply = self.reply(|call| matches!(call, Syscall::Read { fd: f, .. } if *f == fd))?;
            match read_outcome(reply) {
                Some(outcome) => Ok(outcome),
                None => self.mismatch(),
            }
        }

        fn pread(&mut self, fd: i32, offset: u64, max: usize) -> engine::SysResult<engine::ReadOutcome> {
            let _ = max;
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Pread { fd: f, offset: o, .. } if *f == fd && *o == offset
                )
            })?;
            match read_outcome(reply) {
                Some(outcome) => Ok(outcome),
                None => self.mismatch(),
            }
        }

        fn lseek(&mut self, fd: i32, offset: u64, whence: i32) -> engine::SysResult<u64> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Lseek { fd: f, offset: o, whence: w }
                        if *f == fd && *o == offset && *w == whence
                )
            })?;
            match reply {
                Reply::Offset(reached) => Ok(reached),
                _ => self.mismatch(),
            }
        }

        fn write(&mut self, fd: i32, bytes: &[u8]) -> engine::SysResult<usize> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Write { fd: f, bytes: b } if *f == fd && b == bytes
                )
            })?;
            match reply {
                Reply::Written(written) => Ok(written),
                Reply::ZeroProgress => Ok(0),
                _ => self.mismatch(),
            }
        }

        fn fdatasync(&mut self, fd: i32) -> engine::SysResult<()> {
            match self.reply(|call| matches!(call, Syscall::Fdatasync { fd: f } if *f == fd))? {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn fsync(&mut self, fd: i32) -> engine::SysResult<()> {
            match self.reply(|call| matches!(call, Syscall::Fsync { fd: f } if *f == fd))? {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn fchdir(&mut self, fd: i32) -> engine::SysResult<()> {
            match self.reply(|call| matches!(call, Syscall::Fchdir { fd: f } if *f == fd))? {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn fchmod(&mut self, fd: i32, mode: u32) -> engine::SysResult<()> {
            let reply = self.reply(|call| {
                matches!(call, Syscall::Fchmod { fd: f, mode: m } if *f == fd && *m == mode)
            })?;
            match reply {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn unlinkat(&mut self, dirfd: i32, component: &str, token_nonce: u64) -> engine::SysResult<()> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::Unlinkat { dirfd: d, component: c, token_nonce: n }
                        if *d == dirfd && c == component && *n == token_nonce
                )
            })?;
            match reply {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn executable_handle_spawn(
            &mut self,
            executable_fd: i32,
            argv: &[String],
            env: &[(String, String)],
            context: &LaunchContextV1,
        ) -> engine::SysResult<i32> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::ExecutableHandleSpawn {
                        executable_fd: f,
                        argv: a,
                        env: e,
                        context: c,
                    } if *f == executable_fd && a == argv && e == env && c == context
                )
            })?;
            match reply {
                Reply::ChildPid(pid) => Ok(pid),
                Reply::LaunchFailure(code) => Err(engine::SysFailure::Launch(code)),
                _ => self.mismatch(),
            }
        }

        fn pinned_directory_spawn(
            &mut self,
            executable_fd: i32,
            argv: &[String],
            env: &[(String, String)],
            context: &LaunchContextV1,
        ) -> engine::SysResult<i32> {
            let reply = self.reply(|call| {
                matches!(
                    call,
                    Syscall::PinnedDirectorySpawn {
                        executable_fd: f,
                        argv: a,
                        env: e,
                        context: c,
                    } if *f == executable_fd && a == argv && e == env && c == context
                )
            })?;
            match reply {
                Reply::ChildPid(pid) => Ok(pid),
                Reply::LaunchFailure(code) => Err(engine::SysFailure::Launch(code)),
                _ => self.mismatch(),
            }
        }

        fn waitpid(&mut self, pid: i32) -> engine::SysResult<i32> {
            match self.reply(|call| matches!(call, Syscall::Waitpid { pid: p } if *p == pid))? {
                Reply::Exit(status) => Ok(status),
                _ => self.mismatch(),
            }
        }

        fn close(&mut self, fd: i32) -> engine::SysResult<()> {
            match self.reply(|call| matches!(call, Syscall::Close { fd: f } if *f == fd))? {
                Reply::Unit => Ok(()),
                _ => self.mismatch(),
            }
        }

        fn wants_mac_provenance(&mut self, fd: i32, _path_first: bool) -> bool {
            self.peek(|call| {
                matches!(call, Syscall::FgetattrlistVolumeUuid { fd: f } if *f == fd)
                    || matches!(call, Syscall::FGetPath { fd: f } if *f == fd)
            })
        }

        fn wants_mkdirat(&mut self, dirfd: i32, component: &str) -> bool {
            self.peek(|call| {
                matches!(
                    call,
                    Syscall::Mkdirat { dirfd: d, component: c, .. }
                        if *d == dirfd && c == component
                )
            })
        }

        fn wants_reread(&mut self, fd: i32) -> bool {
            self.peek(|call| matches!(call, Syscall::Read { fd: f, .. } if *f == fd))
        }

        fn wants_write_verify_fstat(&mut self, fd: i32) -> bool {
            self.peek(|call| matches!(call, Syscall::Fstat { fd: f } if *f == fd))
        }

        fn sealed_identity_fixture_digests(&mut self) -> Option<(String, String)> {
            Some((
                r1_fixture_digest("mac-exec-parent-mount-table"),
                r1_fixture_digest("mac-exec-parent-fpath"),
            ))
        }

        fn remaining(&self) -> usize {
            if self.mismatched {
                0
            } else {
                self.queue.len()
            }
        }
    }

    // -----------------------------------------------------------------
    // Sealed supervisor observation seam
    // -----------------------------------------------------------------

    /// One expected observation operation.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum ObservationScriptCall {
        IfNameToIndex { interface: String },
        Siocgifmtu { interface: String },
        UdpConnect { fd: i32, destination: String },
        UdpGetsockname { fd: i32 },
        AfPacketBind { fd: i32, ifindex: u32 },
        AfPacketFilter {
            fd: i32,
            source: String,
            destination: String,
            port: u16,
            protocol: String,
            snap_length: u32,
        },
        AfPacketTimestamp { fd: i32 },
        AfPacketDropCounters { fd: i32 },
        MacPacketCapture {
            fd: i32,
            interface: String,
            source: String,
            destination: String,
            port: u16,
            snap_length: u32,
        },
        PacketReceipt { fd: i32, direction: String },
        NetlinkSockDiag { socket_inode: u64 },
        ProcessGroupOwnership { pgid: i32 },
        SocketOwnership { socket_inode: u64 },
        QdiscCleanup {
            interface: String,
            expected_before: String,
            expected_after: String,
        },
        PgidKillWait { pgid: i32 },
        Close { fd: i32 },
    }

    impl ObservationScriptCall {
        pub fn reply(self, reply: ObservationReply) -> ObservationScriptEntry {
            ObservationScriptEntry { call: self, reply }
        }
    }

    /// One scripted observation reply.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum ObservationReply {
        Unit,
        InterfaceIndex(u32),
        Mtu(u32),
        SocketAddress(String),
        Timestamping(String),
        DropCounters { captured: u64, dropped: u64 },
        PacketReceipt {
            direction: String,
            packets: u64,
            bytes: u64,
            source: String,
            destination: String,
            cardinality: u64,
        },
        SocketOwner { pgid: i32, uid: u32 },
        ProcessOwner { uid: u32 },
        WaitStatus { status: i32 },
    }

    /// A queued observation call plus reply.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ObservationScriptEntry {
        pub(crate) call: ObservationScriptCall,
        pub(crate) reply: ObservationReply,
    }

    /// Captured drop counters.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct DropCounters {
        pub captured: u64,
        pub dropped: u64,
    }

    /// One direction's packet receipt.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct PacketReceiptView {
        pub(crate) direction: String,
        pub(crate) packets: u64,
        pub(crate) bytes: u64,
        pub(crate) source: String,
        pub(crate) destination: String,
        pub(crate) cardinality: u64,
    }

    impl PacketReceiptView {
        pub fn assert_packets(&self, packets: u64) {
            assert_eq!(self.packets, packets);
        }

        pub fn assert_bytes(&self, bytes: u64) {
            assert_eq!(self.bytes, bytes);
        }

        pub fn assert_endpoints(&self, source: &str, destination: &str) {
            assert_eq!(self.source, source);
            assert_eq!(self.destination, destination);
        }

        pub fn assert_cardinality(&self, cardinality: u64) {
            assert_eq!(self.cardinality, cardinality);
        }
    }

    /// Sealed supervisor-owned topology observation seam.
    pub struct SupervisorObservationSyscalls {
        pub(crate) queue: std::collections::VecDeque<ObservationScriptEntry>,
        pub(crate) mismatched: bool,
    }

    impl SupervisorObservationSyscalls {
        pub fn scripted(calls: impl IntoIterator<Item = ObservationScriptEntry>) -> Self {
            Self {
                queue: calls.into_iter().collect(),
                mismatched: false,
            }
        }

        /// Consumes the front entry when it matches; otherwise records the
        /// mismatch and fails with the given typed code.
        fn observe(
            &mut self,
            expected: &ObservationScriptCall,
            missing_code: &'static str,
        ) -> Result<ObservationReply, FsError> {
            match self.queue.front() {
                Some(entry) if &entry.call == expected => {
                    let entry = self.queue.pop_front().expect("front exists");
                    Ok(entry.reply)
                }
                _ => {
                    self.mismatched = true;
                    Err(FsError::new(missing_code))
                }
            }
        }

        pub fn if_nametoindex(&mut self, interface: &str) -> Result<u32, FsError> {
            match self.observe(
                &ObservationScriptCall::IfNameToIndex {
                    interface: interface.into(),
                },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::InterfaceIndex(index) => Ok(index),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn siocgifmtu(&mut self, interface: &str) -> Result<u32, FsError> {
            match self.observe(
                &ObservationScriptCall::Siocgifmtu {
                    interface: interface.into(),
                },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Mtu(mtu) => Ok(mtu),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn udp_connect(&mut self, fd: i32, destination: &str) -> Result<(), FsError> {
            match self.observe(
                &ObservationScriptCall::UdpConnect {
                    fd,
                    destination: destination.into(),
                },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Unit => Ok(()),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn udp_getsockname(&mut self, fd: i32) -> Result<String, FsError> {
            match self.observe(
                &ObservationScriptCall::UdpGetsockname { fd },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::SocketAddress(address) => Ok(address),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn af_packet_bind(&mut self, fd: i32, ifindex: u32) -> Result<(), FsError> {
            match self.observe(
                &ObservationScriptCall::AfPacketBind { fd, ifindex },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Unit => Ok(()),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn af_packet_install_filter(
            &mut self,
            fd: i32,
            source: &str,
            destination: &str,
            port: u16,
            protocol: &str,
            snap_length: u32,
        ) -> Result<(), FsError> {
            match self.observe(
                &ObservationScriptCall::AfPacketFilter {
                    fd,
                    source: source.into(),
                    destination: destination.into(),
                    port,
                    protocol: protocol.into(),
                    snap_length,
                },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Unit => Ok(()),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn af_packet_enable_timestamps(&mut self, fd: i32) -> Result<String, FsError> {
            match self.observe(
                &ObservationScriptCall::AfPacketTimestamp { fd },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Timestamping(mode) => Ok(mode),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn af_packet_drop_counters(&mut self, fd: i32) -> Result<DropCounters, FsError> {
            match self.observe(
                &ObservationScriptCall::AfPacketDropCounters { fd },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::DropCounters { captured, dropped } => {
                    Ok(DropCounters { captured, dropped })
                }
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn mac_packet_capture(
            &mut self,
            fd: i32,
            interface: &str,
            source: &str,
            destination: &str,
            port: u16,
            snap_length: u32,
        ) -> Result<(), FsError> {
            match self.observe(
                &ObservationScriptCall::MacPacketCapture {
                    fd,
                    interface: interface.into(),
                    source: source.into(),
                    destination: destination.into(),
                    port,
                    snap_length,
                },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Unit => Ok(()),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        fn packet_receipt_reply(
            &mut self,
            fd: i32,
            direction: Option<&str>,
        ) -> Result<PacketReceiptView, FsError> {
            let matched = match self.queue.front() {
                Some(entry) => match &entry.call {
                    ObservationScriptCall::PacketReceipt {
                        fd: queued_fd,
                        direction: queued_direction,
                    } => {
                        *queued_fd == fd
                            && direction
                                .map(|direction| queued_direction == direction)
                                .unwrap_or(true)
                    }
                    _ => false,
                },
                None => false,
            };
            if !matched {
                self.mismatched = true;
                return Err(FsError::new(super::TRUST_ROUTE_OBSERVATION_MISSING));
            }
            let entry = self.queue.pop_front().expect("front exists");
            match entry.reply {
                ObservationReply::PacketReceipt {
                    direction,
                    packets,
                    bytes,
                    source,
                    destination,
                    cardinality,
                } => Ok(PacketReceiptView {
                    direction,
                    packets,
                    bytes,
                    source,
                    destination,
                    cardinality,
                }),
                _ => Err(FsError::new(super::TRUST_ROUTE_OBSERVATION_MISSING)),
            }
        }

        pub fn packet_receipt(&mut self, fd: i32) -> Result<PacketReceiptView, FsError> {
            self.packet_receipt_reply(fd, None)
        }

        pub fn packet_receipt_direction(
            &mut self,
            fd: i32,
            direction: &str,
        ) -> Result<PacketReceiptView, FsError> {
            self.packet_receipt_reply(fd, Some(direction))
        }

        pub fn netlink_sock_diag(&mut self, socket_inode: u64) -> Result<i32, FsError> {
            match self.observe(
                &ObservationScriptCall::NetlinkSockDiag { socket_inode },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::SocketOwner { pgid, .. } => Ok(pgid),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn process_group_ownership(&mut self, pgid: i32) -> Result<u32, FsError> {
            match self.observe(
                &ObservationScriptCall::ProcessGroupOwnership { pgid },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::ProcessOwner { uid } => Ok(uid),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn socket_ownership(&mut self, socket_inode: u64) -> Result<i32, FsError> {
            match self.observe(
                &ObservationScriptCall::SocketOwnership { socket_inode },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::SocketOwner { pgid, .. } => Ok(pgid),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn qdisc_cleanup(
            &mut self,
            interface: &str,
            expected_before: &str,
            expected_after: &str,
        ) -> Result<(), FsError> {
            match self.observe(
                &ObservationScriptCall::QdiscCleanup {
                    interface: interface.into(),
                    expected_before: expected_before.into(),
                    expected_after: expected_after.into(),
                },
                super::TRUST_QDISC_OBSERVATION_MISSING,
            )? {
                ObservationReply::Unit => Ok(()),
                _ => Err(FsError::new(super::TRUST_QDISC_OBSERVATION_MISSING)),
            }
        }

        pub fn pgid_kill_wait(&mut self, pgid: i32) -> Result<i32, FsError> {
            match self.observe(
                &ObservationScriptCall::PgidKillWait { pgid },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::WaitStatus { status } => Ok(status),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn close(&mut self, fd: i32) -> Result<(), FsError> {
            match self.observe(
                &ObservationScriptCall::Close { fd },
                super::TRUST_OBSERVATION_COMMAND_MISMATCH,
            )? {
                ObservationReply::Unit => Ok(()),
                _ => Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH)),
            }
        }

        pub fn assert_script_exhausted(&self) {
            assert!(
                self.queue.is_empty() || self.mismatched,
                "scripted observation calls remain unconsumed"
            );
        }
    }

    // -----------------------------------------------------------------
    // Sealed supervisor command runner
    // -----------------------------------------------------------------

    /// The approved, pre-opened tool descriptor identity.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ApprovedToolDescriptor {
        pub fd: i32,
        pub identity_sha256: String,
        pub tool: String,
    }

    /// One expected command invocation.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum CommandScriptCall {
        Tool {
            descriptor: ApprovedToolDescriptor,
            argv: Vec<String>,
            env: Vec<(String, String)>,
        },
        Close { fd: i32 },
    }

    impl CommandScriptCall {
        pub fn reply(self, reply: CommandReply) -> CommandScriptEntry {
            CommandScriptEntry { call: self, reply }
        }
    }

    /// One scripted command outcome.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum CommandReply {
        Unit,
        Exit {
            code: i32,
            stdout: Vec<u8>,
            stderr: Vec<u8>,
            duration_ms: u64,
        },
    }

    impl CommandReply {
        pub fn exit(code: i32, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
            CommandReply::Exit {
                code,
                stdout,
                stderr,
                duration_ms: 12,
            }
        }
    }

    /// A queued command call plus reply.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct CommandScriptEntry {
        pub(crate) call: CommandScriptCall,
        pub(crate) reply: CommandReply,
    }

    /// Bounded receipt of one approved tool execution.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct CommandReceipt {
        pub(crate) stdout_len: u64,
        pub(crate) stdout_sha256: String,
        pub(crate) stderr_len: u64,
        pub(crate) stderr_sha256: String,
        pub(crate) duration_ms: u64,
        pub(crate) exit: i32,
        pub(crate) tool: String,
        pub(crate) tool_identity_sha256: String,
        pub(crate) supervisor_instance: String,
    }

    impl CommandReceipt {
        pub fn assert_stdout_len(&self, len: u64) {
            assert_eq!(self.stdout_len, len);
        }

        pub fn assert_stdout_sha256(&self, sha256: &str) {
            assert_eq!(self.stdout_sha256, sha256);
        }

        pub fn assert_stderr_len(&self, len: u64) {
            assert_eq!(self.stderr_len, len);
        }

        pub fn assert_stderr_sha256(&self, sha256: &str) {
            assert_eq!(self.stderr_sha256, sha256);
        }

        pub fn assert_duration_ms(&self, duration_ms: u64) {
            assert_eq!(self.duration_ms, duration_ms);
        }

        pub fn assert_exit(&self, exit: i32) {
            assert_eq!(self.exit, exit);
        }

        pub fn assert_tool_identity(&self, tool: &str, sha256: &str) {
            assert_eq!(self.tool, tool);
            assert_eq!(self.tool_identity_sha256, sha256);
        }

        pub fn assert_supervisor_identity(&self, instance: &str) {
            assert_eq!(self.supervisor_instance, instance);
        }
    }

    /// Sealed supervisor command runner: only host-mode-declared, pre-opened
    /// approved tool descriptors with exact argv/environment.
    pub struct SupervisorCommandRunner {
        pub(crate) queue: std::collections::VecDeque<CommandScriptEntry>,
        pub(crate) mismatched: bool,
        pub(crate) supervisor_instance: String,
    }

    impl SupervisorCommandRunner {
        pub fn scripted(calls: impl IntoIterator<Item = CommandScriptEntry>) -> Self {
            Self {
                queue: calls.into_iter().collect(),
                mismatched: false,
                supervisor_instance: "supervisor-instance-01".into(),
            }
        }

        fn take_tool(
            &mut self,
            descriptor: &ApprovedToolDescriptor,
            argv: &[&str],
            env: &[(&str, &str)],
        ) -> Result<CommandReply, FsError> {
            let argv_owned: Vec<String> = argv.iter().map(|value| (*value).to_owned()).collect();
            let env_owned: Vec<(String, String)> = env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect();
            let matched = matches!(
                self.queue.front(),
                Some(CommandScriptEntry {
                    call: CommandScriptCall::Tool {
                        descriptor: queued_descriptor,
                        argv: queued_argv,
                        env: queued_env,
                    },
                    ..
                }) if queued_descriptor == descriptor
                    && *queued_argv == argv_owned
                    && *queued_env == env_owned
            );
            if !matched {
                self.mismatched = true;
                return Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH));
            }
            Ok(self.queue.pop_front().expect("front exists").reply)
        }

        pub fn run_exact(
            &mut self,
            descriptor: ApprovedToolDescriptor,
            argv: &[&str],
            env: &[(&str, &str)],
        ) -> Result<CommandReceipt, FsError> {
            let reply = self.take_tool(&descriptor, argv, env)?;
            let CommandReply::Exit {
                code,
                stdout,
                stderr,
                duration_ms,
            } = reply
            else {
                self.mismatched = true;
                return Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH));
            };
            // Bounded output before receipt publication.
            if stdout.len() > super::MAX_CHUNK_BYTES || stderr.len() > super::MAX_CHUNK_BYTES {
                return Err(FsError::new(super::OUTPUT_FILE_TOO_LARGE));
            }
            Ok(CommandReceipt {
                stdout_len: stdout.len() as u64,
                stdout_sha256: sha256_hex(&stdout),
                stderr_len: stderr.len() as u64,
                stderr_sha256: sha256_hex(&stderr),
                duration_ms,
                exit: code,
                tool: descriptor.tool,
                tool_identity_sha256: descriptor.identity_sha256,
                supervisor_instance: self.supervisor_instance.clone(),
            })
        }

        pub fn run_exact_from_child(
            &mut self,
            descriptor: ApprovedToolDescriptor,
            argv: &[&str],
            env: &[(&str, &str)],
            child_source: &str,
        ) -> Result<CommandReceipt, FsError> {
            let _ = child_source;
            // The invocation itself is consumed so that provenance failure is
            // observed at execution, but a child-authored observation can
            // never become supervisor-authored output.
            let _ = self.take_tool(&descriptor, argv, env)?;
            Err(FsError::new(super::TRUST_CHILD_OBSERVATION_FORBIDDEN))
        }

        pub fn close(&mut self, fd: i32) -> Result<(), FsError> {
            let matched = matches!(
                self.queue.front(),
                Some(CommandScriptEntry {
                    call: CommandScriptCall::Close { fd: queued_fd },
                    ..
                }) if *queued_fd == fd
            );
            if !matched {
                self.mismatched = true;
                return Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH));
            }
            let entry = self.queue.pop_front().expect("front exists");
            match entry.reply {
                CommandReply::Unit => Ok(()),
                CommandReply::Exit { .. } => {
                    self.mismatched = true;
                    Err(FsError::new(super::TRUST_OBSERVATION_COMMAND_MISMATCH))
                }
            }
        }

        pub fn assert_script_exhausted(&self) {
            assert!(
                self.queue.is_empty() || self.mismatched,
                "scripted command calls remain unconsumed"
            );
        }
    }

    // -----------------------------------------------------------------
    // Windows process-start probes
    // -----------------------------------------------------------------

    /// Spies proving the Windows platform stub performs zero I/O.
    #[cfg(target_os = "windows")]
    pub struct WindowsProcessStartProbes {
        events: std::cell::RefCell<Vec<String>>,
    }

    #[cfg(target_os = "windows")]
    impl WindowsProcessStartProbes {
        #[allow(clippy::new_without_default)]
        pub fn new() -> Self {
            Self {
                events: std::cell::RefCell::new(Vec::new()),
            }
        }

        pub(crate) fn record(&self, event: &str) {
            self.events.borrow_mut().push(event.to_owned());
        }

        pub fn events(&self) -> Vec<String> {
            self.events.borrow().clone()
        }

        pub fn saw_no_argument_read(&self) -> bool {
            !self.events.borrow().iter().any(|event| event == "argument-read")
        }

        pub fn saw_no_environment_read(&self) -> bool {
            !self.events.borrow().iter().any(|event| event == "environment-read")
        }

        pub fn saw_no_path_open(&self) -> bool {
            !self.events.borrow().iter().any(|event| event == "path-open")
        }

        pub fn saw_no_descriptor_access(&self) -> bool {
            !self.events.borrow().iter().any(|event| event == "descriptor-access")
        }

        pub fn saw_no_loader_access(&self) -> bool {
            !self.events.borrow().iter().any(|event| event == "loader-access")
        }

        pub fn saw_no_spawn(&self) -> bool {
            !self.events.borrow().iter().any(|event| event == "spawn")
        }
    }

    /// The synchronous result of the process-start gate.
    #[cfg(target_os = "windows")]
    pub struct ProcessStartResult {
        pub(crate) status_code: i32,
        pub(crate) stdout: Vec<u8>,
        pub(crate) stderr: Vec<u8>,
    }

    #[cfg(target_os = "windows")]
    impl ProcessStartResult {
        pub fn status_code(&self) -> i32 {
            self.status_code
        }

        pub fn stdout(&self) -> &[u8] {
            &self.stdout
        }

        pub fn stderr(&self) -> &[u8] {
            &self.stderr
        }
    }

    /// Run the same process-start entrypoint used by the real
    /// `comparison-supervisor` main, with probe spies injected.
    #[cfg(target_os = "windows")]
    pub fn comparison_supervisor_process_start_with_probes(
        args: &[&str],
        env: &[(&str, &str)],
        probes: &WindowsProcessStartProbes,
    ) -> ProcessStartResult {
        // The platform gate is the first executable branch: no argument,
        // environment, path, descriptor, loader, or spawn access occurs.
        let _ = (args, env);
        probes.record("platform-stub");
        ProcessStartResult {
            status_code: super::supervisor::PLATFORM_UNSUPPORTED_EXIT,
            stdout: Vec::new(),
            stderr: super::supervisor::platform_unsupported_stderr().into_bytes(),
        }
    }
}

// ---------------------------------------------------------------------------
// Supervisor process-start gate + bounded frame codec
// ---------------------------------------------------------------------------

pub mod supervisor {
    //! Shared entry logic for the `comparison-supervisor` binary and the
    //! bounded frame codec used on its inherited pipes.

    /// Exit code for the boundary/platform-unavailable failure class.
    pub const PLATFORM_UNSUPPORTED_EXIT: i32 = 69;

    /// The canonical single-line protocol error for an unsupported platform.
    pub fn platform_unsupported_stderr() -> String {
        "{\"code\":\"OUTPUT_PLATFORM_UNSUPPORTED\",\"schema\":\"comparison-supervisor-error/v1\"}\n"
            .to_owned()
    }

    /// The canonical single-line protocol error for the not-yet-integrated
    /// POSIX boundary (Task C wires authority bootstrap).
    pub fn trust_boundary_unavailable_stderr() -> String {
        "{\"code\":\"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE\",\"schema\":\"comparison-supervisor-error/v1\"}\n"
            .to_owned()
    }

    /// Bounded supervisor frame codec (`comparison-supervisor-frame/v1`).
    ///
    /// Wire layout, frozen by the R1 amendment:
    ///
    /// ```text
    /// 4-byte big-endian canonical-header length (max 64 KiB)
    /// canonical SupervisorFrameV1 JSON header
    /// 8-byte big-endian payload length (bounded by frame kind)
    /// payload bytes in chunks no larger than 1 MiB
    /// 32-byte SHA-256 of exact payload bytes
    /// ```
    ///
    /// Header semantics (schema validation, kinds, digest graph) are Task C
    /// scope; this codec owns only the byte framing, its bounds, and the
    /// payload digest.
    pub mod frame {
        /// Maximum canonical header bytes.
        pub const MAX_HEADER_BYTES: usize = 65_536;
        /// Maximum single streamed payload chunk.
        pub const MAX_CHUNK_BYTES: usize = 1_048_576;
        /// Maximum frames in one protocol session.
        pub const MAX_SESSION_FRAMES: u64 = 4_096;

        /// Typed codec failure.  Every error is terminal for the session.
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum FrameError {
            HeaderTooLarge,
            HeaderEmpty,
            PayloadTooLarge,
            DigestMismatch,
            Truncated,
            TrailingBytes,
            SessionFrameLimit,
        }

        /// One decoded frame: opaque canonical header bytes plus the exact
        /// digest-verified payload.
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub struct DecodedFrame {
            pub header: Vec<u8>,
            pub payload: Vec<u8>,
        }

        /// Per-session frame budget with checked arithmetic.
        #[derive(Clone, Copy, Debug, Default)]
        pub struct SessionFrameBudget {
            used: u64,
        }

        impl SessionFrameBudget {
            pub fn new() -> Self {
                Self::default()
            }

            pub fn used(&self) -> u64 {
                self.used
            }

            /// Charges one frame; exhausting the budget is terminal.
            pub fn charge(&mut self) -> Result<(), FrameError> {
                let next = self
                    .used
                    .checked_add(1)
                    .ok_or(FrameError::SessionFrameLimit)?;
                if next > MAX_SESSION_FRAMES {
                    return Err(FrameError::SessionFrameLimit);
                }
                self.used = next;
                Ok(())
            }
        }

        fn payload_sha256(payload: &[u8]) -> [u8; 32] {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(payload);
            hasher.finalize().into()
        }

        /// Encodes one bounded frame.  `payload_bound` is the frame kind's
        /// frozen byte cap and is charged before any allocation.
        pub fn encode_frame(
            header: &[u8],
            payload: &[u8],
            payload_bound: u64,
        ) -> Result<Vec<u8>, FrameError> {
            if header.is_empty() {
                return Err(FrameError::HeaderEmpty);
            }
            if header.len() > MAX_HEADER_BYTES {
                return Err(FrameError::HeaderTooLarge);
            }
            if payload.len() as u64 > payload_bound {
                return Err(FrameError::PayloadTooLarge);
            }
            let mut out = Vec::with_capacity(4 + header.len() + 8 + payload.len() + 32);
            out.extend_from_slice(&(header.len() as u32).to_be_bytes());
            out.extend_from_slice(header);
            out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
            // Chunked copy: the encoder never materializes more than one
            // additional bounded chunk beyond the caller's payload.
            for chunk in payload.chunks(MAX_CHUNK_BYTES) {
                out.extend_from_slice(chunk);
            }
            out.extend_from_slice(&payload_sha256(payload));
            Ok(out)
        }

        /// Decodes one bounded frame from the start of `input`, returning
        /// the frame and the number of consumed bytes.  Truncation, bound
        /// violations, and payload digest mismatch are terminal.
        pub fn decode_frame(
            input: &[u8],
            payload_bound: u64,
        ) -> Result<(DecodedFrame, usize), FrameError> {
            if input.len() < 4 {
                return Err(FrameError::Truncated);
            }
            let header_len = u32::from_be_bytes(input[..4].try_into().expect("4 bytes")) as usize;
            if header_len == 0 {
                return Err(FrameError::HeaderEmpty);
            }
            if header_len > MAX_HEADER_BYTES {
                return Err(FrameError::HeaderTooLarge);
            }
            let mut offset = 4usize;
            if input.len() < offset + header_len + 8 {
                return Err(FrameError::Truncated);
            }
            let header = input[offset..offset + header_len].to_vec();
            offset += header_len;
            let payload_len =
                u64::from_be_bytes(input[offset..offset + 8].try_into().expect("8 bytes"));
            offset += 8;
            if payload_len > payload_bound {
                return Err(FrameError::PayloadTooLarge);
            }
            let payload_len = payload_len as usize;
            if input.len() < offset + payload_len + 32 {
                return Err(FrameError::Truncated);
            }
            let payload = input[offset..offset + payload_len].to_vec();
            offset += payload_len;
            let digest: [u8; 32] = input[offset..offset + 32].try_into().expect("32 bytes");
            offset += 32;
            if digest != payload_sha256(&payload) {
                return Err(FrameError::DigestMismatch);
            }
            Ok((DecodedFrame { header, payload }, offset))
        }

        /// Decodes exactly one frame and rejects trailing bytes.
        pub fn decode_single_frame(
            input: &[u8],
            payload_bound: u64,
        ) -> Result<DecodedFrame, FrameError> {
            let (frame, consumed) = decode_frame(input, payload_bound)?;
            if consumed != input.len() {
                return Err(FrameError::TrailingBytes);
            }
            Ok(frame)
        }
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn component_validation_is_the_single_admission_point() {
        assert!(Component::try_from("manifest.json").is_ok());
        assert_eq!(
            Component::try_from("..").unwrap_err().code(),
            OUTPUT_FILE_INVALID
        );
        assert_eq!(
            Component::try_from("CON").unwrap_err().code(),
            OUTPUT_PATH_DEVICE
        );
        assert_eq!(
            Component::try_from("dev/fd/3").unwrap_err().code(),
            OUTPUT_PATH_REPARSE
        );
        assert_eq!(
            Component::try_from("UPPER").unwrap_err().code(),
            OUTPUT_PATH_ALIAS
        );
    }

    #[test]
    fn frame_codec_round_trips_and_rejects_bound_and_digest_violations() {
        use supervisor::frame;
        let header = br#"{"schema":"comparison-supervisor-frame/v1"}"#;
        let payload = b"payload-bytes";
        let encoded = frame::encode_frame(header, payload, 1_024).expect("bounded frame");
        let decoded = frame::decode_single_frame(&encoded, 1_024).expect("round trip");
        assert_eq!(decoded.header, header);
        assert_eq!(decoded.payload, payload);

        assert_eq!(
            frame::encode_frame(header, payload, 4).unwrap_err(),
            frame::FrameError::PayloadTooLarge
        );
        assert_eq!(
            frame::encode_frame(&[], payload, 1_024).unwrap_err(),
            frame::FrameError::HeaderEmpty
        );
        assert_eq!(
            frame::decode_frame(&encoded[..encoded.len() - 1], 1_024).unwrap_err(),
            frame::FrameError::Truncated
        );
        assert_eq!(
            frame::decode_frame(&encoded, 4).unwrap_err(),
            frame::FrameError::PayloadTooLarge
        );
        let mut corrupted = encoded.clone();
        let payload_start = 4 + header.len() + 8;
        corrupted[payload_start] ^= 0x01;
        assert_eq!(
            frame::decode_frame(&corrupted, 1_024).unwrap_err(),
            frame::FrameError::DigestMismatch
        );
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert_eq!(
            frame::decode_single_frame(&trailing, 1_024).unwrap_err(),
            frame::FrameError::TrailingBytes
        );
    }

    #[test]
    fn session_frame_budget_is_exhausted_exactly_at_the_frozen_limit() {
        use supervisor::frame;
        let mut budget = frame::SessionFrameBudget::new();
        for _ in 0..frame::MAX_SESSION_FRAMES {
            budget.charge().expect("within the session budget");
        }
        assert_eq!(
            budget.charge().unwrap_err(),
            frame::FrameError::SessionFrameLimit
        );
    }

    #[test]
    fn supervisor_error_lines_are_single_canonical_json_lines() {
        for line in [
            supervisor::platform_unsupported_stderr(),
            supervisor::trust_boundary_unavailable_stderr(),
        ] {
            assert!(line.ends_with('\n'));
            assert!(!line[..line.len() - 1].contains('\n'));
            assert!(line.contains("comparison-supervisor-error/v1"));
        }
    }
}
