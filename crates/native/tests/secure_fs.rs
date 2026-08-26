//! R1 RED contract for the native, descriptor-relative comparison filesystem.
//!
//! This target is deliberately written against `src/secure_fs.rs`, which is
//! not present in the R1 RED starting tree.  The first focused run must fail
//! because the production boundary/API is absent; it must not be made green by
//! adding a test-local filesystem implementation.  Once Task B adds the
//! boundary, these tests exercise its test-only scripted syscall seam without
//! touching a real filesystem or opening a socket.
//!
//! The current package exposes only a `cdylib`, so this integration target
//! cannot link a native rlib yet.  The path import below isolates that missing
//! library/API surface as the intentional RED compile failure; enabling an
//! rlib and moving the boundary into the linked library are production/Cargo
//! work owned by the implementation task, not test-local work here.
//!
//! The expected seam is intentionally narrow:
//!
//! * `SecureFs::with_syscalls(ScriptedSyscalls)` owns the sealed syscall
//!   implementation, while `with_syscalls_and_context` adds only deterministic
//!   supervisor/nonce/clock/reservation inputs for campaign tests; neither
//!   constructor exposes ambient process state;
//! * `ScriptedSyscalls` consumes an exact ordered queue of `ScriptedCall`s and
//!   rejects missing, reordered, path-based, or extra calls;
//! * every error exposes a stable `code()` string; and
//! * opaque directory/read/write/token values do not expose raw paths or file
//!   descriptors to a caller.
//!
//! Keeping the contract here, rather than using `std::fs` fixtures, is
//! important: the race, short-I/O, durability, and provenance claims must be
//! deterministic and must prove the native call order.
//!
//! Source-level no-bypass checking is deliberately not claimed by this Rust
//! target.  Task A's tracked TypeScript checker owns the repository source
//! graph scan and its runtime probes; this file only specifies native syscall
//! and process-entry seams, without importing the checker or pretending to
//! validate source ownership through a string-pattern fixture.

#![allow(clippy::type_complexity)]

// Exclusive-create replies carry the creation-token ledger itself.  The
// native seam must prove that exactly one fresh entry was created and that no
// other entry ever existed; there is intentionally no synthetic ledger
// syscall in the queue.
macro_rules! created_reply {
    ($fd:expr, $nonce:expr) => {
        super::secure_fs::test_support::Reply::CreatedWithLedger {
            fd: $fd,
            token_nonce: $nonce,
            entry_count: 1,
            no_other_entry_ever_existed: true,
        }
    };
}

macro_rules! define_mac_campaign_reservation_faults_test {
    () => {
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum MacLaunchFault {
        None,
        WriteEintrShort,
        WriteEnospc,
        WriteQuota,
        WritePermission,
        LeafChmod,
        DirectoryChmod,
        LeafSync,
        ParentSync,
        RootSync,
        RehashDigest,
        IdentityReplaced,
        ExecutableCloexec,
        ExecutableAccessMode,
        RoleTrailing,
        RolePremature,
        AddonTrailing,
        AddonPremature,
        StartupCloexec,
        StartupAccessMode,
        RoleCloexec,
        RoleAccessMode,
        AddonCloexec,
        AddonAccessMode,
        ProtocolInCloexec,
        ProtocolInAccessMode,
        ProtocolOutCloexec,
        ProtocolOutAccessMode,
        Spawn,
    }

    fn append_mac_failure_cleanup_for(calls: &mut Vec<ScriptedCall>, leaf: &str) {
        calls.extend([
            ScriptedCall::ok(
                Syscall::Close { fd: STAGED_EXEC_FD },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Unlinkat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: leaf.into(),
                    token_nonce: 41,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ),
        ]);
    }

    fn append_mac_failure_cleanup(calls: &mut Vec<ScriptedCall>) {
        append_mac_failure_cleanup_for(calls, "bun");
    }

    fn append_mac_reopen_failure_cleanup_for(calls: &mut Vec<ScriptedCall>, leaf: &str) {
        calls.extend([
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Unlinkat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: leaf.into(),
                    token_nonce: 41,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ),
        ]);
    }

    fn append_mac_reopen_failure_cleanup(calls: &mut Vec<ScriptedCall>) {
        append_mac_reopen_failure_cleanup_for(calls, "bun");
    }

    fn append_mac_read_descriptor(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
        bytes: &[u8],
        fcntl_fd_reply: Reply,
        fcntl_fl: u64,
        terminal: Reply,
    ) {
        calls.extend([
            ScriptedCall::ok(
                Syscall::Fstat { fd },
                Reply::FileIdentity(identity.clone()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd }, fcntl_fd_reply),
            ScriptedCall::ok(Syscall::FcntlGetFl { fd }, Reply::Flags(fcntl_fl)),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            // Every opened Mac descriptor carries the complete provenance
            // tuple, not only a statfs identity: volume UUID, canonical
            // F_GETPATH bytes, and the matching getfsstat record.
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid { fd },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath { fd },
                Reply::Path(format!("/Volumes/r1/descriptor/{fd}")),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: bytes.len().max(1),
                },
                Reply::Bytes(bytes.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd },
                Reply::FileIdentity(identity.clone()),
            ),
        ]);
        if fd == STARTUP_NONCE_FD {
            calls.insert(
                calls.len() - 1,
                ScriptedCall::ok(
                    Syscall::Read {
                        fd,
                        max: STARTUP_DIGEST_BYTES.len(),
                    },
                    Reply::Bytes(STARTUP_DIGEST_BYTES.to_vec()),
                ),
            );
            calls.insert(
                calls.len() - 1,
                ScriptedCall::ok(
                    Syscall::Read {
                        fd,
                        max: STARTUP_DIGEST_BYTES.len(),
                    },
                    Reply::Bytes(Vec::new()),
                ),
            );
        } else {
            calls.insert(
                calls.len() - 1,
                ScriptedCall::ok(
                    Syscall::Read {
                        fd,
                        max: bytes.len().max(1),
                    },
                    terminal,
                ),
            );
        }
    }

    fn append_mac_inherited_descriptor(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
        bytes: &[u8],
        access: u64,
        terminal: Reply,
    ) {
        append_mac_read_descriptor(
            calls,
            fd,
            identity,
            filesystem,
            bytes,
            Reply::Inheritable,
            access,
            terminal,
        );
    }

    fn append_mac_descriptor_mode_failure(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        cloexec_fault: bool,
        access_fault: bool,
    ) {
        calls.push(ScriptedCall::ok(
            Syscall::Fstat { fd },
            Reply::FileIdentity(identity.clone()),
        ));
        if cloexec_fault {
            calls.push(ScriptedCall::ok(
                Syscall::FcntlGetFd { fd },
                Reply::CloseOnExec,
            ));
        } else {
            calls.push(ScriptedCall::ok(
                Syscall::FcntlGetFd { fd },
                Reply::Inheritable,
            ));
            if access_fault {
                calls.push(ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd },
                    Reply::Flags(super::WRITER_ACCESS_MODE),
                ));
            }
        }
    }

    fn append_mac_inherited_failure_cleanup_for(
        calls: &mut Vec<ScriptedCall>,
        failed_fd: i32,
        leaf: &str,
    ) {
        for fd in match failed_fd {
            STARTUP_NONCE_FD => vec![STARTUP_NONCE_FD, EXEC_FD],
            ROLE_FD => vec![ROLE_FD, STARTUP_NONCE_FD, EXEC_FD],
            ADDON_FD => vec![ADDON_FD, ROLE_FD, STARTUP_NONCE_FD, EXEC_FD],
            PROTOCOL_IN_FD => vec![
                PROTOCOL_IN_FD,
                ADDON_FD,
                ROLE_FD,
                STARTUP_NONCE_FD,
                EXEC_FD,
            ],
            PROTOCOL_OUT_FD => vec![
                PROTOCOL_OUT_FD,
                PROTOCOL_IN_FD,
                ADDON_FD,
                ROLE_FD,
                STARTUP_NONCE_FD,
                EXEC_FD,
            ],
            _ => vec![EXEC_FD],
        } {
            calls.push(ScriptedCall::ok(Syscall::Close { fd }, Reply::Unit));
        }
        calls.push(ScriptedCall::ok(
            Syscall::Unlinkat {
                dirfd: super::posix_red::PARENT_FD,
                component: leaf.into(),
                token_nonce: 41,
            },
            Reply::Unit,
        ));
        calls.push(ScriptedCall::ok(
            Syscall::Close {
                fd: super::posix_red::PARENT_FD,
            },
            Reply::Unit,
        ));
    }

    fn append_mac_inherited_failure_cleanup(calls: &mut Vec<ScriptedCall>, failed_fd: i32) {
        append_mac_inherited_failure_cleanup_for(calls, failed_fd, "bun");
    }

    fn bun_launch_env() -> Vec<(String, String)> {
        vec![
            ("LC_ALL".into(), "C".into()),
            ("WT_COMPARISON_PROTOCOL_IN_FD".into(), "205".into()),
            ("WT_COMPARISON_PROTOCOL_OUT_FD".into(), "206".into()),
            ("WT_COMPARISON_STARTUP_NONCE_FD".into(), "207".into()),
            ("WT_COMPARISON_STRICT_ADDON_FD".into(), "/dev/fd/203".into()),
        ]
    }

    fn mac_launch_calls(
        expected: &DirectoryIdentity,
        executable: &FileIdentity,
        context: &super::secure_fs::test_support::LaunchContextV1,
        receipt: &super::secure_fs::test_support::LaunchReceiptV1,
        fault: MacLaunchFault,
    ) -> Vec<ScriptedCall> {
        mac_launch_calls_for(
            expected,
            executable,
            context,
            fault,
            "exec-private-01",
            "bun",
            receipt.argv.clone(),
            bun_launch_env(),
        )
    }

    fn mac_launch_calls_for(
        expected: &DirectoryIdentity,
        executable: &FileIdentity,
        context: &super::secure_fs::test_support::LaunchContextV1,
        fault: MacLaunchFault,
        sealed_component: &str,
        sealed_leaf: &str,
        spawn_argv: Vec<String>,
        spawn_env: Vec<(String, String)>,
    ) -> Vec<ScriptedCall> {
        let mut calls = adopt_calls(expected);
        let mut source_identity = executable.clone();
        source_identity.set_inode("6101");
        source_identity = source_identity.with_size(EXECUTABLE_BYTES.len() as u64);

        // The approved source descriptor is read, hashed, consumed to EOF,
        // and closed before the destination descriptor is ever allocated.
        append_mac_read_descriptor(
            &mut calls,
            SOURCE_EXEC_FD,
            &source_identity,
            expected,
            EXECUTABLE_BYTES,
            Reply::CloseOnExec,
            super::READ_ONLY_ACCESS_MODE,
            Reply::Bytes(Vec::new()),
        );
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: SOURCE_EXEC_FD },
            Reply::Unit,
        ));

        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: sealed_component.into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: sealed_component.into(),
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Directory,
                    inode: "9300".into(),
                    mode: 0o700,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: sealed_component.into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(super::posix_red::PARENT_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Directory,
                    inode: "9300".into(),
                    mode: 0o700,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Path(format!("/Volumes/r1/staging/{sealed_component}")),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::PARENT_FD,
                    component: sealed_leaf.into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: sealed_leaf.into(),
                    flags: super::MACOS_CREATE_FLAGS,
                    mode: 0o600,
                },
                created_reply!(STAGED_EXEC_FD, 41),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: STAGED_EXEC_FD },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    mode: 0o600,
                    size: 0,
                    ..executable.clone()
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: STAGED_EXEC_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: STAGED_EXEC_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: STAGED_EXEC_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid { fd: STAGED_EXEC_FD },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath { fd: STAGED_EXEC_FD },
                Reply::Path(format!("/Volumes/r1/staging/{sealed_component}/{sealed_leaf}")),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
        ]);

        match fault {
            MacLaunchFault::WriteEintrShort => {
                let split = 7;
                calls.extend([
                    ScriptedCall::error(
                        Syscall::Write {
                            fd: STAGED_EXEC_FD,
                            bytes: EXECUTABLE_BYTES.to_vec(),
                        },
                        Errno::Eintr,
                    ),
                    ScriptedCall::ok(
                        Syscall::Write {
                            fd: STAGED_EXEC_FD,
                            bytes: EXECUTABLE_BYTES.to_vec(),
                        },
                        Reply::Written(split),
                    ),
                    ScriptedCall::ok(
                        Syscall::Write {
                            fd: STAGED_EXEC_FD,
                            bytes: EXECUTABLE_BYTES[split..].to_vec(),
                        },
                        Reply::Written(EXECUTABLE_BYTES.len() - split),
                    ),
                ]);
            }
            MacLaunchFault::WriteEnospc
            | MacLaunchFault::WriteQuota
            | MacLaunchFault::WritePermission => {
                let errno = match fault {
                    MacLaunchFault::WriteEnospc => Errno::NoSpace,
                    MacLaunchFault::WriteQuota => Errno::Quota,
                    MacLaunchFault::WritePermission => Errno::Permission,
                    _ => unreachable!(),
                };
                calls.push(ScriptedCall::error(
                    Syscall::Write {
                        fd: STAGED_EXEC_FD,
                        bytes: EXECUTABLE_BYTES.to_vec(),
                    },
                    errno,
                ));
                append_mac_failure_cleanup_for(&mut calls, sealed_leaf);
                return calls;
            }
            _ => calls.push(ScriptedCall::ok(
                Syscall::Write {
                    fd: STAGED_EXEC_FD,
                    bytes: EXECUTABLE_BYTES.to_vec(),
                },
                Reply::Written(EXECUTABLE_BYTES.len()),
            )),
        }

        calls.push(ScriptedCall::ok(
            Syscall::Fstat { fd: STAGED_EXEC_FD },
            Reply::FileIdentity(FileIdentity {
                kind: FileKind::Regular,
                mode: 0o600,
                size: EXECUTABLE_BYTES.len() as u64,
                ..executable.clone()
            }),
        ));
        let leaf_sync = if fault == MacLaunchFault::LeafSync {
            ScriptedCall::error(Syscall::Fdatasync { fd: STAGED_EXEC_FD }, Errno::Permission)
        } else {
            ScriptedCall::ok(Syscall::Fdatasync { fd: STAGED_EXEC_FD }, Reply::Unit)
        };
        calls.push(leaf_sync);
        if fault == MacLaunchFault::LeafSync {
            append_mac_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        let parent_sync = if fault == MacLaunchFault::ParentSync {
            ScriptedCall::error(
                Syscall::Fsync {
                    fd: super::posix_red::PARENT_FD,
                },
                Errno::Permission,
            )
        } else {
            ScriptedCall::ok(
                Syscall::Fsync {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            )
        };
        calls.push(parent_sync);
        if fault == MacLaunchFault::ParentSync {
            append_mac_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        let root_sync = if fault == MacLaunchFault::RootSync {
            ScriptedCall::error(Syscall::Fsync { fd: PINNED_ROOT_FD }, Errno::Permission)
        } else {
            ScriptedCall::ok(Syscall::Fsync { fd: PINNED_ROOT_FD }, Reply::Unit)
        };
        calls.push(root_sync);
        if fault == MacLaunchFault::RootSync {
            append_mac_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }

        let leaf_chmod = if fault == MacLaunchFault::LeafChmod {
            ScriptedCall::error(
                Syscall::Fchmod {
                    fd: STAGED_EXEC_FD,
                    mode: 0o500,
                },
                Errno::Permission,
            )
        } else {
            ScriptedCall::ok(
                Syscall::Fchmod {
                    fd: STAGED_EXEC_FD,
                    mode: 0o500,
                },
                Reply::Unit,
            )
        };
        calls.push(leaf_chmod);
        if fault == MacLaunchFault::LeafChmod {
            append_mac_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }

        let directory_chmod = if fault == MacLaunchFault::DirectoryChmod {
            ScriptedCall::error(
                Syscall::Fchmod {
                    fd: super::posix_red::PARENT_FD,
                    mode: 0o500,
                },
                Errno::Permission,
            )
        } else {
            ScriptedCall::ok(
                Syscall::Fchmod {
                    fd: super::posix_red::PARENT_FD,
                    mode: 0o500,
                },
                Reply::Unit,
            )
        };
        calls.push(directory_chmod);
        if fault == MacLaunchFault::DirectoryChmod {
            append_mac_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }

        // Creation-token/no-other-entry proof is carried by the approved
        // exclusive-create reply, not by a synthetic syscall.  The native
        // implementation must preserve this ledger evidence on the returned
        // token and reject a reply that reports any prior or extra entry.
        calls.extend([
            ScriptedCall::ok(
                Syscall::Close { fd: STAGED_EXEC_FD },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: sealed_leaf.into(),
                    flags: super::MACOS_READ_FLAGS,
                    mode: 0,
                },
                Reply::Fd(EXEC_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(if fault == MacLaunchFault::IdentityReplaced {
                    executable.clone().with_inode("7002")
                } else {
                    executable.clone()
                }),
            ),
        ]);
        if fault == MacLaunchFault::IdentityReplaced {
            append_mac_reopen_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        if fault == MacLaunchFault::ExecutableCloexec {
            calls.push(ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: EXEC_FD },
                Reply::Inheritable,
            ));
            append_mac_reopen_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        if fault == MacLaunchFault::ExecutableAccessMode {
            calls.extend([
                ScriptedCall::ok(Syscall::FcntlGetFd { fd: EXEC_FD }, Reply::CloseOnExec),
                ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd: EXEC_FD },
                    Reply::Flags(super::WRITER_ACCESS_MODE),
                ),
            ]);
            append_mac_reopen_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        calls.extend([
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: EXEC_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: EXEC_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: EXEC_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath { fd: EXEC_FD },
                Reply::Path(format!("/Volumes/r1/staging/{sealed_component}/{sealed_leaf}")),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid { fd: EXEC_FD },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
        ]);
        calls.push(if fault == MacLaunchFault::RehashDigest {
            ScriptedCall::ok(
                Syscall::Read {
                    fd: EXEC_FD,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(b"#!/usr/bin/env bun!\n".to_vec()),
            )
        } else {
            ScriptedCall::ok(
                Syscall::Read {
                    fd: EXEC_FD,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(EXECUTABLE_BYTES.to_vec()),
            )
        });
        calls.push(ScriptedCall::ok(
            Syscall::Read {
                fd: EXEC_FD,
                max: EXECUTABLE_BYTES.len(),
            },
            Reply::Bytes(Vec::new()),
        ));
        if fault == MacLaunchFault::RehashDigest {
            append_mac_reopen_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        calls.extend([
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Directory,
                    inode: "9300".into(),
                    mode: 0o500,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Path(format!("/Volumes/r1/staging/{sealed_component}")),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
            ScriptedCall::ok(
                Syscall::Fchdir {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ),
        ]);

        let role_identity = executable.clone().with_inode("7202").with_size(ROLE_BYTES.len() as u64);
        let addon_identity = executable.clone().with_inode("7203").with_size(ADDON_BYTES.len() as u64);
        let protocol_in_identity = pipe_identity(
            executable,
            "7204",
            PROTOCOL_IN_BYTES.len() as u64,
        );
        let protocol_out_identity = pipe_identity(
            executable,
            "7205",
            PROTOCOL_OUT_BYTES.len() as u64,
        );
        let startup_identity = pipe_identity(
            executable,
            "7206",
            STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
        );
        let role_payload = if fault == MacLaunchFault::RolePremature {
            &ROLE_BYTES[..ROLE_BYTES.len() - 1]
        } else {
            ROLE_BYTES
        };
        let role_terminal = if fault == MacLaunchFault::RoleTrailing {
            Reply::Bytes(b"unexpected-role-trailing\n".to_vec())
        } else {
            Reply::Bytes(Vec::new())
        };
        let addon_payload = if fault == MacLaunchFault::AddonPremature {
            &ADDON_BYTES[..ADDON_BYTES.len() - 1]
        } else {
            ADDON_BYTES
        };
        let addon_terminal = if fault == MacLaunchFault::AddonTrailing {
            Reply::Bytes(b"unexpected-addon-trailing\n".to_vec())
        } else {
            Reply::Bytes(Vec::new())
        };
        // The startup nonce/digest handshake is consumed and validated before
        // any addon, socket, or protocol descriptor is touched.  The second
        // frame is deliberately part of the same pipe and must be consumed
        // to EOF before launch.
        if matches!(fault, MacLaunchFault::StartupCloexec | MacLaunchFault::StartupAccessMode) {
            append_mac_descriptor_mode_failure(
                &mut calls,
                STARTUP_NONCE_FD,
                &startup_identity,
                fault == MacLaunchFault::StartupCloexec,
                fault == MacLaunchFault::StartupAccessMode,
            );
            append_mac_inherited_failure_cleanup_for(&mut calls, STARTUP_NONCE_FD, sealed_leaf);
            return calls;
        }
        append_mac_inherited_descriptor(
            &mut calls,
            STARTUP_NONCE_FD,
            &startup_identity,
            expected,
            STARTUP_NONCE_BYTES,
            super::READ_ONLY_ACCESS_MODE,
            Reply::Bytes(Vec::new()),
        );
        if sealed_leaf != "bun" {
            // Observation tools have the same sealed copy/reopen/identity/
            // handshake ceremony, but no Bun role/addon/protocol descriptors.
            // Their environment is deliberately exactly the sanitized locale.
            calls.extend([
                ScriptedCall::ok(
                    Syscall::Fchdir {
                        fd: super::posix_red::PARENT_FD,
                    },
                    Reply::Unit,
                ),
                ScriptedCall::ok(
                    Syscall::PinnedDirectorySpawn {
                        executable_fd: EXEC_FD,
                        argv: spawn_argv,
                        env: spawn_env,
                        context: context.clone(),
                    },
                    Reply::ChildPid(9000),
                ),
                ScriptedCall::ok(Syscall::Waitpid { pid: 9000 }, Reply::Exit(0)),
                ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
                ScriptedCall::ok(Syscall::Close { fd: STARTUP_NONCE_FD }, Reply::Unit),
                ScriptedCall::ok(
                    Syscall::Unlinkat {
                        dirfd: super::posix_red::PARENT_FD,
                        component: sealed_leaf.into(),
                        token_nonce: 41,
                    },
                    Reply::Unit,
                ),
                ScriptedCall::ok(
                    Syscall::Close {
                        fd: super::posix_red::PARENT_FD,
                    },
                    Reply::Unit,
                ),
            ]);
            return calls;
        }
        if matches!(fault, MacLaunchFault::RoleCloexec | MacLaunchFault::RoleAccessMode) {
            append_mac_descriptor_mode_failure(
                &mut calls,
                ROLE_FD,
                &role_identity,
                fault == MacLaunchFault::RoleCloexec,
                fault == MacLaunchFault::RoleAccessMode,
            );
            append_mac_inherited_failure_cleanup_for(&mut calls, ROLE_FD, sealed_leaf);
            return calls;
        }
        append_mac_inherited_descriptor(
            &mut calls,
            ROLE_FD,
            &role_identity,
            expected,
            role_payload,
            super::READ_ONLY_ACCESS_MODE,
            role_terminal,
        );
        if matches!(fault, MacLaunchFault::RoleTrailing | MacLaunchFault::RolePremature) {
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: ROLE_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Unit,
            ));
            append_mac_reopen_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        if matches!(fault, MacLaunchFault::AddonCloexec | MacLaunchFault::AddonAccessMode) {
            append_mac_descriptor_mode_failure(
                &mut calls,
                ADDON_FD,
                &addon_identity,
                fault == MacLaunchFault::AddonCloexec,
                fault == MacLaunchFault::AddonAccessMode,
            );
            append_mac_inherited_failure_cleanup_for(&mut calls, ADDON_FD, sealed_leaf);
            return calls;
        }
        append_mac_inherited_descriptor(
            &mut calls,
            ADDON_FD,
            &addon_identity,
            expected,
            addon_payload,
            super::READ_ONLY_ACCESS_MODE,
            addon_terminal,
        );
        if matches!(fault, MacLaunchFault::AddonTrailing | MacLaunchFault::AddonPremature) {
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: ADDON_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: ROLE_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Unit,
            ));
            append_mac_reopen_failure_cleanup_for(&mut calls, sealed_leaf);
            return calls;
        }
        if matches!(
            fault,
            MacLaunchFault::ProtocolInCloexec | MacLaunchFault::ProtocolInAccessMode
        ) {
            append_mac_descriptor_mode_failure(
                &mut calls,
                PROTOCOL_IN_FD,
                &protocol_in_identity,
                fault == MacLaunchFault::ProtocolInCloexec,
                fault == MacLaunchFault::ProtocolInAccessMode,
            );
            append_mac_inherited_failure_cleanup_for(&mut calls, PROTOCOL_IN_FD, sealed_leaf);
            return calls;
        }
        append_mac_inherited_descriptor(
            &mut calls,
            PROTOCOL_IN_FD,
            &protocol_in_identity,
            expected,
            PROTOCOL_IN_BYTES,
            super::READ_ONLY_ACCESS_MODE,
            Reply::Bytes(Vec::new()),
        );
        if matches!(
            fault,
            MacLaunchFault::ProtocolOutCloexec | MacLaunchFault::ProtocolOutAccessMode
        ) {
            append_mac_descriptor_mode_failure(
                &mut calls,
                PROTOCOL_OUT_FD,
                &protocol_out_identity,
                fault == MacLaunchFault::ProtocolOutCloexec,
                fault == MacLaunchFault::ProtocolOutAccessMode,
            );
            append_mac_inherited_failure_cleanup_for(&mut calls, PROTOCOL_OUT_FD, sealed_leaf);
            return calls;
        }
        append_mac_inherited_descriptor(
            &mut calls,
            PROTOCOL_OUT_FD,
            &protocol_out_identity,
            expected,
            PROTOCOL_OUT_BYTES,
            super::WRITER_ACCESS_MODE,
            Reply::Bytes(Vec::new()),
        );
        calls.extend([
            ScriptedCall::ok(
                Syscall::PinnedDirectorySpawn {
                    executable_fd: EXEC_FD,
                    argv: spawn_argv,
                    env: spawn_env,
                    context: context.clone(),
                },
                if fault == MacLaunchFault::Spawn {
                    Reply::LaunchFailure("OUTPUT_EXEC_FAILED".into())
                } else {
                    Reply::ChildPid(9000)
                },
            ),
        ]);
        if fault == MacLaunchFault::Spawn {
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: EXEC_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: ROLE_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: ADDON_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: PROTOCOL_IN_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: PROTOCOL_OUT_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: STARTUP_NONCE_FD },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Unlinkat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: sealed_leaf.into(),
                    token_nonce: 41,
                },
                Reply::Unit,
            ));
            calls.push(ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ));
            return calls;
        }
        calls.extend([
            ScriptedCall::ok(Syscall::Waitpid { pid: 9000 }, Reply::Exit(0)),
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ROLE_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ADDON_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: PROTOCOL_IN_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: PROTOCOL_OUT_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: STARTUP_NONCE_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ),
        ]);
        calls
    }

    #[test]
    fn mac_campaign_reservation_faults_are_path_specific_and_never_partial() {
        const RESERVATION: &[u8] = br#"{"campaignId":"campaign-0001","campaignIdentity":{"canonicalDescriptorPathSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","device":"16777234","fileSystemType":"apfs","fsidWord0":"1234","fsidWord1":"5678","hardLinkCount":"1","inode":"9200","mode":448,"mountTableEntrySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ownerUid":501,"platform":"darwin","volumeUuid":"00112233445566778899aabbccddeeff"},"candidate":"candidate-01","createdAt":"2026-08-24T00:00:00Z","schema":"campaign-reservation/v1","state":"RESERVED","supervisorInstanceNonce":"nonce-0001"}
"#;
        assert_eq!(RESERVATION.last(), Some(&b'\n'));
        assert!(!RESERVATION[..RESERVATION.len() - 1].contains(&b'\n'));
        let expected = identity();
        let mut candidate = expected.clone();
        candidate.set_inode("9101");
        let mut campaign_identity = expected.clone();
        campaign_identity.set_inode("9200");
        for (fault, expected_code) in [
            ("eintr-short-write", None),
            ("enospc", Some("OUTPUT_WRITE_FAILED")),
            ("quota", Some("OUTPUT_WRITE_FAILED")),
            ("permission", Some("OUTPUT_WRITE_FAILED")),
            ("digest-parser", Some("OUTPUT_WRITE_FAILED")),
            ("leaf-sync", Some("OUTPUT_SYNC_FAILED")),
            ("child-sync", Some("OUTPUT_SYNC_FAILED")),
            ("parent-sync", Some("OUTPUT_SYNC_FAILED")),
            ("root-sync", Some("OUTPUT_SYNC_FAILED")),
            ("cleanup", Some("OUTPUT_CLEANUP_FAILED")),
        ] {
            let mut calls =
                mac_campaign_reservation_prefix(&expected, &candidate, &campaign_identity);
            match fault {
                "eintr-short-write" => {
                    let split = 32;
                    calls.extend([
                        ScriptedCall::error(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            Errno::Eintr,
                        ),
                        ScriptedCall::ok(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            Reply::Written(split),
                        ),
                        ScriptedCall::ok(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION[split..].to_vec(),
                            },
                            Reply::Written(RESERVATION.len() - split),
                        ),
                        ScriptedCall::ok(
                            Syscall::Fdatasync {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Fsync {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Fsync {
                                fd: super::posix_red::PARENT_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Fsync { fd: PINNED_ROOT_FD },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                }
                "digest-parser" => {
                    calls.extend([
                        ScriptedCall::ok(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            Reply::Written(RESERVATION.len()),
                        ),
                        // Rehashing is a real bounded read, not an invented
                        // test-only digest syscall. The changed bytes must be
                        // consumed to EOF and rejected by canonical hashing.
                        ScriptedCall::ok(
                            Syscall::Read {
                                fd: super::posix_red::LEAF_FD,
                                max: RESERVATION.len(),
                            },
                            Reply::Bytes(b"{corrupt-reservation".to_vec()),
                        ),
                        ScriptedCall::ok(
                            Syscall::Read {
                                fd: super::posix_red::LEAF_FD,
                                max: RESERVATION.len() - 1,
                            },
                            Reply::Bytes(Vec::new()),
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Unlinkat {
                                dirfd: super::posix_red::CHILD_FD,
                                component: ".campaign-reservation.json".into(),
                                token_nonce: 42,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                }
                "enospc" | "quota" | "permission" => {
                    let errno = match fault {
                        "enospc" => Errno::NoSpace,
                        "quota" => Errno::Quota,
                        "permission" => Errno::Permission,
                        _ => unreachable!(),
                    };
                    calls.extend([
                        ScriptedCall::error(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            errno,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Unlinkat {
                                dirfd: super::posix_red::CHILD_FD,
                                component: ".campaign-reservation.json".into(),
                                token_nonce: 42,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                }
                "leaf-sync" => {
                    calls.extend([
                        ScriptedCall::ok(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            Reply::Written(RESERVATION.len()),
                        ),
                        ScriptedCall::error(
                            Syscall::Fdatasync {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Errno::Permission,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Unlinkat {
                                dirfd: super::posix_red::CHILD_FD,
                                component: ".campaign-reservation.json".into(),
                                token_nonce: 42,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                }
                "child-sync" | "parent-sync" | "root-sync" => {
                    calls.extend([
                        ScriptedCall::ok(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            Reply::Written(RESERVATION.len()),
                        ),
                        ScriptedCall::ok(
                            Syscall::Fdatasync {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                    if fault == "child-sync" {
                        calls.push(ScriptedCall::error(
                            Syscall::Fsync {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Errno::Permission,
                        ));
                    } else {
                        calls.push(ScriptedCall::ok(
                            Syscall::Fsync {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ));
                        if fault == "parent-sync" {
                            calls.push(ScriptedCall::error(
                                Syscall::Fsync {
                                    fd: super::posix_red::PARENT_FD,
                                },
                                Errno::Permission,
                            ));
                        } else {
                            calls.push(ScriptedCall::ok(
                                Syscall::Fsync {
                                    fd: super::posix_red::PARENT_FD,
                                },
                                Reply::Unit,
                            ));
                            calls.push(if fault == "root-sync" {
                                ScriptedCall::error(
                                    Syscall::Fsync { fd: PINNED_ROOT_FD },
                                    Errno::Permission,
                                )
                            } else {
                                ScriptedCall::ok(
                                    Syscall::Fsync { fd: PINNED_ROOT_FD },
                                    Reply::Unit,
                                )
                            });
                        }
                    }
                    calls.extend([
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Unlinkat {
                                dirfd: super::posix_red::CHILD_FD,
                                component: ".campaign-reservation.json".into(),
                                token_nonce: 42,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                }
                "cleanup" => {
                    calls.extend([
                        ScriptedCall::error(
                            Syscall::Write {
                                fd: super::posix_red::LEAF_FD,
                                bytes: RESERVATION.to_vec(),
                            },
                            Errno::NoSpace,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::LEAF_FD,
                            },
                            Reply::Unit,
                        ),
                        ScriptedCall::error(
                            Syscall::Unlinkat {
                                dirfd: super::posix_red::CHILD_FD,
                                component: ".campaign-reservation.json".into(),
                                token_nonce: 42,
                            },
                            Errno::Permission,
                        ),
                        ScriptedCall::ok(
                            Syscall::Close {
                                fd: super::posix_red::CHILD_FD,
                            },
                            Reply::Unit,
                        ),
                    ]);
                }
                _ => unreachable!("all campaign fault cases are enumerated"),
            }
            let context =
                super::secure_fs::test_support::DeterministicReservationContext::for_campaigns(
                    "supervisor-instance-01",
                    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    [("campaign-0001", "nonce-0001", "2026-08-24T00:00:00Z")],
                );
            let mut fs = SecureFs::with_syscalls_and_context(
                ScriptedSyscalls::new(calls),
                context,
            );
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                .expect("root adoption");
            let result = root.create_campaign_exclusive("candidate-01", "campaign-0001");
            match expected_code {
                None => {
                    let campaign = result.expect("EINTR/short writes eventually reserve");
                    campaign.assert_reservation_bytes(RESERVATION);
                    campaign.assert_reservation_sha256(
                        "42d25530c44bfdbf104886694979afa7c5ce383f9ec7839e9394d2b2dad16d27",
                    );
                    campaign.assert_candidate("candidate-01");
                    campaign.assert_campaign_id("campaign-0001");
                    campaign.assert_directory_identity(&campaign_identity);
                    campaign.assert_instance_nonce("nonce-0001");
                    campaign.assert_state_reserved_at("2026-08-24T00:00:00Z");
                }
                Some(code) => assert_code(result, code),
            }
            fs.assert_script_exhausted();
        }
    }
    };
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
#[path = "../src/secure_fs.rs"]
mod secure_fs;

// These are deliberately raw, platform ABI values.  They are not obtained
// from the production flag helpers: the RED contract must catch a helper that
// silently drops a no-follow, close-on-exec, non-blocking, or resolution bit.
#[cfg(target_os = "linux")]
const LINUX_OPENAT2_RESOLVE: u64 = 0x0f; // NO_XDEV|NO_MAGICLINKS|NO_SYMLINKS|BENEATH
#[cfg(target_os = "linux")]
const LINUX_READ_FLAGS: u64 = 0x000a0800; // O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC
#[cfg(target_os = "linux")]
const LINUX_CREATE_FLAGS: u64 = 0x000a00c1; // O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC
#[cfg(target_os = "linux")]
const LINUX_DIRECTORY_FLAGS: u64 = 0x000b0000; // O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC
#[cfg(target_os = "macos")]
const MACOS_READ_FLAGS: u64 = 0x01000104; // O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC
#[cfg(target_os = "macos")]
const MACOS_CREATE_FLAGS: u64 = 0x01000b01; // O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC
#[cfg(target_os = "macos")]
const MACOS_DIRECTORY_FLAGS: u64 = 0x01100100; // O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC
                                               // F_GETFL's access-mode bits are independently frozen; creation-only bits
                                               // are not accepted as proof that a returned writer is actually write-only.
const WRITER_ACCESS_MODE: u64 = 0x0001; // O_WRONLY
const READ_ONLY_ACCESS_MODE: u64 = 0x0000; // O_RDONLY (F_GETFL access mask)

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix_red {
    use super::secure_fs::test_support::{Errno, Reply, ScriptedCall, ScriptedSyscalls, Syscall};
    use super::secure_fs::{
        Component, DirectoryIdentity, FileIdentity, FileKind, FsError, SecureFs,
    };

    const INHERITED_ROOT_FD: i32 = 41;
    const PINNED_ROOT_FD: i32 = 101;
    pub(super) const PARENT_FD: i32 = 102;
    pub(super) const LEAF_FD: i32 = 103;
    pub(super) const CHILD_FD: i32 = 104;

    fn assert_code<T>(result: Result<T, FsError>, expected: &str) {
        let error = match result {
            Ok(_) => panic!("expected {expected}, got success"),
            Err(error) => error,
        };
        assert_eq!(error.code(), expected);
    }

    fn linux_identity() -> DirectoryIdentity {
        #[cfg(target_os = "linux")]
        {
            DirectoryIdentity::Linux(super::secure_fs::LinuxDirectoryIdentity {
                device_major: "8".into(),
                device_minor: "1".into(),
                inode: "9001".into(),
                mount_id: "55".into(),
                file_system_type: "ext4".into(),
                file_system_type_magic: "0000ef53".into(),
                fsid_word0: "1234".into(),
                fsid_word1: "5678".into(),
                owner_uid: 501,
                mode: 0o700,
                hard_link_count: "1".into(),
            })
        }
        #[cfg(target_os = "macos")]
        {
            DirectoryIdentity::Macos(super::secure_fs::MacosDirectoryIdentity {
                device: "16777234".into(),
                inode: "9001".into(),
                fsid_word0: "1234".into(),
                fsid_word1: "5678".into(),
                file_system_type: "apfs".into(),
                volume_uuid: "00112233445566778899aabbccddeeff".into(),
                mount_table_entry_sha256:
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                canonical_descriptor_path_sha256:
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                owner_uid: 501,
                mode: 0o700,
                hard_link_count: "1".into(),
            })
        }
    }

    fn root_file_identity() -> FileIdentity {
        #[cfg(target_os = "linux")]
        let (device, mount_id) = ("8:1".to_string(), Some("55".to_string()));
        #[cfg(target_os = "macos")]
        let (device, mount_id) = ("16777234".to_string(), None);
        FileIdentity {
            kind: FileKind::Directory,
            device,
            inode: "9001".into(),
            mount_id,
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o700,
            hard_link_count: "1".into(),
            size: 0,
        }
    }

    fn regular_file_identity() -> FileIdentity {
        #[cfg(target_os = "linux")]
        let (device, mount_id) = ("8:1".to_string(), Some("55".to_string()));
        #[cfg(target_os = "macos")]
        let (device, mount_id) = ("16777234".to_string(), None);
        FileIdentity {
            kind: FileKind::Regular,
            device,
            inode: "9100".into(),
            mount_id,
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o600,
            hard_link_count: "1".into(),
            size: 0,
        }
    }

    fn adopt_calls(identity: &DirectoryIdentity) -> Vec<ScriptedCall> {
        let root = root_file_identity();
        let mut calls = vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root),
            ),
        ];

        #[cfg(target_os = "linux")]
        {
            calls.push(ScriptedCall::ok(
                Syscall::Fstatfs { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ));
            calls.push(ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ));
        }

        #[cfg(target_os = "macos")]
        {
            calls.extend([
                ScriptedCall::ok(
                    Syscall::Fstatfs { fd: PINNED_ROOT_FD },
                    Reply::DirectoryIdentity(identity.clone()),
                ),
                ScriptedCall::ok(
                    Syscall::FgetattrlistVolumeUuid { fd: PINNED_ROOT_FD },
                    Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
                ),
                ScriptedCall::ok(
                    Syscall::FGetPath { fd: PINNED_ROOT_FD },
                    Reply::Path("/Volumes/r1/staging".into()),
                ),
                ScriptedCall::ok(
                    Syscall::Getfsstat,
                    Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                        "00112233445566778899aabbccddeeff",
                        "/Volumes/r1",
                        "1234",
                        "5678",
                    )]),
                ),
            ]);
        }

        calls
    }

    fn adopted_fs(identity: &DirectoryIdentity) -> SecureFs<ScriptedSyscalls> {
        let script = ScriptedSyscalls::new(adopt_calls(identity));
        SecureFs::with_syscalls(script)
    }

    fn deterministic_token_context(
    ) -> super::secure_fs::test_support::DeterministicReservationContext {
        super::secure_fs::test_support::DeterministicReservationContext::for_campaigns(
            "supervisor-instance-01",
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            [("campaign-0001", "nonce-0001", "2026-08-24T00:00:00Z")],
        )
    }

    fn open_read_call(component: &str, fd: i32) -> ScriptedCall {
        #[cfg(target_os = "linux")]
        {
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: component.into(),
                    flags: super::LINUX_READ_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(fd),
            )
        }
        #[cfg(target_os = "macos")]
        {
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: component.into(),
                    flags: super::MACOS_READ_FLAGS,
                    mode: 0,
                },
                Reply::Fd(fd),
            )
        }
    }

    fn create_flags() -> u64 {
        #[cfg(target_os = "linux")]
        {
            super::LINUX_CREATE_FLAGS
        }
        #[cfg(target_os = "macos")]
        {
            super::MACOS_CREATE_FLAGS
        }
    }

    fn component(value: &str) -> Component {
        Component::try_from(value).unwrap_or_else(|error| {
            panic!("test component {value:?} should be admitted: {error:?}")
        })
    }

    fn launch_receipt(
        context: &super::secure_fs::test_support::LaunchContextV1,
        executable: &FileIdentity,
    ) -> super::secure_fs::test_support::LaunchReceiptV1 {
        assert_eq!(executable.size, EXECUTABLE_BYTES.len() as u64);
        super::secure_fs::test_support::LaunchReceiptV1 {
            schema: "bun-role-launch-receipt/v1".into(),
            host_id: "linux-x86_64".into(),
            run_id: context.run_id.clone(),
            execution_index: context.execution_index,
            logical_role: context.logical_role.clone(),
            process_ordinal: context.process_ordinal,
            bun_sha256: EXECUTABLE_SHA256.into(),
            role_entrypoint_sha256: ROLE_SHA256.into(),
            addon_sha256: ADDON_SHA256.into(),
            argv: vec![
                "bun".into(),
                "--no-install".into(),
                "--no-env-file".into(),
                "/dev/fd/202".into(),
            ],
            environment: vec![
                "LC_ALL=C".into(),
                "WT_COMPARISON_PROTOCOL_IN_FD=205".into(),
                "WT_COMPARISON_PROTOCOL_OUT_FD=206".into(),
                "WT_COMPARISON_STARTUP_NONCE_FD=207".into(),
                "WT_COMPARISON_STRICT_ADDON_FD=203".into(),
            ],
            descriptor_map: vec![
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "authority".into(),
                    fd: PINNED_ROOT_FD,
                    access: "read".into(),
                    kind: "directory".into(),
                    close_on_exec: true,
                    inherited_by_child: false,
                    identity_sha256: AUTHORITY_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "executable".into(),
                    fd: EXEC_FD,
                    access: "read".into(),
                    kind: "executable".into(),
                    close_on_exec: true,
                    inherited_by_child: false,
                    identity_sha256: EXECUTABLE_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "roleFd".into(),
                    fd: ROLE_FD,
                    access: "read".into(),
                    kind: "regular".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: ROLE_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "addonFd".into(),
                    fd: ADDON_FD,
                    access: "read".into(),
                    kind: "regular".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: ADDON_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "protocolInFd".into(),
                    fd: PROTOCOL_IN_FD,
                    access: "read".into(),
                    kind: "pipe".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: PROTOCOL_IN_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "protocolOutFd".into(),
                    fd: PROTOCOL_OUT_FD,
                    access: "write".into(),
                    kind: "pipe".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: PROTOCOL_OUT_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "startupNonceFd".into(),
                    fd: STARTUP_NONCE_FD,
                    access: "read".into(),
                    kind: "pipe".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: STARTUP_IDENTITY_SHA256.into(),
                },
            ],
            sealed_execution_identity: None,
            launch_primitive: "linux-execveat-empty-path".into(),
            descriptor_map_sha256: context.descriptor_map_sha256.clone(),
            startup_nonce_sha256: context.startup_nonce_sha256.clone(),
            startup_digest_sha256: context.startup_digest_sha256.clone(),
            addon_requested_specifier: "/dev/fd/203".into(),
            addon_load_attempt_count: 1,
            addon_loaded_sha256: ADDON_SHA256.into(),
            addon_fallback_candidates: Vec::new(),
            socket_before_startup_handshake: false,
            launched_at: context.clock_rfc3339.clone(),
        }
    }

    #[test]
    fn inherited_root_is_duplicated_and_bound_to_observed_identity_and_provenance() {
        let identity = linux_identity();
        let mut fs = adopted_fs(&identity);
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity.clone())
            .expect("matching descriptor identity should be adopted");

        root.assert_provenance_bound_to(INHERITED_ROOT_FD, PINNED_ROOT_FD, &identity);
        fs.assert_script_exhausted();
    }

    #[test]
    fn mismatched_root_identity_fails_closed_before_component_access() {
        let expected = linux_identity();
        let mut observed = expected.clone();
        observed.set_inode("9002");
        let mut calls = adopt_calls(&observed);
        calls.truncate(4);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let script = ScriptedSyscalls::new(calls);
        let mut fs = SecureFs::with_syscalls(script);

        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn component_validation_rejects_escapes_aliases_and_noncanonical_names_without_syscalls() {
        let script = ScriptedSyscalls::empty();
        let mut fs = SecureFs::with_syscalls(script);
        let invalid = [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "/absolute",
            "C:\\absolute",
            "\\\\server\\share",
            "leaf:stream",
            "name\0suffix",
            "trailing.",
            "trailing ",
            "/dev/fd/41",
            "dev/fd/41",
            "proc/self/fd/41",
            "UPPERCASE",
            "percent%2fencoded",
            "CON",
            "NUL",
            "COM1",
            "aux",
            "café",
            "ＡＰＦＳ",
        ];

        for value in invalid {
            let expected = if matches!(value, "CON" | "NUL" | "COM1" | "aux") {
                "OUTPUT_PATH_DEVICE"
            } else if value.contains("/dev/fd") || value.contains("proc/") {
                "OUTPUT_PATH_REPARSE"
            } else if matches!(
                value,
                "UPPERCASE" | "percent%2fencoded" | "café" | "ＡＰＦＳ"
            ) {
                "OUTPUT_PATH_ALIAS"
            } else {
                "OUTPUT_FILE_INVALID"
            };
            assert_code(fs.validate_components(&[value]), expected);
        }
        fs.assert_script_exhausted();
    }

    #[test]
    fn raw_platform_flag_literals_are_frozen_independently_of_production_helpers() {
        #[cfg(target_os = "linux")]
        {
            assert_eq!(super::LINUX_OPENAT2_RESOLVE, 0x01 | 0x02 | 0x04 | 0x08);
            assert_eq!(super::LINUX_READ_FLAGS, 0x000a0800);
            assert_eq!(super::LINUX_CREATE_FLAGS, 0x000a00c1);
            assert_eq!(super::LINUX_DIRECTORY_FLAGS, 0x000b0000);
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(super::MACOS_READ_FLAGS, 0x01000104);
            assert_eq!(super::MACOS_CREATE_FLAGS, 0x01000b01);
            assert_eq!(super::MACOS_DIRECTORY_FLAGS, 0x01100100);
        }
        assert_eq!(super::WRITER_ACCESS_MODE, 0x0001);
        assert_eq!(super::READ_ONLY_ACCESS_MODE, 0x0000);
    }

    #[test]
    fn adopted_and_returned_descriptors_reject_access_mode_or_cloexec_mutations() {
        let identity = linux_identity();

        let mut calls = vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::Inheritable,
            ),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, identity.clone()),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();

        calls = vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, identity.clone()),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();

        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "read-mode.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(4)),
            ),
            open_read_call("read-mode.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(4)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity.clone())
            .expect("root adoption");
        assert_code(
            root.open_read_stream(&[component("read-mode.json")], 128),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();

        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "write-mode.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "write-mode.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 71),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(0)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("root adoption");
        assert_code(
            root.create_file_stream_exclusive(&[component("write-mode.json")], 128),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn descriptor_alias_and_numeric_reuse_are_rejected_by_identity_not_fd_number() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "alias.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(4)),
            ),
            open_read_call("alias.json", PINNED_ROOT_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root_file_identity()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity.clone())
            .expect("root adoption");
        assert_code(
            root.open_read_stream(&[component("alias.json")], 128),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();

        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "reused.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(4)),
            ),
            open_read_call("reused.json", PINNED_ROOT_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root_file_identity().with_inode("9002")),
            ),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("root adoption");
        assert_code(
            root.open_read_stream(&[component("reused.json")], 128),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn an_extra_writer_on_the_same_leaf_is_not_an_exclusive_creation() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "single-writer.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "single-writer.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 72),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(0)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "single-writer.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "single-writer.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 73),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(0)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("root adoption");
        let (writer, _token) = root
            .create_file_stream_exclusive(&[component("single-writer.json")], 128)
            .expect("first writer");
        assert_code(
            root.create_file_stream_exclusive(&[component("single-writer.json")], 128),
            "OUTPUT_FILE_INVALID",
        );
        drop(writer);
        fs.assert_script_exhausted();
    }

    #[test]
    fn sequential_hash_rejects_trailing_and_premature_descriptor_bytes() {
        for (name, first, second, expected_size) in [
            (
                "trailing-role.bytes",
                b"role-entrypoint-v1\n".to_vec(),
                b"unexpected-trailing\n".to_vec(),
                19_u64,
            ),
            (
                "premature-role.bytes",
                b"role-entrypoint-v".to_vec(),
                Vec::new(),
                19_u64,
            ),
        ] {
            let identity = linux_identity();
            let mut calls = adopt_calls(&identity);
            calls.extend([
                ScriptedCall::ok(
                    Syscall::FstatatNoFollow {
                        dirfd: PINNED_ROOT_FD,
                        component: name.into(),
                    },
                    Reply::FileIdentity(regular_file_identity().with_size(expected_size)),
                ),
                open_read_call(name, LEAF_FD),
                ScriptedCall::ok(
                    Syscall::Fstat { fd: LEAF_FD },
                    Reply::FileIdentity(regular_file_identity().with_size(expected_size)),
                ),
                ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd: LEAF_FD },
                    Reply::Flags(super::READ_ONLY_ACCESS_MODE),
                ),
                ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
                ScriptedCall::ok(
                    Syscall::Fstatfs { fd: LEAF_FD },
                    Reply::DirectoryIdentity(identity.clone()),
                ),
                ScriptedCall::ok(
                    Syscall::Read {
                        fd: LEAF_FD,
                        max: 1_048_576,
                    },
                    Reply::Bytes(first),
                ),
                ScriptedCall::ok(
                    Syscall::Read {
                        fd: LEAF_FD,
                        max: 1_048_576 - first.len(),
                    },
                    Reply::Bytes(second),
                ),
                ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
            ]);
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, identity)
                .expect("root adoption");
            assert_code(
                root.hash_file(&[component(name)], expected_size),
                "OUTPUT_READ_FAILED",
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn closed_handles_reject_all_operations_without_touching_the_script() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        root.close().expect("close is deterministic");
        root.close().expect("close is idempotent");

        assert_code(
            root.hash_file(&[component("manifest.json")], 1024),
            "OUTPUT_HANDLE_CLOSED",
        );
        assert_code(
            root.ensure_directory(&[component("new")]),
            "OUTPUT_HANDLE_CLOSED",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn bounded_read_rejects_zero_or_excessive_limits_before_openat2() {
        let identity = linux_identity();
        let mut fs = adopted_fs(&identity);
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");

        assert_code(
            root.open_read_stream(&[component("manifest.json")], 0),
            "OUTPUT_FILE_TOO_LARGE",
        );
        assert_code(
            root.open_read_stream(&[component("manifest.json")], 16_777_217),
            "OUTPUT_FILE_TOO_LARGE",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn non_regular_leaf_is_rejected_after_parent_relative_no_follow_stat() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([ScriptedCall::ok(
            Syscall::FstatatNoFollow {
                dirfd: PINNED_ROOT_FD,
                component: "manifest.json".into(),
            },
            Reply::FileIdentity(FileIdentity {
                kind: FileKind::Fifo,
                size: 0,
                ..regular_file_identity()
            }),
        )]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");

        assert_code(
            root.open_read_stream(&[component("manifest.json")], 1024),
            "OUTPUT_FILE_INVALID",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn stream_reads_retry_eintr_account_short_reads_and_hash_exact_bytes() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            open_read_call("manifest.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::error(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 0,
                    max: 1_048_576,
                },
                Errno::Eintr,
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 0,
                    max: 1_048_576,
                },
                Reply::Bytes(b"mani".to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Lseek {
                    fd: LEAF_FD,
                    offset: 4,
                    whence: 0,
                },
                Reply::Offset(4),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 4,
                    max: 1_048_572,
                },
                Reply::Bytes(b"fest".to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 8,
                    max: 1_048_568,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let mut stream = root
            .open_read_stream(&[component("manifest.json")], 1024)
            .expect("bounded stream");
        let mut out = [0_u8; 1_048_576];
        assert_eq!(stream.read_chunk(&mut out).expect("first chunk"), 4);
        stream
            .seek_to(4)
            .expect("explicit descriptor seek is a named operation");
        assert_eq!(stream.read_chunk(&mut out[4..]).expect("second chunk"), 4);
        assert_eq!(stream.read_chunk(&mut out[8..]).expect("EOF"), 0);
        let digest = stream.finish_read().expect("exact EOF");
        assert_eq!(digest.byte_count(), 8);
        assert_eq!(
            digest.sha256_hex(),
            "05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f"
        );
        root.assert_no_payload_retained();
        fs.assert_script_exhausted();
    }

    #[test]
    fn truncation_or_growth_after_admission_is_not_a_successful_read() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            open_read_call("manifest.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 0,
                    max: 1024,
                },
                Reply::Bytes(b"short".to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 5,
                    max: 1019,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let mut stream = root
            .open_read_stream(&[component("manifest.json")], 1024)
            .expect("bounded stream");
        let mut out = [0_u8; 1024];
        assert_eq!(stream.read_chunk(&mut out).expect("short read"), 5);
        assert_eq!(stream.read_chunk(&mut out[5..]).expect("EOF"), 0);
        assert_code(stream.finish_read(), "OUTPUT_READ_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn zero_progress_read_is_not_eof_or_success() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "zero-progress-read.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(4)),
            ),
            open_read_call("zero-progress-read.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(4)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 0,
                    max: 1024,
                },
                Reply::ZeroProgress,
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let mut stream = root
            .open_read_stream(&[component("zero-progress-read.json")], 1024)
            .expect("bounded stream");
        let mut out = [0_u8; 1024];
        assert_code(stream.read_chunk(&mut out), "OUTPUT_READ_FAILED");
        drop(stream);
        fs.assert_script_exhausted();
    }

    #[test]
    fn exclusive_create_never_replaces_an_existing_leaf() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.push(ScriptedCall::ok(
            Syscall::FstatatNoFollow {
                dirfd: PINNED_ROOT_FD,
                component: "verifier-result.json".into(),
            },
            Reply::FileIdentity(regular_file_identity()),
        ));
        calls.push(ScriptedCall::error(
            Syscall::Openat {
                dirfd: PINNED_ROOT_FD,
                component: "verifier-result.json".into(),
                flags: create_flags(),
                mode: 0o600,
            },
            Errno::Exist,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");

        assert_code(
            root.create_file_stream_exclusive(&[component("verifier-result.json")], 1024),
            "OUTPUT_FILE_EXISTS",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn short_write_and_eintr_finish_only_after_leaf_and_parent_sync() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "verifier-result.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "verifier-result.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 7),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::error(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"12345678".to_vec(),
                },
                Errno::Eintr,
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"12345678".to_vec(),
                },
                Reply::Written(3),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"45678".to_vec(),
                },
                Reply::Written(5),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            ScriptedCall::ok(Syscall::Fdatasync { fd: LEAF_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Fsync { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (mut writer, token) = root
            .create_file_stream_exclusive(&[component("verifier-result.json")], 8)
            .expect("exclusive writer");
        writer.write_chunk(b"12345678").expect("short writes retry");
        let committed = root.finish_file(writer, token).expect("durable commit");
        assert_eq!(committed.operation_nonce(), 7);
        committed
            .assert_digest_hex("ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f");
        committed.assert_bytes_written(b"12345678");
        committed.assert_byte_count(8);
        committed.assert_final_size(8);
        fs.assert_script_exhausted();
    }

    #[test]
    fn enospc_or_sync_failure_aborts_only_the_matching_uncommitted_token() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "artifact.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "artifact.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 9),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::error(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"full".to_vec(),
                },
                Errno::NoSpace,
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Unlinkat {
                    dirfd: PINNED_ROOT_FD,
                    component: "artifact.json".into(),
                    token_nonce: 9,
                },
                Reply::Unit,
            ),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (mut writer, token) = root
            .create_file_stream_exclusive(&[component("artifact.json")], 4)
            .expect("exclusive writer");
        assert_code(writer.write_chunk(b"full"), "OUTPUT_WRITE_FAILED");
        drop(writer);
        root.abort_created_file(token)
            .expect("matching token cleans the partial");
        fs.assert_script_exhausted();
    }

    #[test]
    fn quota_and_permission_failures_are_typed_and_never_publish_partial_output() {
        for (errno, expected_code) in [
            (Errno::Quota, "OUTPUT_WRITE_FAILED"),
            (Errno::Permission, "OUTPUT_WRITE_FAILED"),
        ] {
            let identity = linux_identity();
            let mut calls = adopt_calls(&identity);
            calls.extend([
                ScriptedCall::error(
                    Syscall::FstatatNoFollow {
                        dirfd: PINNED_ROOT_FD,
                        component: "quota-or-permission.json".into(),
                    },
                    Errno::NoEntry,
                ),
                ScriptedCall::ok(
                    Syscall::Openat {
                        dirfd: PINNED_ROOT_FD,
                        component: "quota-or-permission.json".into(),
                        flags: create_flags(),
                        mode: 0o600,
                    },
                    created_reply!(LEAF_FD, 10),
                ),
                ScriptedCall::ok(
                    Syscall::Fstat { fd: LEAF_FD },
                    Reply::FileIdentity(regular_file_identity()),
                ),
                ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd: LEAF_FD },
                    Reply::Flags(super::WRITER_ACCESS_MODE),
                ),
                ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
                ScriptedCall::ok(
                    Syscall::Fstatfs { fd: LEAF_FD },
                    Reply::DirectoryIdentity(identity.clone()),
                ),
                ScriptedCall::error(
                    Syscall::Write {
                        fd: LEAF_FD,
                        bytes: b"full".to_vec(),
                    },
                    errno,
                ),
                ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
                ScriptedCall::ok(
                    Syscall::Unlinkat {
                        dirfd: PINNED_ROOT_FD,
                        component: "quota-or-permission.json".into(),
                        token_nonce: 10,
                    },
                    Reply::Unit,
                ),
            ]);
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, identity)
                .expect("adoption");
            let (mut writer, token) = root
                .create_file_stream_exclusive(&[component("quota-or-permission.json")], 4)
                .expect("exclusive writer");
            assert_code(writer.write_chunk(b"full"), expected_code);
            drop(writer);
            root.abort_created_file(token)
                .expect("matching token removes failed output");
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn stale_or_forged_cleanup_token_cannot_unlink_a_different_leaf() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.push(ScriptedCall::error(
            Syscall::FstatatNoFollow {
                dirfd: PINNED_ROOT_FD,
                component: "artifact.json".into(),
            },
            Errno::NoEntry,
        ));
        calls.push(ScriptedCall::ok(
            Syscall::Openat {
                dirfd: PINNED_ROOT_FD,
                component: "artifact.json".into(),
                flags: create_flags(),
                mode: 0o600,
            },
            created_reply!(LEAF_FD, 11),
        ));
        calls.push(ScriptedCall::ok(
            Syscall::Fstat { fd: LEAF_FD },
            Reply::FileIdentity(regular_file_identity()),
        ));
        calls.push(ScriptedCall::ok(
            Syscall::FcntlGetFl { fd: LEAF_FD },
            Reply::Flags(super::WRITER_ACCESS_MODE),
        ));
        calls.push(ScriptedCall::ok(
            Syscall::FcntlGetFd { fd: LEAF_FD },
            Reply::CloseOnExec,
        ));
        calls.push(ScriptedCall::ok(
            Syscall::Fstatfs { fd: LEAF_FD },
            Reply::DirectoryIdentity(identity.clone()),
        ));
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: LEAF_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (writer, token) = root
            .create_file_stream_exclusive(&[component("artifact.json")], 4)
            .expect("exclusive writer");
        drop(writer);

        assert_code(
            root.abort_created_file(token.for_operation(99)),
            "OUTPUT_CLEANUP_FAILED",
        );
        fs.assert_script_exhausted();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ancestor_replacement_between_observation_and_open_is_rejected_without_path_fallback() {
        let expected = linux_identity();
        let mut replacement = expected.clone();
        replacement.set_inode("9900");
        let mut calls = adopt_calls(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(root_stat().with_inode("9010")),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(replacement),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("adoption");
        assert_code(
            root.ensure_directory(&[component("nested")]),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_campaign_reservation_is_explicitly_unsupported_without_mac_schema() {
        // The frozen campaign reservation is Mac-owned: it carries only a
        // MacosDirectoryIdentityV1 and is never emitted from a Linux staging
        // handle. Linux may retain ordinary staging primitives, but a caller
        // asking for the campaign reservation receives the platform gate before
        // any reservation bytes, campaign identity, or partial file exist.
        let expected = identity();
        let mut calls = root_prefix(&expected);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("Linux staging root");
        assert_code(
            root.create_campaign_exclusive("candidate-01", "campaign-0001"),
            "OUTPUT_PLATFORM_UNSUPPORTED",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn parent_sync_failure_is_a_hard_failure_even_after_file_sync() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 13),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"done".to_vec(),
                },
                Reply::Written(4),
            ),
            ScriptedCall::ok(Syscall::Fdatasync { fd: LEAF_FD }, Reply::Unit),
            ScriptedCall::error(Syscall::Fsync { fd: PINNED_ROOT_FD }, Errno::Permission),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
            // A sync failure aborts the exact uncommitted token; cleanup is
            // itself scripted and cannot silently fall back to a path.
            ScriptedCall::ok(
                Syscall::Unlinkat {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                    token_nonce: 13,
                },
                Reply::Unit,
            ),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (mut writer, token) = root
            .create_file_stream_exclusive(&[component("manifest.json")], 4)
            .expect("exclusive writer");
        writer.write_chunk(b"done").expect("write");
        assert_code(root.finish_file(writer, token), "OUTPUT_SYNC_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn file_sync_failure_is_a_hard_failure_and_cleans_the_uncommitted_token() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "file-sync-failure.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "file-sync-failure.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 14),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"done".to_vec(),
                },
                Reply::Written(4),
            ),
            ScriptedCall::error(Syscall::Fdatasync { fd: LEAF_FD }, Errno::Permission),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Unlinkat {
                    dirfd: PINNED_ROOT_FD,
                    component: "file-sync-failure.json".into(),
                    token_nonce: 14,
                },
                Reply::Unit,
            ),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (mut writer, token) = root
            .create_file_stream_exclusive(&[component("file-sync-failure.json")], 4)
            .expect("writer");
        writer.write_chunk(b"done").expect("write");
        assert_code(root.finish_file(writer, token), "OUTPUT_SYNC_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn hash_file_positive_streams_bytes_without_returning_payload_to_the_caller() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(3)),
            ),
            open_read_call("manifest.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(3)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: LEAF_FD,
                    max: 1_048_576,
                },
                Reply::Bytes(b"abc".to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: LEAF_FD,
                    max: 1_048_573,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(3)),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let digest = root
            .hash_file(&[component("manifest.json")], 3)
            .expect("hash stream");
        assert_eq!(digest.byte_count(), 3);
        assert_eq!(
            digest.sha256_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        root.assert_no_payload_retained();
        fs.assert_script_exhausted();
    }

    #[test]
    fn explicit_sync_flushes_the_pinned_directory_and_is_not_a_noop() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.push(ScriptedCall::ok(
            Syscall::Fsync { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        root.sync().expect("durability sync");
        fs.assert_script_exhausted();
    }

    #[test]
    fn zero_progress_is_not_treated_as_success_and_cumulative_bounds_are_checked() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "zero-progress.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "zero-progress.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 21),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"zero".to_vec(),
                },
                Reply::Written(0),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (mut writer, _token) = root
            .create_file_stream_exclusive(&[component("zero-progress.json")], 4)
            .expect("writer");
        assert_code(writer.write_chunk(b"zero"), "OUTPUT_WRITE_FAILED");
        drop(writer);
        fs.assert_script_exhausted();
    }

    #[test]
    fn overrun_and_cumulative_bound_fail_before_the_next_write_syscall() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "bounded.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "bounded.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 22),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: LEAF_FD,
                    bytes: b"abc".to_vec(),
                },
                Reply::Written(3),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (mut writer, _token) = root
            .create_file_stream_exclusive(&[component("bounded.json")], 4)
            .expect("writer");
        assert_code(writer.write_chunk(b"too-long"), "OUTPUT_FILE_TOO_LARGE");
        writer.write_chunk(b"abc").expect("first bounded chunk");
        assert_code(writer.write_chunk(b"d"), "OUTPUT_FILE_TOO_LARGE");
        drop(writer);
        fs.assert_script_exhausted();
    }

    #[test]
    fn read_memory_ceiling_is_two_mib_with_one_mib_maximum_scripted_chunk() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "large.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(2_097_152)),
            ),
            open_read_call("large.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(2_097_152)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 0,
                    max: 1_048_576,
                },
                Reply::Bytes(vec![b'x'; 1_048_576]),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 1_048_576,
                    max: 1_048_576,
                },
                Reply::Bytes(vec![b'y'; 1_048_576]),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 2_097_152,
                    max: 1_048_576,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(2_097_152)),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let mut stream = root
            .open_read_stream(&[component("large.json")], 2_097_152)
            .expect("two MiB file bound");
        let mut oversized = vec![0_u8; 1_048_577];
        assert_code(stream.read_chunk(&mut oversized), "OUTPUT_FILE_TOO_LARGE");
        drop(oversized);
        // The same one-MiB allocation is explicitly reused for both chunks;
        // retaining two full payload chunks would violate the 2 MiB process
        // ceiling once parser/digest state is counted.
        let mut reusable_mib = vec![0_u8; 1_048_576];
        let reusable_ptr = reusable_mib.as_mut_ptr();
        assert_eq!(
            stream
                .read_chunk(&mut reusable_mib)
                .expect("first one MiB chunk"),
            1_048_576
        );
        assert!(reusable_mib.iter().all(|byte| *byte == b'x'));
        reusable_mib.fill(0);
        assert_eq!(reusable_mib.as_mut_ptr(), reusable_ptr);
        assert_eq!(
            stream
                .read_chunk(&mut reusable_mib)
                .expect("second one MiB chunk"),
            1_048_576
        );
        assert!(reusable_mib.iter().all(|byte| *byte == b'y'));
        assert_eq!(
            stream.read_chunk(&mut reusable_mib).expect("bounded EOF"),
            0
        );
        let digest = stream.finish_read().expect("exact two MiB EOF");
        assert_eq!(digest.byte_count(), 2_097_152);
        assert_eq!(
            digest.sha256_hex(),
            "c8f67cd359fa0a6f8b1f6ca5c689a00ded9ede61381f5ffc107f84b721bc3a98"
        );
        root.assert_no_payload_retained();
        fs.assert_script_exhausted();
    }

    #[test]
    fn growth_after_eof_is_detected_against_the_admitted_size() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "growing.json".into(),
                },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            open_read_call("growing.json", LEAF_FD),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(8)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 0,
                    max: 1_048_576,
                },
                Reply::Bytes(b"12345678".to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Pread {
                    fd: LEAF_FD,
                    offset: 8,
                    max: 1_048_568,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(9)),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let mut stream = root
            .open_read_stream(&[component("growing.json")], 1024)
            .expect("stream");
        let mut out = [0_u8; 1024];
        assert_eq!(stream.read_chunk(&mut out).expect("bytes"), 8);
        assert_eq!(stream.read_chunk(&mut out[8..]).expect("EOF"), 0);
        assert_code(stream.finish_read(), "OUTPUT_READ_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn token_binds_root_campaign_leaf_identity_bound_and_operation() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "bound.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "bound.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 23),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity()),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls_and_context(
            ScriptedSyscalls::new(calls),
            deterministic_token_context(),
        );
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity.clone())
            .expect("adoption");
        let (writer, token) = root
            .create_file_stream_exclusive(&[component("bound.json")], 4)
            .expect("writer");
        drop(writer);
        token.assert_complete_binding(
            "supervisor-instance-01",
            "campaign-0001",
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            &identity,
            &regular_file_identity().with_size(0),
            4,
            23,
            "create_file_stream_exclusive",
        );
        token.assert_creation_ledger(1, true);
        token.assert_cleanup_failure_binding("OUTPUT_CLEANUP_FAILED");
        assert_code(
            root.abort_created_file(token.for_supervisor_instance("other-supervisor")),
            "OUTPUT_CLEANUP_FAILED",
        );
        assert_code(
            root.abort_created_file(token.for_reservation("other-reservation")),
            "OUTPUT_CLEANUP_FAILED",
        );
        assert_code(
            root.abort_created_file(
                token.for_parent_identity(&root_file_identity().with_inode("9999")),
            ),
            "OUTPUT_CLEANUP_FAILED",
        );
        assert_code(
            root.abort_created_file(
                token.for_leaf_identity(&regular_file_identity().with_inode("9999")),
            ),
            "OUTPUT_CLEANUP_FAILED",
        );
        assert_code(
            root.abort_created_file(token.for_bound(5)),
            "OUTPUT_CLEANUP_FAILED",
        );
        assert_code(
            root.abort_created_file(token.for_operation(99)),
            "OUTPUT_CLEANUP_FAILED",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn matching_token_cleanup_failure_is_typed_and_never_retried_by_path() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.extend([
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "cleanup-failure.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "cleanup-failure.json".into(),
                    flags: create_flags(),
                    mode: 0o600,
                },
                created_reply!(LEAF_FD, 24),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(regular_file_identity().with_size(0)),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(identity.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
            ScriptedCall::error(
                Syscall::Unlinkat {
                    dirfd: PINNED_ROOT_FD,
                    component: "cleanup-failure.json".into(),
                    token_nonce: 24,
                },
                Errno::Permission,
            ),
        ]);
        let mut fs = SecureFs::with_syscalls_and_context(
            ScriptedSyscalls::new(calls),
            deterministic_token_context(),
        );
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        let (writer, token) = root
            .create_file_stream_exclusive(&[component("cleanup-failure.json")], 4)
            .expect("exclusive writer");
        drop(writer);
        assert_code(root.abort_created_file(token), "OUTPUT_CLEANUP_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn missing_scripted_syscall_is_a_stable_script_mismatch() {
        let identity = linux_identity();
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::empty());
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, identity),
            "OUTPUT_SYSCALL_SCRIPT_MISMATCH",
        );
    }

    #[test]
    fn reordered_scripted_syscall_is_rejected_before_any_real_operation() {
        let identity = linux_identity();
        let calls = [ScriptedCall::ok(
            Syscall::Fstat { fd: PINNED_ROOT_FD },
            Reply::FileIdentity(root_file_identity()),
        )];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, identity),
            "OUTPUT_SYSCALL_SCRIPT_MISMATCH",
        );
    }

    #[test]
    fn pathname_based_scripted_open_is_rejected_as_a_no_bypass() {
        let identity = linux_identity();
        let calls = [ScriptedCall::ok(
            Syscall::PathOpen {
                path: "/tmp/r1/manifest.json".into(),
            },
            Reply::Fd(LEAF_FD),
        )];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, identity),
            "OUTPUT_SYSCALL_SCRIPT_MISMATCH",
        );
    }

    #[test]
    fn extra_scripted_syscall_is_rejected_when_the_operation_finishes() {
        let identity = linux_identity();
        let mut calls = adopt_calls(&identity);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: LEAF_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        fs.adopt_staging(INHERITED_ROOT_FD, identity)
            .expect("adoption");
        assert_code(fs.finish_script(), "OUTPUT_SYSCALL_SCRIPT_MISMATCH");
    }
}

#[cfg(target_os = "linux")]
mod linux_red {
    use super::secure_fs::test_support::{Errno, Reply, ScriptedCall, ScriptedSyscalls, Syscall};
    use super::secure_fs::{
        Component, DirectoryIdentity, FileIdentity, FileKind, FsError, SecureFs,
    };

    const INHERITED_ROOT_FD: i32 = 41;
    const PINNED_ROOT_FD: i32 = 101;
    const PARENT_FD: i32 = 102;
    const CHILD_FD: i32 = 104;
    const LEAF_FD: i32 = 103;
    const EXEC_FD: i32 = 201;
    const ROLE_FD: i32 = 202;
    const ADDON_FD: i32 = 203;
    const PROTOCOL_IN_FD: i32 = 205;
    const PROTOCOL_OUT_FD: i32 = 206;
    const STARTUP_NONCE_FD: i32 = 207;
    const STAGED_EXEC_FD: i32 = 204;
    const EXECUTABLE_BYTES: &[u8] = b"#!/usr/bin/env bun\n";
    const EXECUTABLE_SHA256: &str =
        "1af9f724d86a6268aa72c8a187248c1d06937501784da400b5a3199270bc3c41";
    const ROLE_BYTES: &[u8] = b"role-entrypoint-v1\n";
    const ROLE_SHA256: &str = "63e591931698b9cf84fd67e10c6e6db3be528b17b151e8b518f7913195a442f1";
    const ADDON_BYTES: &[u8] = b"native-addon-v1\n";
    const ADDON_SHA256: &str = "e5c45d8b47e8173e66f4128d01138ae9539f4885bd457b298738206c5621b7c4";
    const PROTOCOL_IN_BYTES: &[u8] = b"protocol-in-v1\n";
    const PROTOCOL_IN_SHA256: &str =
        "5c0f1db3d54b33e8b247a17ce1a14118da604154ce0ee8e29dd44adc060f65b7";
    const PROTOCOL_OUT_BYTES: &[u8] = b"protocol-out-v1\n";
    const PROTOCOL_OUT_SHA256: &str =
        "1224532881a864c67f28b0b7b4ac64eb1a9b68ba3efa5cd2fdf74c48ccec5618";
    const STARTUP_NONCE_BYTES: &[u8] = b"startup-nonce-v1\n";
    const STARTUP_NONCE_BYTES_SHA256: &str =
        "1eb65b8eae8305176c24f564bb62ee98568145874d87d6e6d232962774501f10";
    const STARTUP_DIGEST_BYTES: &[u8] = b"startup-digest-v1\n";
    const STARTUP_DIGEST_SHA256: &str =
        "753a4b4c48c1476060e426a0cc5973a03021525b3591db8b1c1c20192469ec79";
    const DESCRIPTOR_MAP_PREIMAGE: &[u8] = b"authority|directory|8:1|9001|0|700|1|501|55\n";
    const SOURCE_RECEIPT_BYTES: &[u8] = b"source-receipt-v1\n";
    const AUTHORITY_IDENTITY_SHA256: &str =
        "45d8ea9fc4c0830216aa48b81f29896756b5415fed01187817365e44c3f50eeb";
    const EXECUTABLE_IDENTITY_SHA256: &str =
        "d335c8b288d981bac387b549df2fbb08cd1c6c2e344ed73f338d6ece82a71a9c";
    const ROLE_IDENTITY_SHA256: &str =
        "e071e5605b3b3c6d67fe33dc5e62aeff46a7c4bb971e3d3be85ab920ee97cde4";
    const ADDON_IDENTITY_SHA256: &str =
        "57fe39102af9cb5378ee6eb32b7ce59d044705a95266c4957ce83e9643134e4d";
    const PROTOCOL_IN_IDENTITY_SHA256: &str =
        "58394ec0a2e1222b3c9d8a5b9f8d0b0500d9428bf9357fb205a298bad3dcdd3f";
    const PROTOCOL_OUT_IDENTITY_SHA256: &str =
        "03d4a6120c223d700f9e124fd29ea1fcfa99e9e2bcc093b83de6026dfd526985";
    const STARTUP_IDENTITY_SHA256: &str =
        "90a0ffcf5ea6d997c1a2d16d4309f6e98d8b26194ca88913e7a893e3e3dbe384";

    fn launch_context(
        executable: &FileIdentity,
    ) -> super::secure_fs::test_support::LaunchContextV1 {
        super::secure_fs::test_support::LaunchContextV1 {
            supervisor_instance: "supervisor-instance-01".into(),
            run_id: "run-0001".into(),
            logical_role: "resident".into(),
            execution_index: 0,
            process_ordinal: 0,
            clock_rfc3339: "2026-08-24T00:00:12Z".into(),
            source_receipt_sha256:
                "d5731ace35d5721860efe8b0d9ea49f9d48b87eb20480e05bc56770823521ed8".into(),
            source_receipt_bytes: SOURCE_RECEIPT_BYTES.to_vec(),
            source_executable: executable.clone(),
            descriptor_map_preimage: DESCRIPTOR_MAP_PREIMAGE.to_vec(),
            descriptor_map_sha256:
                "45d8ea9fc4c0830216aa48b81f29896756b5415fed01187817365e44c3f50eeb".into(),
            startup_nonce: STARTUP_NONCE_BYTES.to_vec(),
            startup_nonce_sha256: STARTUP_NONCE_BYTES_SHA256.into(),
            startup_digest: STARTUP_DIGEST_BYTES.to_vec(),
            startup_digest_sha256: STARTUP_DIGEST_SHA256.into(),
        }
    }

    fn assert_code<T>(result: Result<T, FsError>, expected: &str) {
        let error = match result {
            Ok(_) => panic!("expected {expected}, got success"),
            Err(error) => error,
        };
        assert_eq!(error.code(), expected);
    }

    fn identity() -> DirectoryIdentity {
        DirectoryIdentity::Linux(super::secure_fs::LinuxDirectoryIdentity {
            device_major: "8".into(),
            device_minor: "1".into(),
            inode: "9001".into(),
            mount_id: "55".into(),
            file_system_type: "ext4".into(),
            file_system_type_magic: "0000ef53".into(),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o700,
            hard_link_count: "1".into(),
        })
    }

    fn root_stat() -> FileIdentity {
        FileIdentity {
            kind: FileKind::Directory,
            device: "8:1".into(),
            inode: "9001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o700,
            hard_link_count: "1".into(),
            size: 0,
        }
    }

    fn pipe_identity(template: &FileIdentity, inode: &str, size: u64) -> FileIdentity {
        FileIdentity {
            kind: FileKind::Pipe,
            size,
            ..template.clone().with_inode(inode)
        }
    }

    fn append_linux_descriptor(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
        bytes: &[u8],
        access: u64,
    ) {
        append_linux_descriptor_with_terminal(
            calls,
            fd,
            identity,
            filesystem,
            bytes,
            access,
            Reply::Bytes(Vec::new()),
        );
    }

    fn append_linux_descriptor_with_terminal(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
        bytes: &[u8],
        access: u64,
        terminal: Reply,
    ) {
        calls.extend([
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd }, Reply::Inheritable),
            ScriptedCall::ok(Syscall::FcntlGetFl { fd }, Reply::Flags(access)),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: bytes.len().max(1),
                },
                Reply::Bytes(bytes.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: bytes.len().max(1),
                },
                terminal,
            ),
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
        ]);
    }

    fn append_linux_startup_descriptor(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
    ) {
        append_linux_startup_descriptor_with_terminal(
            calls,
            fd,
            identity,
            filesystem,
            STARTUP_NONCE_BYTES,
            STARTUP_DIGEST_BYTES,
            Reply::Bytes(Vec::new()),
        );
    }

    fn append_linux_startup_descriptor_with_terminal(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
        nonce: &[u8],
        digest: &[u8],
        terminal: Reply,
    ) {
        calls.extend([
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd }, Reply::Inheritable),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_NONCE_BYTES.len(),
                },
                Reply::Bytes(nonce.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_DIGEST_BYTES.len(),
                },
                Reply::Bytes(digest.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_DIGEST_BYTES.len(),
                },
                terminal,
            ),
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
        ]);
    }

    fn append_linux_exec_descriptor(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        executable: &FileIdentity,
        filesystem: &DirectoryIdentity,
    ) {
        calls.extend([
            ScriptedCall::ok(
                Syscall::Fstat { fd },
                Reply::FileIdentity(executable.clone()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(EXECUTABLE_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd },
                Reply::FileIdentity(executable.clone()),
            ),
        ]);
    }

    fn append_linux_descriptor_eintr_short(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
        bytes: &[u8],
        access: u64,
    ) {
        calls.extend([
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd }, Reply::Inheritable),
            ScriptedCall::ok(Syscall::FcntlGetFl { fd }, Reply::Flags(access)),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
        ]);
        let split = bytes.len() / 2;
        calls.extend([
            ScriptedCall::error(
                Syscall::Read {
                    fd,
                    max: bytes.len().max(1),
                },
                Errno::Eintr,
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: bytes.len().max(1),
                },
                Reply::Bytes(bytes[..split].to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: bytes.len() - split,
                },
                Reply::Bytes(bytes[split..].to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: bytes.len() - split,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
        ]);
    }

    fn append_linux_exec_descriptor_eintr_short(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        executable: &FileIdentity,
        filesystem: &DirectoryIdentity,
    ) {
        append_linux_descriptor_eintr_short(
            calls,
            fd,
            executable,
            filesystem,
            EXECUTABLE_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        let fcntl_index = calls.len().saturating_sub(9);
        if let Some(call) = calls.get_mut(fcntl_index) {
            // The executable is the only close-on-exec descriptor in this
            // helper; replace the inherited reply queued by the generic
            // descriptor helper without changing the read sequence.
            *call = ScriptedCall::ok(Syscall::FcntlGetFd { fd }, Reply::CloseOnExec);
        }
    }

    fn append_linux_startup_descriptor_eintr_short(
        calls: &mut Vec<ScriptedCall>,
        fd: i32,
        identity: &FileIdentity,
        filesystem: &DirectoryIdentity,
    ) {
        calls.extend([
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd }, Reply::Inheritable),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd },
                Reply::DirectoryIdentity(filesystem.clone()),
            ),
        ]);
        let nonce_split = STARTUP_NONCE_BYTES.len() / 2;
        calls.extend([
            ScriptedCall::error(
                Syscall::Read {
                    fd,
                    max: STARTUP_NONCE_BYTES.len(),
                },
                Errno::Eintr,
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_NONCE_BYTES.len(),
                },
                Reply::Bytes(STARTUP_NONCE_BYTES[..nonce_split].to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_NONCE_BYTES.len() - nonce_split,
                },
                Reply::Bytes(STARTUP_NONCE_BYTES[nonce_split..].to_vec()),
            ),
        ]);
        let digest_split = STARTUP_DIGEST_BYTES.len() / 2;
        calls.extend([
            ScriptedCall::error(
                Syscall::Read {
                    fd,
                    max: STARTUP_DIGEST_BYTES.len(),
                },
                Errno::Eintr,
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_DIGEST_BYTES.len(),
                },
                Reply::Bytes(STARTUP_DIGEST_BYTES[..digest_split].to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_DIGEST_BYTES.len() - digest_split,
                },
                Reply::Bytes(STARTUP_DIGEST_BYTES[digest_split..].to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd,
                    max: STARTUP_DIGEST_BYTES.len() - digest_split,
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(Syscall::Fstat { fd }, Reply::FileIdentity(identity.clone())),
        ]);
    }

    fn linux_launch_contract_calls(
        expected: &DirectoryIdentity,
        executable: &FileIdentity,
        context: &super::secure_fs::test_support::LaunchContextV1,
        receipt: &super::secure_fs::test_support::LaunchReceiptV1,
    ) -> Vec<ScriptedCall> {
        let mut calls = root_prefix(expected);
        append_linux_exec_descriptor(&mut calls, EXEC_FD, executable, expected);
        let startup = pipe_identity(
            executable,
            "7206",
            STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
        );
        // The startup nonce/digest handshake is the first inherited-descriptor
        // operation.  No role, addon, socket, or protocol descriptor may be
        // inspected before the launch receipt has been authenticated.
        append_linux_startup_descriptor(&mut calls, STARTUP_NONCE_FD, &startup, expected);
        let role = executable
            .clone()
            .with_inode("7202")
            .with_size(ROLE_BYTES.len() as u64);
        let addon = executable
            .clone()
            .with_inode("7203")
            .with_size(ADDON_BYTES.len() as u64);
        let protocol_in = pipe_identity(executable, "7204", PROTOCOL_IN_BYTES.len() as u64);
        let protocol_out = pipe_identity(executable, "7205", PROTOCOL_OUT_BYTES.len() as u64);
        append_linux_descriptor(
            &mut calls,
            ROLE_FD,
            &role,
            expected,
            ROLE_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        append_linux_descriptor(
            &mut calls,
            ADDON_FD,
            &addon,
            expected,
            ADDON_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        append_linux_descriptor(
            &mut calls,
            PROTOCOL_IN_FD,
            &protocol_in,
            expected,
            PROTOCOL_IN_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        append_linux_descriptor(
            &mut calls,
            PROTOCOL_OUT_FD,
            &protocol_out,
            expected,
            PROTOCOL_OUT_BYTES,
            super::WRITER_ACCESS_MODE,
        );
        calls.extend([
            ScriptedCall::ok(Syscall::Fchdir { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::ExecutableHandleSpawn {
                    executable_fd: EXEC_FD,
                    argv: receipt.argv.clone(),
                    env: vec![
                        ("LC_ALL".into(), "C".into()),
                        ("WT_COMPARISON_PROTOCOL_IN_FD".into(), "205".into()),
                        ("WT_COMPARISON_PROTOCOL_OUT_FD".into(), "206".into()),
                        ("WT_COMPARISON_STARTUP_NONCE_FD".into(), "207".into()),
                        ("WT_COMPARISON_STRICT_ADDON_FD".into(), "/dev/fd/203".into()),
                    ],
                    context: context.clone(),
                },
                Reply::ChildPid(9001),
            ),
            ScriptedCall::ok(Syscall::Waitpid { pid: 9001 }, Reply::Exit(0)),
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ROLE_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ADDON_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: PROTOCOL_IN_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Unit,
            ),
        ]);
        calls
    }

    fn linux_launch_chunked_contract_calls(
        expected: &DirectoryIdentity,
        executable: &FileIdentity,
        context: &super::secure_fs::test_support::LaunchContextV1,
        receipt: &super::secure_fs::test_support::LaunchReceiptV1,
    ) -> Vec<ScriptedCall> {
        let mut calls = root_prefix(expected);
        append_linux_exec_descriptor_eintr_short(&mut calls, EXEC_FD, executable, expected);
        append_linux_startup_descriptor_eintr_short(
            &mut calls,
            STARTUP_NONCE_FD,
            &pipe_identity(
                executable,
                "7206",
                STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
            ),
            expected,
        );
        append_linux_descriptor_eintr_short(
            &mut calls,
            ROLE_FD,
            &executable
                .clone()
                .with_inode("7202")
                .with_size(ROLE_BYTES.len() as u64),
            expected,
            ROLE_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        append_linux_descriptor_eintr_short(
            &mut calls,
            ADDON_FD,
            &executable
                .clone()
                .with_inode("7203")
                .with_size(ADDON_BYTES.len() as u64),
            expected,
            ADDON_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        append_linux_descriptor_eintr_short(
            &mut calls,
            PROTOCOL_IN_FD,
            &pipe_identity(executable, "7204", PROTOCOL_IN_BYTES.len() as u64),
            expected,
            PROTOCOL_IN_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        append_linux_descriptor_eintr_short(
            &mut calls,
            PROTOCOL_OUT_FD,
            &pipe_identity(executable, "7205", PROTOCOL_OUT_BYTES.len() as u64),
            expected,
            PROTOCOL_OUT_BYTES,
            super::WRITER_ACCESS_MODE,
        );
        calls.extend([
            ScriptedCall::ok(Syscall::Fchdir { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::ExecutableHandleSpawn {
                    executable_fd: EXEC_FD,
                    argv: receipt.argv.clone(),
                    env: vec![
                        ("LC_ALL".into(), "C".into()),
                        ("WT_COMPARISON_PROTOCOL_IN_FD".into(), "205".into()),
                        ("WT_COMPARISON_PROTOCOL_OUT_FD".into(), "206".into()),
                        ("WT_COMPARISON_STARTUP_NONCE_FD".into(), "207".into()),
                        ("WT_COMPARISON_STRICT_ADDON_FD".into(), "/dev/fd/203".into()),
                    ],
                    context: context.clone(),
                },
                Reply::ChildPid(9002),
            ),
            ScriptedCall::ok(Syscall::Waitpid { pid: 9002 }, Reply::Exit(0)),
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ROLE_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ADDON_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: PROTOCOL_IN_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Unit,
            ),
        ]);
        calls
    }

    fn linux_launch_prefix_to_descriptor(
        expected: &DirectoryIdentity,
        executable: &FileIdentity,
        target_fd: i32,
    ) -> Vec<ScriptedCall> {
        let mut calls = root_prefix(expected);
        append_linux_exec_descriptor(&mut calls, EXEC_FD, executable, expected);
        let startup = pipe_identity(
            executable,
            "7206",
            STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
        );
        if target_fd == STARTUP_NONCE_FD {
            return calls;
        }
        append_linux_startup_descriptor(&mut calls, STARTUP_NONCE_FD, &startup, expected);
        if target_fd == ROLE_FD {
            return calls;
        }
        append_linux_descriptor(
            &mut calls,
            ROLE_FD,
            &executable
                .clone()
                .with_inode("7202")
                .with_size(ROLE_BYTES.len() as u64),
            expected,
            ROLE_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        if target_fd == ADDON_FD {
            return calls;
        }
        append_linux_descriptor(
            &mut calls,
            ADDON_FD,
            &executable
                .clone()
                .with_inode("7203")
                .with_size(ADDON_BYTES.len() as u64),
            expected,
            ADDON_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        if target_fd == PROTOCOL_IN_FD {
            return calls;
        }
        append_linux_descriptor(
            &mut calls,
            PROTOCOL_IN_FD,
            &pipe_identity(executable, "7204", PROTOCOL_IN_BYTES.len() as u64),
            expected,
            PROTOCOL_IN_BYTES,
            super::READ_ONLY_ACCESS_MODE,
        );
        if target_fd == PROTOCOL_OUT_FD {
            return calls;
        }
        calls
    }

    fn append_linux_descriptor_failure_cleanup(calls: &mut Vec<ScriptedCall>, target_fd: i32) {
        // The child has not started, so cleanup is deterministic and reverse
        // ordered: the failed/current descriptor, then already-open inherited
        // streams, then the executable handle.  This is deliberately a
        // descriptor-only cleanup proof; no final LaunchFailure is injected.
        for fd in match target_fd {
            ROLE_FD => vec![ROLE_FD, STARTUP_NONCE_FD, EXEC_FD],
            ADDON_FD => vec![ADDON_FD, ROLE_FD, STARTUP_NONCE_FD, EXEC_FD],
            PROTOCOL_IN_FD => vec![PROTOCOL_IN_FD, ADDON_FD, ROLE_FD, STARTUP_NONCE_FD, EXEC_FD],
            PROTOCOL_OUT_FD => vec![
                PROTOCOL_OUT_FD,
                PROTOCOL_IN_FD,
                ADDON_FD,
                ROLE_FD,
                STARTUP_NONCE_FD,
                EXEC_FD,
            ],
            STARTUP_NONCE_FD => vec![STARTUP_NONCE_FD, EXEC_FD],
            _ => vec![EXEC_FD],
        } {
            calls.push(ScriptedCall::ok(Syscall::Close { fd }, Reply::Unit));
        }
    }

    fn root_prefix(expected: &DirectoryIdentity) -> Vec<ScriptedCall> {
        vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
        ]
    }

    fn component(value: &str) -> Component {
        Component::try_from(value).unwrap_or_else(|error| {
            panic!("test component {value:?} should be admitted: {error:?}")
        })
    }

    #[test]
    fn every_linux_component_uses_openat2_with_the_frozen_resolution_guards() {
        let expected = identity();
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        root.ensure_directory(&[component("nested")])
            .expect("pinned component");
        fs.assert_script_exhausted();
    }

    #[test]
    fn sync_flushes_all_created_descendant_parents_deepest_first() {
        let expected = identity();
        let mut nested_stat = root_stat();
        nested_stat.inode = "9002".into();
        let mut nested_identity = expected.clone();
        nested_identity.set_inode("9002");
        let mut deep_stat = root_stat();
        deep_stat.inode = "9003".into();
        let mut deep_identity = expected.clone();
        deep_identity.set_inode("9003");
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                },
                Reply::FileIdentity(nested_stat),
            ),
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(PARENT_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PARENT_FD },
                Reply::FileIdentity(nested_stat.clone()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: PARENT_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PARENT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: PARENT_FD },
                Reply::DirectoryIdentity(nested_identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PARENT_FD },
                Reply::DirectoryIdentity(nested_identity),
            ),
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PARENT_FD,
                    component: "deep".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PARENT_FD,
                    component: "deep".into(),
                },
                Reply::FileIdentity(deep_stat),
            ),
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PARENT_FD,
                    component: "deep".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(deep_stat.clone()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(deep_identity.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(deep_identity),
            ),
            // The deepest created descriptor is synced first, then each
            // ancestor, and finally the pinned authority root.
            ScriptedCall::ok(Syscall::Fsync { fd: CHILD_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Fsync { fd: PARENT_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Fsync { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: PARENT_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        root.ensure_directory(&[component("nested"), component("deep")])
            .expect("created descendants");
        root.sync().expect("deepest-first sync");
        fs.assert_script_exhausted();
    }

    #[test]
    fn child_sync_failure_aborts_before_parent_or_root_sync() {
        let expected = identity();
        let mut child = expected.clone();
        child.set_inode("9010");
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: "child-sync-failure".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "child-sync-failure".into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9010")),
            ),
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "child-sync-failure".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(root_stat().with_inode("9010")),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(child.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(child),
            ),
            ScriptedCall::error(Syscall::Fsync { fd: CHILD_FD }, Errno::Permission),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        root.ensure_directory(&[component("child-sync-failure")])
            .expect("created child");
        assert_code(root.sync(), "OUTPUT_SYNC_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn parent_sync_failure_aborts_before_root_sync() {
        let expected = identity();
        let mut child = expected.clone();
        child.set_inode("9011");
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: "parent-sync-failure".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "parent-sync-failure".into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9011")),
            ),
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "parent-sync-failure".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(PARENT_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PARENT_FD },
                Reply::FileIdentity(root_stat().with_inode("9011")),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: PARENT_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PARENT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: PARENT_FD },
                Reply::DirectoryIdentity(child.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PARENT_FD },
                Reply::DirectoryIdentity(child),
            ),
            ScriptedCall::error(Syscall::Fsync { fd: PARENT_FD }, Errno::Permission),
            ScriptedCall::ok(Syscall::Close { fd: PARENT_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        root.ensure_directory(&[component("parent-sync-failure")])
            .expect("created parent");
        assert_code(root.sync(), "OUTPUT_SYNC_FAILED");
        fs.assert_script_exhausted();
    }

    #[test]
    fn missing_statx_mount_id_is_unavailable_and_never_falls_back_to_stat() {
        let expected = identity();
        let mut calls = vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: PINNED_ROOT_FD },
                Reply::StatxMissingMountId,
            ),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(std::mem::take(&mut calls)));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_MOUNT_IDENTITY_UNAVAILABLE",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn statx_enosys_is_a_mount_identity_boundary_blocker() {
        let expected = identity();
        let mut calls = vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::error(Syscall::StatxEmptyPath { fd: PINNED_ROOT_FD }, Errno::NoSys),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(std::mem::take(&mut calls)));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_MOUNT_IDENTITY_UNAVAILABLE",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn openat2_enosys_is_rejected_without_an_openat_fallback() {
        let expected = identity();
        let mut calls = root_prefix(&expected);
        calls.push(ScriptedCall::error(
            Syscall::Openat2 {
                dirfd: PINNED_ROOT_FD,
                component: "nested".into(),
                flags: super::LINUX_DIRECTORY_FLAGS,
                resolve: super::LINUX_OPENAT2_RESOLVE,
            },
            Errno::NoSys,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.ensure_directory(&[component("nested")]),
            "OUTPUT_MOUNT_IDENTITY_UNAVAILABLE",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn linux_sealed_executable_launch_uses_fstat_fstatfs_fchdir_and_handle_spawn() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let mut calls = root_prefix(&expected);
        let context = launch_context(&executable);
        let receipt = launch_receipt(&context, &executable);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable.clone()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: EXEC_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: EXEC_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: EXEC_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: EXEC_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: EXEC_FD,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(EXECUTABLE_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: EXEC_FD,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable.clone()),
            ),
            // The nonce and startup digest are consumed before any role,
            // addon, protocol, or socket-facing descriptor is touched.
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::FileIdentity(pipe_identity(
                    &executable,
                    "7206",
                    STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
                )),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Inheritable,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: STARTUP_NONCE_FD,
                    max: STARTUP_NONCE_BYTES.len(),
                },
                Reply::Bytes(STARTUP_NONCE_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: STARTUP_NONCE_FD,
                    max: STARTUP_DIGEST_BYTES.len(),
                },
                Reply::Bytes(STARTUP_DIGEST_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: STARTUP_NONCE_FD,
                    max: STARTUP_DIGEST_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::FileIdentity(pipe_identity(
                    &executable,
                    "7206",
                    STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
                )),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: ROLE_FD },
                Reply::FileIdentity(
                    executable
                        .clone()
                        .with_inode("7202")
                        .with_size(ROLE_BYTES.len() as u64),
                ),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: ROLE_FD }, Reply::Inheritable),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: ROLE_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: ROLE_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: ROLE_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: ROLE_FD,
                    max: ROLE_BYTES.len(),
                },
                Reply::Bytes(ROLE_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: ROLE_FD,
                    max: ROLE_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: ROLE_FD },
                Reply::FileIdentity(
                    executable
                        .clone()
                        .with_inode("7202")
                        .with_size(ROLE_BYTES.len() as u64),
                ),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: ADDON_FD },
                Reply::FileIdentity(
                    executable
                        .clone()
                        .with_inode("7203")
                        .with_size(ADDON_BYTES.len() as u64),
                ),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: ADDON_FD }, Reply::Inheritable),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: ADDON_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: ADDON_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: ADDON_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: ADDON_FD,
                    max: ADDON_BYTES.len(),
                },
                Reply::Bytes(ADDON_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: ADDON_FD,
                    max: ADDON_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: ADDON_FD },
                Reply::FileIdentity(
                    executable
                        .clone()
                        .with_inode("7203")
                        .with_size(ADDON_BYTES.len() as u64),
                ),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PROTOCOL_IN_FD },
                Reply::FileIdentity(pipe_identity(
                    &executable,
                    "7204",
                    PROTOCOL_IN_BYTES.len() as u64,
                )),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PROTOCOL_IN_FD },
                Reply::Inheritable,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PROTOCOL_IN_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PROTOCOL_IN_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: PROTOCOL_IN_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: PROTOCOL_IN_FD,
                    max: PROTOCOL_IN_BYTES.len(),
                },
                Reply::Bytes(PROTOCOL_IN_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: PROTOCOL_IN_FD,
                    max: PROTOCOL_IN_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PROTOCOL_IN_FD },
                Reply::FileIdentity(pipe_identity(
                    &executable,
                    "7204",
                    PROTOCOL_IN_BYTES.len() as u64,
                )),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::FileIdentity(pipe_identity(
                    &executable,
                    "7205",
                    PROTOCOL_OUT_BYTES.len() as u64,
                )),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::Inheritable,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: PROTOCOL_OUT_FD,
                    max: PROTOCOL_OUT_BYTES.len(),
                },
                Reply::Bytes(PROTOCOL_OUT_BYTES.to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: PROTOCOL_OUT_FD,
                    max: PROTOCOL_OUT_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::FileIdentity(pipe_identity(
                    &executable,
                    "7205",
                    PROTOCOL_OUT_BYTES.len() as u64,
                )),
            ),
            ScriptedCall::ok(Syscall::Fchdir { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::ExecutableHandleSpawn {
                    executable_fd: EXEC_FD,
                    argv: vec![
                        "bun".into(),
                        "--no-install".into(),
                        "--no-env-file".into(),
                        "/dev/fd/202".into(),
                    ],
                    env: vec![
                        ("LC_ALL".into(), "C".into()),
                        ("WT_COMPARISON_PROTOCOL_IN_FD".into(), "205".into()),
                        ("WT_COMPARISON_PROTOCOL_OUT_FD".into(), "206".into()),
                        ("WT_COMPARISON_STARTUP_NONCE_FD".into(), "207".into()),
                        ("WT_COMPARISON_STRICT_ADDON_FD".into(), "/dev/fd/203".into()),
                    ],
                    context: context.clone(),
                },
                Reply::ChildPid(9001),
            ),
            ScriptedCall::ok(Syscall::Waitpid { pid: 9001 }, Reply::Exit(0)),
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ROLE_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: ADDON_FD }, Reply::Unit),
            ScriptedCall::ok(Syscall::Close { fd: PROTOCOL_IN_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: PROTOCOL_OUT_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: STARTUP_NONCE_FD,
                },
                Reply::Unit,
            ),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected.clone())
            .expect("root adoption");
        let launch = root
            .spawn_sealed_executable(
                EXEC_FD,
                &executable,
                &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            )
            .expect("descriptor-bound Linux launch");
        launch.assert_receipt(&receipt);
        launch.assert_receipt_schema("bun-role-launch-receipt/v1");
        launch.assert_host_id("linux-x86_64");
        launch.assert_run_id("run-0001");
        launch.assert_execution_identity(0, "resident", 0);
        launch.assert_bun_sha256(EXECUTABLE_SHA256);
        launch.assert_role_entrypoint_sha256(ROLE_SHA256);
        launch.assert_addon_sha256(ADDON_SHA256);
        launch.assert_descriptor_map_sha256(&context.descriptor_map_sha256);
        launch.assert_exact_argv(&["bun", "--no-install", "--no-env-file", "/dev/fd/202"]);
        launch.assert_exact_environment(&[
            "LC_ALL=C",
            "WT_COMPARISON_PROTOCOL_IN_FD=205",
            "WT_COMPARISON_PROTOCOL_OUT_FD=206",
            "WT_COMPARISON_STARTUP_NONCE_FD=207",
            "WT_COMPARISON_STRICT_ADDON_FD=203",
        ]);
        launch.assert_launch_primitive("linux-execveat-empty-path");
        launch.assert_startup_digest_sha256(&context.startup_digest_sha256);
        launch.assert_startup_nonce_sha256(&context.startup_nonce_sha256);
        launch.assert_addon_requested_specifier("/dev/fd/203");
        launch.assert_addon_load_attempt_count(1);
        launch.assert_addon_loaded_sha256(ADDON_SHA256);
        launch.assert_no_addon_fallback_candidates();
        launch.assert_socket_before_startup_handshake(false);
        launch.assert_descriptor_kind("executable", "executable");
        launch.assert_descriptor_identity_sha256("roleFd", ROLE_IDENTITY_SHA256);
        launch.assert_source_descriptor_sha256(SOURCE_EXEC_FD, EXECUTABLE_SHA256);
        launch.assert_role_descriptor_consumed_to_eof(ROLE_FD, ROLE_SHA256);
        launch.assert_addon_descriptor_consumed_to_eof(ADDON_FD, ADDON_SHA256);
        fs.assert_script_exhausted();

        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable.clone().with_inode("7002")),
            ),
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let context = launch_context(&executable);
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.spawn_sealed_executable(
                EXEC_FD,
                &executable,
                &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            ),
            "OUTPUT_EXEC_REPLACED",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn linux_launch_receipt_binds_frozen_context_and_real_pipe_identities() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        assert_eq!(context.run_id, "run-0001");
        assert_eq!(context.logical_role, "resident");
        assert_eq!(context.execution_index, 0);
        assert_eq!(context.process_ordinal, 0);
        assert_eq!(context.clock_rfc3339, "2026-08-24T00:00:12Z");
        assert_eq!(context.source_receipt_bytes, SOURCE_RECEIPT_BYTES);
        assert_eq!(context.startup_nonce, STARTUP_NONCE_BYTES);
        assert_eq!(context.startup_digest, STARTUP_DIGEST_BYTES);
        assert_eq!(
            context.source_receipt_sha256,
            "d5731ace35d5721860efe8b0d9ea49f9d48b87eb20480e05bc56770823521ed8"
        );
        assert_eq!(context.startup_nonce_sha256, STARTUP_NONCE_BYTES_SHA256);
        assert_eq!(context.startup_digest_sha256, STARTUP_DIGEST_SHA256);
        assert_eq!(
            context.descriptor_map_sha256,
            "45d8ea9fc4c0830216aa48b81f29896756b5415fed01187817365e44c3f50eeb"
        );

        let receipt = launch_receipt(&context, &executable);
        let argv = ["bun", "--no-install", "--no-env-file", "/dev/fd/202"];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(linux_launch_contract_calls(
            &expected,
            &executable,
            &context,
            &receipt,
        )));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        let launch = root
            .spawn_sealed_executable(
                EXEC_FD,
                &executable,
                &argv,
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            )
            .expect("descriptor-bound launch");
        launch.assert_receipt(&receipt);
        launch.assert_receipt_schema("bun-role-launch-receipt/v1");
        launch.assert_descriptor_kind("roleFd", "regular");
        launch.assert_descriptor_kind("addonFd", "regular");
        launch.assert_descriptor_kind("protocolInFd", "pipe");
        launch.assert_descriptor_kind("protocolOutFd", "pipe");
        launch.assert_descriptor_kind("startupNonceFd", "pipe");
        launch.assert_descriptor_identity_sha256("roleFd", ROLE_IDENTITY_SHA256);
        launch.assert_descriptor_identity_sha256("addonFd", ADDON_IDENTITY_SHA256);
        launch.assert_descriptor_identity_sha256("protocolInFd", PROTOCOL_IN_IDENTITY_SHA256);
        launch.assert_descriptor_identity_sha256("protocolOutFd", PROTOCOL_OUT_IDENTITY_SHA256);
        launch.assert_descriptor_identity_sha256("startupNonceFd", STARTUP_IDENTITY_SHA256);
        launch.assert_startup_nonce_sha256(STARTUP_NONCE_BYTES_SHA256);
        launch.assert_startup_digest_sha256(STARTUP_DIGEST_SHA256);
        launch.assert_socket_before_startup_handshake(false);
        fs.assert_script_exhausted();
    }

    #[test]
    fn linux_launch_streams_retry_eintr_and_short_chunks_for_every_inherited_descriptor() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        let receipt = launch_receipt(&context, &executable);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(
            linux_launch_chunked_contract_calls(&expected, &executable, &context, &receipt),
        ));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        let launch = root
            .spawn_sealed_executable(
                EXEC_FD,
                &executable,
                &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            )
            .expect("all descriptor streams retry EINTR and short reads");
        launch.assert_receipt(&receipt);
        launch.assert_role_descriptor_consumed_to_eof(ROLE_FD, ROLE_SHA256);
        launch.assert_addon_descriptor_consumed_to_eof(ADDON_FD, ADDON_SHA256);
        launch.assert_startup_nonce_sha256(STARTUP_NONCE_BYTES_SHA256);
        launch.assert_startup_digest_sha256(STARTUP_DIGEST_SHA256);
        fs.assert_script_exhausted();
    }

    #[test]
    fn linux_inherited_role_addon_protocol_and_nonce_flags_are_checked_individually() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        let argv = ["bun", "--no-install", "--no-env-file", "/dev/fd/202"];
        let env = [
            ("LC_ALL", "C"),
            ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
            ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
            ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
            ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
        ];

        for target_fd in [
            ROLE_FD,
            ADDON_FD,
            PROTOCOL_IN_FD,
            PROTOCOL_OUT_FD,
            STARTUP_NONCE_FD,
        ] {
            for bad_cloexec in [true, false] {
                let mut calls =
                    linux_launch_prefix_to_descriptor(&expected, &executable, target_fd);
                let observed = match target_fd {
                    ROLE_FD => executable
                        .clone()
                        .with_inode("7202")
                        .with_size(ROLE_BYTES.len() as u64),
                    ADDON_FD => executable
                        .clone()
                        .with_inode("7203")
                        .with_size(ADDON_BYTES.len() as u64),
                    PROTOCOL_IN_FD => {
                        pipe_identity(&executable, "7204", PROTOCOL_IN_BYTES.len() as u64)
                    }
                    PROTOCOL_OUT_FD => {
                        pipe_identity(&executable, "7205", PROTOCOL_OUT_BYTES.len() as u64)
                    }
                    STARTUP_NONCE_FD => pipe_identity(
                        &executable,
                        "7206",
                        STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
                    ),
                    _ => unreachable!("only inherited descriptors are covered"),
                };
                calls.push(ScriptedCall::ok(
                    Syscall::Fstat { fd: target_fd },
                    Reply::FileIdentity(observed),
                ));
                if bad_cloexec {
                    calls.push(ScriptedCall::ok(
                        Syscall::FcntlGetFd { fd: target_fd },
                        Reply::CloseOnExec,
                    ));
                } else {
                    calls.extend([
                        ScriptedCall::ok(Syscall::FcntlGetFd { fd: target_fd }, Reply::Inheritable),
                        ScriptedCall::ok(
                            Syscall::FcntlGetFl { fd: target_fd },
                            Reply::Flags(if target_fd == PROTOCOL_OUT_FD {
                                super::READ_ONLY_ACCESS_MODE
                            } else {
                                super::WRITER_ACCESS_MODE
                            }),
                        ),
                    ]);
                }
                append_linux_descriptor_failure_cleanup(&mut calls, target_fd);

                let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
                let root = fs
                    .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                    .expect("root adoption");
                let error =
                    match root.spawn_sealed_executable(EXEC_FD, &executable, &argv, &env, &context)
                    {
                        Ok(_) => panic!("descriptor mode/CLOEXEC drift must fail before spawn"),
                        Err(error) => error,
                    };
                assert!(
                    error.code().starts_with("OUTPUT_EXEC_")
                        || error.code() == "OUTPUT_SYSCALL_SCRIPT_MISMATCH",
                    "unexpected typed descriptor error for fd {target_fd}: {}",
                    error.code()
                );
                fs.assert_script_exhausted();
            }
        }
    }

    #[test]
    fn linux_inherited_descriptor_identity_and_stream_mutations_fail_at_the_boundary() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        let argv = ["bun", "--no-install", "--no-env-file", "/dev/fd/202"];
        let env = [
            ("LC_ALL", "C"),
            ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
            ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
            ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
            ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
        ];

        // A changed inode, and a pipe descriptor that changes kind to a
        // regular file, are both induced at fstat rather than injected as a
        // final launch error.
        for target_fd in [
            ROLE_FD,
            ADDON_FD,
            PROTOCOL_IN_FD,
            PROTOCOL_OUT_FD,
            STARTUP_NONCE_FD,
        ] {
            let mut calls = linux_launch_prefix_to_descriptor(&expected, &executable, target_fd);
            let mut observed = match target_fd {
                ROLE_FD => executable
                    .clone()
                    .with_inode("7202")
                    .with_size(ROLE_BYTES.len() as u64),
                ADDON_FD => executable
                    .clone()
                    .with_inode("7203")
                    .with_size(ADDON_BYTES.len() as u64),
                PROTOCOL_IN_FD => {
                    pipe_identity(&executable, "7204", PROTOCOL_IN_BYTES.len() as u64)
                }
                PROTOCOL_OUT_FD => {
                    pipe_identity(&executable, "7205", PROTOCOL_OUT_BYTES.len() as u64)
                }
                STARTUP_NONCE_FD => pipe_identity(
                    &executable,
                    "7206",
                    STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
                ),
                _ => unreachable!(),
            };
            if matches!(
                target_fd,
                PROTOCOL_IN_FD | PROTOCOL_OUT_FD | STARTUP_NONCE_FD
            ) {
                observed.kind = FileKind::Regular;
            }
            observed.inode = "9999".into();
            calls.push(ScriptedCall::ok(
                Syscall::Fstat { fd: target_fd },
                Reply::FileIdentity(observed),
            ));
            append_linux_descriptor_failure_cleanup(&mut calls, target_fd);
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                .expect("root adoption");
            let error =
                match root.spawn_sealed_executable(EXEC_FD, &executable, &argv, &env, &context) {
                    Ok(_) => panic!("identity/kind drift must fail before descriptor reads"),
                    Err(error) => error,
                };
            assert!(error.code().starts_with("OUTPUT_EXEC_"));
            fs.assert_script_exhausted();
        }

        for target_fd in [
            ROLE_FD,
            ADDON_FD,
            PROTOCOL_IN_FD,
            PROTOCOL_OUT_FD,
            STARTUP_NONCE_FD,
        ] {
            for trailing in [false, true] {
                let mut calls =
                    linux_launch_prefix_to_descriptor(&expected, &executable, target_fd);
                let observed = match target_fd {
                    ROLE_FD => executable
                        .clone()
                        .with_inode("7202")
                        .with_size(ROLE_BYTES.len() as u64),
                    ADDON_FD => executable
                        .clone()
                        .with_inode("7203")
                        .with_size(ADDON_BYTES.len() as u64),
                    PROTOCOL_IN_FD => {
                        pipe_identity(&executable, "7204", PROTOCOL_IN_BYTES.len() as u64)
                    }
                    PROTOCOL_OUT_FD => {
                        pipe_identity(&executable, "7205", PROTOCOL_OUT_BYTES.len() as u64)
                    }
                    STARTUP_NONCE_FD => pipe_identity(
                        &executable,
                        "7206",
                        STARTUP_NONCE_BYTES.len() as u64 + STARTUP_DIGEST_BYTES.len() as u64,
                    ),
                    _ => unreachable!(),
                };
                let bytes = match target_fd {
                    ROLE_FD => ROLE_BYTES,
                    ADDON_FD => ADDON_BYTES,
                    PROTOCOL_IN_FD => PROTOCOL_IN_BYTES,
                    PROTOCOL_OUT_FD => PROTOCOL_OUT_BYTES,
                    STARTUP_NONCE_FD => STARTUP_NONCE_BYTES,
                    _ => unreachable!(),
                };
                if target_fd == STARTUP_NONCE_FD {
                    append_linux_startup_descriptor_with_terminal(
                        &mut calls,
                        target_fd,
                        &observed,
                        &expected,
                        if trailing {
                            STARTUP_NONCE_BYTES
                        } else {
                            &STARTUP_NONCE_BYTES[..STARTUP_NONCE_BYTES.len() - 1]
                        },
                        STARTUP_DIGEST_BYTES,
                        if trailing {
                            Reply::Bytes(b"unexpected-startup-trailing\n".to_vec())
                        } else {
                            Reply::Bytes(Vec::new())
                        },
                    );
                } else {
                    let payload = if trailing {
                        bytes
                    } else {
                        &bytes[..bytes.len() - 1]
                    };
                    append_linux_descriptor_with_terminal(
                        &mut calls,
                        target_fd,
                        &observed,
                        &expected,
                        payload,
                        if target_fd == PROTOCOL_OUT_FD {
                            super::WRITER_ACCESS_MODE
                        } else {
                            super::READ_ONLY_ACCESS_MODE
                        },
                        if trailing {
                            Reply::Bytes(b"unexpected-stream-trailing\n".to_vec())
                        } else {
                            Reply::Bytes(Vec::new())
                        },
                    );
                }
                append_linux_descriptor_failure_cleanup(&mut calls, target_fd);
                let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
                let root = fs
                    .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                    .expect("root adoption");
                let error =
                    match root.spawn_sealed_executable(EXEC_FD, &executable, &argv, &env, &context)
                    {
                        Ok(_) => panic!("trailing/premature stream must fail before spawn"),
                        Err(error) => error,
                    };
                assert!(error.code().starts_with("OUTPUT_EXEC_"));
                fs.assert_script_exhausted();
            }
        }
    }

    #[test]
    fn linux_changed_argv_is_rejected_at_handle_spawn_not_as_a_final_error() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        let receipt = launch_receipt(&context, &executable);
        let mut calls = linux_launch_contract_calls(&expected, &executable, &context, &receipt);
        // The queue contains the approved argv.  Passing a changed argv makes
        // the descriptor-bound spawn seam reject the request; no synthetic
        // LaunchFailure reply is used and no pathname fallback is available.
        let mutated_argv = ["bun", "--no-install", "--no-env-file", "/dev/fd/999"];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(std::mem::take(&mut calls)));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        let error = match root.spawn_sealed_executable(
            EXEC_FD,
            &executable,
            &mutated_argv,
            &[
                ("LC_ALL", "C"),
                ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
            ],
            &context,
        ) {
            Ok(_) => panic!("changed argv must not reach child execution"),
            Err(error) => error,
        };
        assert!(
            error.code() == "OUTPUT_SYSCALL_SCRIPT_MISMATCH"
                || error.code().starts_with("OUTPUT_EXEC_"),
            "changed argv must fail at the descriptor launch boundary: {}",
            error.code()
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn linux_launch_rejects_executable_access_mode_or_cloexec_mutations() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        for (cloexec, access_mode) in [
            (Reply::Inheritable, None),
            (Reply::CloseOnExec, Some(super::WRITER_ACCESS_MODE)),
        ] {
            let context = launch_context(&executable);
            let mut calls = root_prefix(&expected);
            calls.push(ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable.clone()),
            ));
            calls.push(ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: EXEC_FD },
                cloexec,
            ));
            if let Some(access_mode) = access_mode {
                calls.push(ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd: EXEC_FD },
                    Reply::Flags(access_mode),
                ));
            }
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: EXEC_FD },
                Reply::Unit,
            ));
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let context = launch_context(&executable);
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                .expect("root adoption");
            assert_code(
                root.spawn_sealed_executable(
                    EXEC_FD,
                    &executable,
                    &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                    &[
                        ("LC_ALL", "C"),
                        ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                        ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                        ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                        ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                    ],
                    &context,
                ),
                "OUTPUT_EXEC_HANDLE_INVALID",
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn linux_changed_executable_bytes_are_rehashed_before_handle_spawn() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "7001".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable.clone()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: EXEC_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: EXEC_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: EXEC_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: EXEC_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            // The bytes differ from the approved source but are consumed to
            // EOF by the real descriptor hash path; no final LaunchFailure
            // reply is injected.
            ScriptedCall::ok(
                Syscall::Read {
                    fd: EXEC_FD,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(b"#!/usr/bin/env bun!\n".to_vec()),
            ),
            ScriptedCall::ok(
                Syscall::Read {
                    fd: EXEC_FD,
                    max: EXECUTABLE_BYTES.len(),
                },
                Reply::Bytes(Vec::new()),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: EXEC_FD },
                Reply::FileIdentity(executable),
            ),
            ScriptedCall::ok(Syscall::Close { fd: EXEC_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.spawn_sealed_executable(
                EXEC_FD,
                &FileIdentity {
                    kind: FileKind::Regular,
                    device: "8:1".into(),
                    inode: "7001".into(),
                    mount_id: Some("55".into()),
                    fsid_word0: "1234".into(),
                    fsid_word1: "5678".into(),
                    owner_uid: 501,
                    mode: 0o500,
                    hard_link_count: "1".into(),
                    size: EXECUTABLE_BYTES.len() as u64,
                },
                &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            ),
            "OUTPUT_EXEC_DIGEST_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn fstatfs_rejects_overlay_or_unapproved_filesystem_magic() {
        let expected = identity();
        let mut observed = expected.clone();
        observed.set_file_system_type("overlay");
        let mut calls = root_prefix(&observed);
        calls.truncate(4);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn linux_filesystem_matrix_allows_only_ext4_xfs_and_btrfs() {
        let supported = [
            ("ext4", "0000ef53"),
            ("xfs", "58465342"),
            ("btrfs", "9123683e"),
        ];
        for (file_system_type, magic) in supported {
            let mut expected = identity();
            if let DirectoryIdentity::Linux(ref mut linux) = expected {
                linux.file_system_type = file_system_type.into();
                linux.file_system_type_magic = magic.into();
            }
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(root_prefix(&expected)));
            fs.adopt_staging(INHERITED_ROOT_FD, expected)
                .expect("approved local filesystem is adoptable");
            fs.assert_script_exhausted();
        }

        for file_system_type in [
            "tmpfs",
            "overlayfs",
            "nfs",
            "smbfs",
            "procfs",
            "sysfs",
            "devfs",
            "devtmpfs",
            "fuse",
            "unknown",
        ] {
            let expected = identity();
            let mut observed = expected.clone();
            observed.set_file_system_type(file_system_type);
            let mut calls = root_prefix(&observed);
            calls.truncate(4); // reject immediately after fstatfs, before statx
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: PINNED_ROOT_FD },
                Reply::Unit,
            ));
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            assert_code(
                fs.adopt_staging(INHERITED_ROOT_FD, expected),
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn descendant_fsid_or_mount_drift_is_rejected_even_when_the_inode_is_unchanged() {
        let expected = identity();
        let mut drifted = expected.clone();
        drifted.set_mount_id("56");
        drifted.set_fsid_word0("9999");
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(drifted.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(drifted),
            ),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.ensure_directory(&[component("nested")]),
            "OUTPUT_MOUNT_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn descendant_cross_device_drift_is_rejected_without_a_mount_alias_fallback() {
        let expected = identity();
        let mut drifted = expected.clone();
        if let DirectoryIdentity::Linux(ref mut linux) = drifted {
            linux.device_major = "8".into();
            linux.device_minor = "2".into();
        }
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "cross-device".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(drifted),
            ),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.ensure_directory(&[component("cross-device")]),
            "OUTPUT_PATH_CROSS_DEVICE",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn leaf_replacement_between_no_follow_stat_and_open_is_a_race_failure() {
        let expected = identity();
        let mut replacement = FileIdentity {
            kind: FileKind::Regular,
            device: "8:1".into(),
            inode: "9101".into(),
            mount_id: Some("55".into()),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o600,
            hard_link_count: "1".into(),
            size: 0,
        };
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                },
                Reply::FileIdentity(replacement.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                    flags: super::LINUX_READ_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(LEAF_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity({
                    replacement.set_inode("9102");
                    replacement
                }),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.open_read_stream(&[component("manifest.json")], 1024),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn symlink_magic_link_fifo_and_hard_link_leaves_are_rejected() {
        let expected = identity();
        for (kind, error_code) in [
            (FileKind::Symlink, "OUTPUT_FILE_INVALID"),
            (FileKind::MagicLink, "OUTPUT_PATH_REPARSE"),
            (FileKind::Fifo, "OUTPUT_FILE_INVALID"),
            (FileKind::Socket, "OUTPUT_FILE_INVALID"),
            (FileKind::BlockDevice, "OUTPUT_PATH_DEVICE"),
            (FileKind::CharacterDevice, "OUTPUT_PATH_DEVICE"),
        ] {
            let mut calls = root_prefix(&expected);
            calls.extend([ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "leaf".into(),
                },
                Reply::FileIdentity(FileIdentity {
                    kind,
                    size: 0,
                    ..root_stat()
                }),
            )]);
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                .expect("root adoption");
            assert_code(root.open_read_stream(&[component("leaf")], 128), error_code);
            fs.assert_script_exhausted();
        }

        let mut calls = root_prefix(&expected);
        calls.push(ScriptedCall::ok(
            Syscall::FstatatNoFollow {
                dirfd: PINNED_ROOT_FD,
                component: "hard-linked".into(),
            },
            Reply::FileIdentity(FileIdentity {
                hard_link_count: "2".into(),
                kind: FileKind::Regular,
                size: 0,
                ..root_stat()
            }),
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.open_read_stream(&[component("hard-linked")], 128),
            "OUTPUT_PATH_HARDLINK",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn mkdirat_reopen_and_identity_check_detects_intermediate_replacement() {
        let expected = identity();
        let mut replacement = expected.clone();
        replacement.set_inode("9999");
        let mut calls = root_prefix(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: "new".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "new".into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9999")),
            ),
            ScriptedCall::ok(
                Syscall::Openat2 {
                    dirfd: PINNED_ROOT_FD,
                    component: "new".into(),
                    flags: super::LINUX_DIRECTORY_FLAGS,
                    resolve: super::LINUX_OPENAT2_RESOLVE,
                },
                Reply::Fd(CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: CHILD_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: CHILD_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: CHILD_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::StatxEmptyPath { fd: CHILD_FD },
                Reply::DirectoryIdentity(replacement),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: CHILD_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: CHILD_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.ensure_directory(&[component("new")]),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn writable_or_multi_link_root_is_not_an_adoptable_authority_root() {
        let expected = identity();
        let mut writable = root_stat();
        writable.mode = 0o777;
        let mut calls = vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(writable),
            ),
            ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
        ];
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(std::mem::take(&mut calls)));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn root_owner_type_link_and_mode_variants_are_all_rejected_before_mount_use() {
        for variant in [
            FileIdentity {
                kind: FileKind::Regular,
                size: 0,
                ..root_file_identity()
            },
            FileIdentity {
                owner_uid: 502,
                size: 0,
                ..root_file_identity()
            },
            FileIdentity {
                hard_link_count: "2".into(),
                size: 0,
                ..root_file_identity()
            },
            FileIdentity {
                mode: 0o770,
                size: 0,
                ..root_file_identity()
            },
        ] {
            let identity = linux_identity();
            let calls = vec![
                ScriptedCall::ok(
                    Syscall::Dup {
                        fd: INHERITED_ROOT_FD,
                    },
                    Reply::Fd(PINNED_ROOT_FD),
                ),
                ScriptedCall::ok(
                    Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                    Reply::CloseOnExec,
                ),
                ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                    Reply::Flags(super::READ_ONLY_ACCESS_MODE),
                ),
                ScriptedCall::ok(
                    Syscall::Fstat { fd: PINNED_ROOT_FD },
                    Reply::FileIdentity(variant),
                ),
                ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
            ];
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            assert_code(
                fs.adopt_staging(INHERITED_ROOT_FD, identity),
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            );
            fs.assert_script_exhausted();
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_red {
    use super::secure_fs::test_support::{Errno, Reply, ScriptedCall, ScriptedSyscalls, Syscall};
    use super::secure_fs::{
        Component, DirectoryIdentity, FileIdentity, FileKind, FsError, SecureFs,
    };

    const INHERITED_ROOT_FD: i32 = 41;
    const PINNED_ROOT_FD: i32 = 101;
    const LEAF_FD: i32 = 103;
    const EXEC_FD: i32 = 201;
    const ROLE_FD: i32 = 202;
    const ADDON_FD: i32 = 203;
    const PROTOCOL_IN_FD: i32 = 205;
    const PROTOCOL_OUT_FD: i32 = 206;
    const STARTUP_NONCE_FD: i32 = 207;
    const SOURCE_EXEC_FD: i32 = 208;
    const STAGED_EXEC_FD: i32 = 204;
    const EXECUTABLE_BYTES: &[u8] = b"#!/usr/bin/env bun\n";
    const EXECUTABLE_SHA256: &str =
        "1af9f724d86a6268aa72c8a187248c1d06937501784da400b5a3199270bc3c41";
    const ROLE_BYTES: &[u8] = b"role-entrypoint-v1\n";
    const ROLE_SHA256: &str = "63e591931698b9cf84fd67e10c6e6db3be528b17b151e8b518f7913195a442f1";
    const ADDON_BYTES: &[u8] = b"native-addon-v1\n";
    const ADDON_SHA256: &str = "e5c45d8b47e8173e66f4128d01138ae9539f4885bd457b298738206c5621b7c4";
    const PROTOCOL_IN_BYTES: &[u8] = b"protocol-in-v1\n";
    const PROTOCOL_IN_SHA256: &str =
        "5c0f1db3d54b33e8b247a17ce1a14118da604154ce0ee8e29dd44adc060f65b7";
    const PROTOCOL_OUT_BYTES: &[u8] = b"protocol-out-v1\n";
    const PROTOCOL_OUT_SHA256: &str =
        "1224532881a864c67f28b0b7b4ac64eb1a9b68ba3efa5cd2fdf74c48ccec5618";
    const STARTUP_NONCE_BYTES: &[u8] = b"startup-nonce-v1\n";
    const STARTUP_NONCE_BYTES_SHA256: &str =
        "1eb65b8eae8305176c24f564bb62ee98568145874d87d6e6d232962774501f10";
    const STARTUP_DIGEST_BYTES: &[u8] = b"startup-digest-v1\n";
    const STARTUP_DIGEST_SHA256: &str =
        "753a4b4c48c1476060e426a0cc5973a03021525b3591db8b1c1c20192469ec79";

    // These are SHA-256 digests of the canonical, ordered Mac identity
    // tuples used by the launch receipt.  They are intentionally distinct
    // from the Linux identities and from the old all-'a'/all-'b' sentinels:
    // a receipt must bind the real device/inode/kind/mode/size tuple for each
    // descriptor, including the anonymous pipe descriptors.
    const AUTHORITY_IDENTITY_SHA256: &str =
        "1cdc1a68263a00eef219be5ebeb5129c82e3fce70ec68832e2f21a190f454687";
    const EXEC_PARENT_IDENTITY_SHA256: &str =
        "c2b72c6974f5416153d6e85f8d94c52f75b1d72a0659e80b7e787cc6c9017bf3";
    const EXECUTABLE_IDENTITY_SHA256: &str =
        "8ff19f61bc22cd988f50b124edd3328c30f043d4b020b3218fd3862269b63db4";
    const ROLE_IDENTITY_SHA256: &str =
        "8fff3c88d1655932890dcdaaa5c4ff695471290b17081ac5c94528287d37f735";
    const ADDON_IDENTITY_SHA256: &str =
        "4f51bbbcee46910756783cdd399200d45fce1e0f84389571ed9197ce5254ddd1";
    const PROTOCOL_IN_IDENTITY_SHA256: &str =
        "165a703aa8c0fad635abbeb66091fde216af5bcb3dd25bd2f8549ccf27f45fb3c";
    const PROTOCOL_OUT_IDENTITY_SHA256: &str =
        "7be5517502d7808daed2c520cd6f4956918d275145c7afa2e2aa5bc715d806e5";
    const STARTUP_IDENTITY_SHA256: &str =
        "3c5716b00137e5d410cde3a1e2e070ef928a08db4454886de4649d599c119985";
    const EXEC_PARENT_MOUNT_TABLE_SHA256: &str =
        "0b90e431085f0c7f832ed14eea19eeb4f37fb8e840f02d3feba2aeaddfba3d44";
    const EXEC_PARENT_PATH_SHA256: &str =
        "7bb0ca1ddee5ca8be284181515177943e5e04821873db210b1f752dfc168f2e3";
    const DESCRIPTOR_MAP_PREIMAGE: &[u8] = b"authority|directory|16777234|9001|0|700|1|501|apfs\n";
    const SOURCE_RECEIPT_BYTES: &[u8] = b"source-receipt-v1\n";

    fn launch_context(
        executable: &FileIdentity,
    ) -> super::secure_fs::test_support::LaunchContextV1 {
        super::secure_fs::test_support::LaunchContextV1 {
            supervisor_instance: "supervisor-instance-01".into(),
            run_id: "run-0001".into(),
            logical_role: "resident".into(),
            execution_index: 0,
            process_ordinal: 0,
            clock_rfc3339: "2026-08-24T00:00:12Z".into(),
            source_receipt_sha256:
                "d5731ace35d5721860efe8b0d9ea49f9d48b87eb20480e05bc56770823521ed8".into(),
            source_receipt_bytes: SOURCE_RECEIPT_BYTES.to_vec(),
            source_executable: executable.clone(),
            descriptor_map_preimage: DESCRIPTOR_MAP_PREIMAGE.to_vec(),
            descriptor_map_sha256:
                "c4b833cfe67a5c9d15635047f0ed79a447dde354d7b71730074dc59f5ab429a5".into(),
            startup_nonce: STARTUP_NONCE_BYTES.to_vec(),
            startup_nonce_sha256: STARTUP_NONCE_BYTES_SHA256.into(),
            startup_digest: STARTUP_DIGEST_BYTES.to_vec(),
            startup_digest_sha256: STARTUP_DIGEST_SHA256.into(),
        }
    }

    fn assert_code<T>(result: Result<T, FsError>, expected: &str) {
        let error = match result {
            Ok(_) => panic!("expected {expected}, got success"),
            Err(error) => error,
        };
        assert_eq!(error.code(), expected);
    }

    fn identity() -> DirectoryIdentity {
        DirectoryIdentity::Macos(super::secure_fs::MacosDirectoryIdentity {
            device: "16777234".into(),
            inode: "9001".into(),
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            file_system_type: "apfs".into(),
            volume_uuid: "00112233445566778899aabbccddeeff".into(),
            mount_table_entry_sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            canonical_descriptor_path_sha256:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            owner_uid: 501,
            mode: 0o700,
            hard_link_count: "1".into(),
        })
    }

    fn root_stat() -> FileIdentity {
        FileIdentity {
            kind: FileKind::Directory,
            device: "16777234".into(),
            inode: "9001".into(),
            mount_id: None,
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o700,
            hard_link_count: "1".into(),
            size: 0,
        }
    }

    fn pipe_identity(template: &FileIdentity, inode: &str, size: u64) -> FileIdentity {
        FileIdentity {
            kind: FileKind::Pipe,
            size,
            ..template.clone().with_inode(inode)
        }
    }

    fn adopt_calls(expected: &DirectoryIdentity) -> Vec<ScriptedCall> {
        vec![
            ScriptedCall::ok(
                Syscall::Dup {
                    fd: INHERITED_ROOT_FD,
                },
                Reply::Fd(PINNED_ROOT_FD),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: PINNED_ROOT_FD },
                Reply::FileIdentity(root_stat()),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: PINNED_ROOT_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid { fd: PINNED_ROOT_FD },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath { fd: PINNED_ROOT_FD },
                Reply::Path("/Volumes/r1/staging".into()),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
        ]
    }

    fn component(value: &str) -> Component {
        Component::try_from(value).unwrap_or_else(|error| {
            panic!("test component {value:?} should be admitted: {error:?}")
        })
    }

    fn launch_receipt(
        context: &super::secure_fs::test_support::LaunchContextV1,
        executable: &FileIdentity,
    ) -> super::secure_fs::test_support::LaunchReceiptV1 {
        assert_eq!(executable.size, EXECUTABLE_BYTES.len() as u64);
        super::secure_fs::test_support::LaunchReceiptV1 {
            schema: "bun-role-launch-receipt/v1".into(),
            host_id: "darwin-arm64".into(),
            run_id: context.run_id.clone(),
            execution_index: context.execution_index,
            logical_role: context.logical_role.clone(),
            process_ordinal: context.process_ordinal,
            bun_sha256: EXECUTABLE_SHA256.into(),
            role_entrypoint_sha256: ROLE_SHA256.into(),
            addon_sha256: ADDON_SHA256.into(),
            argv: vec![
                "bun".into(),
                "--no-install".into(),
                "--no-env-file".into(),
                "/dev/fd/202".into(),
            ],
            environment: vec![
                "LC_ALL=C".into(),
                "WT_COMPARISON_PROTOCOL_IN_FD=205".into(),
                "WT_COMPARISON_PROTOCOL_OUT_FD=206".into(),
                "WT_COMPARISON_STARTUP_NONCE_FD=207".into(),
                "WT_COMPARISON_STRICT_ADDON_FD=203".into(),
            ],
            descriptor_map: vec![
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "authority".into(),
                    fd: PINNED_ROOT_FD,
                    access: "read".into(),
                    kind: "directory".into(),
                    close_on_exec: true,
                    inherited_by_child: false,
                    identity_sha256: AUTHORITY_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "exec-parent".into(),
                    fd: super::posix_red::PARENT_FD,
                    access: "read".into(),
                    kind: "directory".into(),
                    close_on_exec: true,
                    inherited_by_child: false,
                    identity_sha256: EXEC_PARENT_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "executable".into(),
                    fd: EXEC_FD,
                    access: "read".into(),
                    kind: "executable".into(),
                    close_on_exec: true,
                    inherited_by_child: false,
                    identity_sha256: EXECUTABLE_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "roleFd".into(),
                    fd: ROLE_FD,
                    access: "read".into(),
                    kind: "regular".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: ROLE_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "addonFd".into(),
                    fd: ADDON_FD,
                    access: "read".into(),
                    kind: "regular".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: ADDON_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "protocolInFd".into(),
                    fd: PROTOCOL_IN_FD,
                    access: "read".into(),
                    kind: "pipe".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: PROTOCOL_IN_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "protocolOutFd".into(),
                    fd: PROTOCOL_OUT_FD,
                    access: "write".into(),
                    kind: "pipe".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: PROTOCOL_OUT_IDENTITY_SHA256.into(),
                },
                super::secure_fs::test_support::DescriptorBindingV1 {
                    logical_name: "startupNonceFd".into(),
                    fd: STARTUP_NONCE_FD,
                    access: "read".into(),
                    kind: "pipe".into(),
                    close_on_exec: false,
                    inherited_by_child: true,
                    identity_sha256: STARTUP_IDENTITY_SHA256.into(),
                },
            ],
            sealed_execution_identity: Some(super::secure_fs::MacosDirectoryIdentity {
                device: "16777234".into(),
                inode: "9300".into(),
                fsid_word0: "1234".into(),
                fsid_word1: "5678".into(),
                file_system_type: "apfs".into(),
                volume_uuid: "00112233445566778899aabbccddeeff".into(),
                mount_table_entry_sha256: EXEC_PARENT_MOUNT_TABLE_SHA256.into(),
                canonical_descriptor_path_sha256: EXEC_PARENT_PATH_SHA256.into(),
                owner_uid: 501,
                mode: 0o500,
                hard_link_count: "1".into(),
            }),
            launch_primitive: "macos-sealed-relative-posix-spawn".into(),
            descriptor_map_sha256: context.descriptor_map_sha256.clone(),
            startup_nonce_sha256: context.startup_nonce_sha256.clone(),
            startup_digest_sha256: context.startup_digest_sha256.clone(),
            addon_requested_specifier: "/dev/fd/203".into(),
            addon_load_attempt_count: 1,
            addon_loaded_sha256: ADDON_SHA256.into(),
            addon_fallback_candidates: Vec::new(),
            socket_before_startup_handshake: false,
            launched_at: context.clock_rfc3339.clone(),
        }
    }

    fn mac_campaign_reservation_prefix(
        expected: &DirectoryIdentity,
        candidate: &DirectoryIdentity,
        campaign: &DirectoryIdentity,
    ) -> Vec<ScriptedCall> {
        let mut calls = adopt_calls(expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "candidate-01".into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9101")),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "candidate-01".into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(super::posix_red::PARENT_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::FileIdentity(root_stat().with_inode("9101")),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::DirectoryIdentity(candidate.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Path("/Volumes/r1/staging/candidate-01".into()),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: "campaign-0001".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::PARENT_FD,
                    component: "campaign-0001".into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9200")),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: "campaign-0001".into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(super::posix_red::CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::FileIdentity(root_stat().with_inode("9200")),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::DirectoryIdentity(campaign.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Path("/Volumes/r1/staging/candidate-01/campaign-0001".into()),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::CHILD_FD,
                    component: ".campaign-reservation.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::CHILD_FD,
                    component: ".campaign-reservation.json".into(),
                    flags: super::MACOS_CREATE_FLAGS,
                    mode: 0o600,
                },
                created_reply!(super::posix_red::LEAF_FD, 42),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    mode: 0o600,
                    size: 0,
                    ..root_stat().with_inode("9202")
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::VolumeUuid("00112233445566778899aabbccddeeff".into()),
            ),
            ScriptedCall::ok(
                Syscall::FGetPath {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Path(
                    "/Volumes/r1/staging/candidate-01/campaign-0001/.campaign-reservation.json"
                        .into(),
                ),
            ),
            ScriptedCall::ok(
                Syscall::Getfsstat,
                Reply::MountTable(vec![super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                )]),
            ),
        ]);
        calls
    }

    #[test]
    fn adoption_requires_fstat_fstatfs_volume_uuid_getfsstat_and_fgetpath() {
        let expected = identity();
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(adopt_calls(&expected)));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected.clone())
            .expect("matching APFS root");
        root.assert_provenance_bound_to(INHERITED_ROOT_FD, PINNED_ROOT_FD, &expected);
        fs.assert_script_exhausted();
    }

    #[test]
    fn missing_or_mismatched_volume_uuid_is_not_a_trusted_root() {
        for volume_reply in [
            Reply::VolumeUuid("ffeeddccbbaa99887766554433221100".into()),
            Reply::VolumeUuid(String::new()),
        ] {
            let expected = identity();
            let mut calls = adopt_calls(&expected);
            calls[5] = ScriptedCall::ok(
                Syscall::FgetattrlistVolumeUuid { fd: PINNED_ROOT_FD },
                volume_reply,
            );
            calls.truncate(6);
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: PINNED_ROOT_FD },
                Reply::Unit,
            ));
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            assert_code(
                fs.adopt_staging(INHERITED_ROOT_FD, expected),
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            );
            fs.assert_script_exhausted();
        }

        let expected = identity();
        let mut calls = adopt_calls(&expected);
        calls[5] = ScriptedCall::error(
            Syscall::FgetattrlistVolumeUuid { fd: PINNED_ROOT_FD },
            Errno::NoData,
        );
        calls.truncate(6);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn mac_filesystem_matrix_allows_only_local_apfs() {
        let expected = identity();
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(adopt_calls(&expected)));
        fs.adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("local APFS is the only approved macOS root");
        fs.assert_script_exhausted();

        for file_system_type in [
            "hfs", "hfs+", "tmpfs", "nfs", "smbfs", "devfs", "fuse", "unknown",
        ] {
            let expected = identity();
            let mut observed = expected.clone();
            if let DirectoryIdentity::Macos(ref mut macos) = observed {
                macos.file_system_type = file_system_type.into();
            }
            let mut calls = adopt_calls(&observed);
            calls.truncate(4); // fstatfs is the first class/identity gate
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: PINNED_ROOT_FD },
                Reply::Unit,
            ));
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            assert_code(
                fs.adopt_staging(INHERITED_ROOT_FD, expected),
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn duplicate_or_nested_getfsstat_matches_fail_closed() {
        for table in [
            vec![
                super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                ),
                super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                ),
            ],
            vec![
                super::secure_fs::MountTableEntry::apfs(
                    "00112233445566778899aabbccddeeff",
                    "/Volumes/r1",
                    "1234",
                    "5678",
                ),
                super::secure_fs::MountTableEntry::apfs(
                    "ffeeddccbbaa99887766554433221100",
                    "/Volumes/r1/staging/nested",
                    "1234",
                    "5678",
                ),
            ],
        ] {
            let expected = identity();
            let mut calls = adopt_calls(&expected);
            calls[7] = ScriptedCall::ok(Syscall::Getfsstat, Reply::MountTable(table));
            calls.push(ScriptedCall::ok(
                Syscall::Close { fd: PINNED_ROOT_FD },
                Reply::Unit,
            ));
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            assert_code(
                fs.adopt_staging(INHERITED_ROOT_FD, expected),
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn descriptor_path_must_be_the_canonical_mount_relative_path() {
        let expected = identity();
        let mut calls = adopt_calls(&expected);
        calls[6] = ScriptedCall::ok(
            Syscall::FGetPath { fd: PINNED_ROOT_FD },
            Reply::Path("/private/var/folders/alias".into()),
        );
        calls.truncate(7);
        calls.push(ScriptedCall::ok(
            Syscall::Close { fd: PINNED_ROOT_FD },
            Reply::Unit,
        ));
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        assert_code(
            fs.adopt_staging(INHERITED_ROOT_FD, expected),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn mac_root_owner_type_link_and_mode_variants_are_rejected_before_fstatfs() {
        for variant in [
            FileIdentity {
                kind: FileKind::Regular,
                size: 0,
                ..root_stat()
            },
            FileIdentity {
                owner_uid: 502,
                size: 0,
                ..root_stat()
            },
            FileIdentity {
                hard_link_count: "2".into(),
                size: 0,
                ..root_stat()
            },
            FileIdentity {
                mode: 0o777,
                size: 0,
                ..root_stat()
            },
        ] {
            let expected = identity();
            let calls = vec![
                ScriptedCall::ok(
                    Syscall::Dup {
                        fd: INHERITED_ROOT_FD,
                    },
                    Reply::Fd(PINNED_ROOT_FD),
                ),
                ScriptedCall::ok(
                    Syscall::FcntlGetFd { fd: PINNED_ROOT_FD },
                    Reply::CloseOnExec,
                ),
                ScriptedCall::ok(
                    Syscall::FcntlGetFl { fd: PINNED_ROOT_FD },
                    Reply::Flags(super::READ_ONLY_ACCESS_MODE),
                ),
                ScriptedCall::ok(
                    Syscall::Fstat { fd: PINNED_ROOT_FD },
                    Reply::FileIdentity(variant),
                ),
                ScriptedCall::ok(Syscall::Close { fd: PINNED_ROOT_FD }, Reply::Unit),
            ];
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            assert_code(
                fs.adopt_staging(INHERITED_ROOT_FD, expected),
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn mac_intermediate_reopen_uses_no_follow_open_and_rechecks_identity() {
        let expected = identity();
        let mut calls = adopt_calls(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                },
                Reply::FileIdentity(FileIdentity {
                    inode: "9001".into(),
                    kind: FileKind::Directory,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(LEAF_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(FileIdentity {
                    inode: "9002".into(),
                    kind: FileKind::Directory,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.ensure_directory(&[component("nested")]),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn mac_reopened_intermediate_retains_fstatfs_identity_before_success() {
        let expected = identity();
        let mut calls = adopt_calls(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                },
                Reply::FileIdentity(FileIdentity {
                    inode: "9100".into(),
                    kind: FileKind::Directory,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "nested".into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(LEAF_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(FileIdentity {
                    inode: "9100".into(),
                    kind: FileKind::Directory,
                    size: 0,
                    ..root_stat()
                }),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs { fd: LEAF_FD },
                Reply::DirectoryIdentity(expected),
            ),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity())
            .expect("root adoption");
        root.ensure_directory(&[component("nested")])
            .expect("intermediate directory");
        fs.assert_script_exhausted();
    }

    #[test]
    fn mac_intermediate_owner_mode_type_and_link_variants_fail_after_no_follow_stat() {
        for (variant, expected_code) in [
            (
                FileIdentity {
                    kind: FileKind::Regular,
                    size: 0,
                    ..root_stat()
                },
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            ),
            (
                FileIdentity {
                    owner_uid: 502,
                    size: 0,
                    ..root_stat()
                },
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            ),
            (
                FileIdentity {
                    mode: 0o777,
                    size: 0,
                    ..root_stat()
                },
                "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
            ),
            (
                FileIdentity {
                    hard_link_count: "2".into(),
                    size: 0,
                    ..root_stat()
                },
                "OUTPUT_PATH_HARDLINK",
            ),
        ] {
            let expected = identity();
            let mut calls = adopt_calls(&expected);
            calls.extend([
                ScriptedCall::ok(
                    Syscall::Mkdirat {
                        dirfd: PINNED_ROOT_FD,
                        component: "intermediate-variant".into(),
                        mode: 0o700,
                    },
                    Reply::Unit,
                ),
                // macOS deliberately observes the just-created child before
                // reopening it; no pathname-open can race ahead of this call.
                ScriptedCall::ok(
                    Syscall::FstatatNoFollow {
                        dirfd: PINNED_ROOT_FD,
                        component: "intermediate-variant".into(),
                    },
                    Reply::FileIdentity(variant),
                ),
            ]);
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected)
                .expect("root adoption");
            assert_code(
                root.ensure_directory(&[component("intermediate-variant")]),
                expected_code,
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn mac_campaign_reservation_is_canonical_single_use_and_crash_nonresumable() {
        const CANDIDATE: &str = "candidate-01";
        const CAMPAIGN_1: &str = "campaign-0001";
        const CAMPAIGN_2: &str = "campaign-0002";
        const RESERVATION_1: &[u8] = br#"{"campaignId":"campaign-0001","campaignIdentity":{"canonicalDescriptorPathSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","device":"16777234","fileSystemType":"apfs","fsidWord0":"1234","fsidWord1":"5678","hardLinkCount":"1","inode":"9200","mode":448,"mountTableEntrySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ownerUid":501,"platform":"darwin","volumeUuid":"00112233445566778899aabbccddeeff"},"candidate":"candidate-01","createdAt":"2026-08-24T00:00:00Z","schema":"campaign-reservation/v1","state":"RESERVED","supervisorInstanceNonce":"nonce-0001"}
"#;
        const RESERVATION_2: &[u8] = br#"{"campaignId":"campaign-0002","campaignIdentity":{"canonicalDescriptorPathSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","device":"16777234","fileSystemType":"apfs","fsidWord0":"1234","fsidWord1":"5678","hardLinkCount":"1","inode":"9201","mode":448,"mountTableEntrySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ownerUid":501,"platform":"darwin","volumeUuid":"00112233445566778899aabbccddeeff"},"candidate":"candidate-01","createdAt":"2026-08-24T00:00:01Z","schema":"campaign-reservation/v1","state":"RESERVED","supervisorInstanceNonce":"nonce-0002"}
"#;

        assert_eq!(RESERVATION_1.last(), Some(&b'\n'));
        assert_eq!(RESERVATION_2.last(), Some(&b'\n'));
        assert!(!RESERVATION_1[..RESERVATION_1.len() - 1].contains(&b'\n'));
        assert!(!RESERVATION_2[..RESERVATION_2.len() - 1].contains(&b'\n'));
        let expected = identity();
        let mut candidate = expected.clone();
        candidate.set_inode("9101");
        let mut campaign_1 = expected.clone();
        campaign_1.set_inode("9200");
        let mut campaign_2 = expected.clone();
        campaign_2.set_inode("9201");
        let mut calls = adopt_calls(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: CANDIDATE.into(),
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Directory,
                    size: 0,
                    ..root_stat().with_inode("9101")
                }),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: CANDIDATE.into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(super::posix_red::PARENT_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Directory,
                    size: 0,
                    ..root_stat().with_inode("9101")
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::DirectoryIdentity(candidate.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_1.into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_1.into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9200")),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_1.into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(super::posix_red::CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::FileIdentity(root_stat().with_inode("9200")),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::DirectoryIdentity(campaign_1.clone()),
            ),
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::CHILD_FD,
                    component: ".campaign-reservation.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::CHILD_FD,
                    component: ".campaign-reservation.json".into(),
                    flags: super::MACOS_CREATE_FLAGS,
                    mode: 0o600,
                },
                created_reply!(super::posix_red::LEAF_FD, 31),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    mode: 0o600,
                    size: 0,
                    ..root_stat().with_inode("9202")
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: super::posix_red::LEAF_FD,
                    bytes: RESERVATION_1.to_vec(),
                },
                Reply::Written(RESERVATION_1.len()),
            ),
            ScriptedCall::ok(
                Syscall::Fdatasync {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Fsync {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Fsync {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(Syscall::Fsync { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Unit,
            ),
            // A partial final-name file is closed but never resumed.
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::CHILD_FD,
                    component: "partial-final.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::CHILD_FD,
                    component: "partial-final.json".into(),
                    flags: super::MACOS_CREATE_FLAGS,
                    mode: 0o600,
                },
                created_reply!(super::posix_red::LEAF_FD, 32),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    mode: 0o600,
                    size: 0,
                    ..root_stat().with_inode("9203")
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::DirectoryIdentity(expected.clone()),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: super::posix_red::LEAF_FD,
                    bytes: b"partial-final".to_vec(),
                },
                Reply::Written(13),
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::error(
                Syscall::Mkdirat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_1.into(),
                    mode: 0o700,
                },
                Errno::Exist,
            ),
            ScriptedCall::ok(
                Syscall::Mkdirat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_2.into(),
                    mode: 0o700,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_2.into(),
                },
                Reply::FileIdentity(root_stat().with_inode("9201")),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::PARENT_FD,
                    component: CAMPAIGN_2.into(),
                    flags: super::MACOS_DIRECTORY_FLAGS,
                    mode: 0,
                },
                Reply::Fd(super::posix_red::CHILD_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::FileIdentity(root_stat().with_inode("9201")),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::DirectoryIdentity(campaign_2.clone()),
            ),
            ScriptedCall::error(
                Syscall::FstatatNoFollow {
                    dirfd: super::posix_red::CHILD_FD,
                    component: ".campaign-reservation.json".into(),
                },
                Errno::NoEntry,
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: super::posix_red::CHILD_FD,
                    component: ".campaign-reservation.json".into(),
                    flags: super::MACOS_CREATE_FLAGS,
                    mode: 0o600,
                },
                created_reply!(super::posix_red::LEAF_FD, 33),
            ),
            ScriptedCall::ok(
                Syscall::Fstat {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    mode: 0o600,
                    size: 0,
                    ..root_stat().with_inode("9204")
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Flags(super::WRITER_ACCESS_MODE),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFd {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::CloseOnExec,
            ),
            ScriptedCall::ok(
                Syscall::Fstatfs {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::DirectoryIdentity(expected),
            ),
            ScriptedCall::ok(
                Syscall::Write {
                    fd: super::posix_red::LEAF_FD,
                    bytes: RESERVATION_2.to_vec(),
                },
                Reply::Written(RESERVATION_2.len()),
            ),
            ScriptedCall::ok(
                Syscall::Fdatasync {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Fsync {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Fsync {
                    fd: super::posix_red::PARENT_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(Syscall::Fsync { fd: PINNED_ROOT_FD }, Reply::Unit),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::LEAF_FD,
                },
                Reply::Unit,
            ),
            ScriptedCall::ok(
                Syscall::Close {
                    fd: super::posix_red::CHILD_FD,
                },
                Reply::Unit,
            ),
        ]);
        let context =
            super::secure_fs::test_support::DeterministicReservationContext::for_campaigns(
                "supervisor-instance-01",
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                [
                    ("campaign-0001", "nonce-0001", "2026-08-24T00:00:00Z"),
                    ("campaign-0002", "nonce-0002", "2026-08-24T00:00:01Z"),
                ],
            );
        let mut fs = SecureFs::with_syscalls_and_context(ScriptedSyscalls::new(calls), context);
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, identity())
            .expect("root adoption");
        let campaign = root
            .create_campaign_exclusive(CANDIDATE, CAMPAIGN_1)
            .expect("Mac reservation");
        let (mut partial, _) = campaign
            .create_file_stream_exclusive(&[component("partial-final.json")], 64)
            .expect("partial final");
        partial
            .write_chunk(b"partial-final")
            .expect("partial write");
        drop(partial);
        campaign.close().expect("crash cleanup closes child handle");
        assert_code(
            root.create_campaign_exclusive(CANDIDATE, CAMPAIGN_1),
            "OUTPUT_CAMPAIGN_EXISTS",
        );
        let next = root
            .create_campaign_exclusive(CANDIDATE, CAMPAIGN_2)
            .expect("fresh campaign ID");
        campaign.assert_reservation_bytes(RESERVATION_1);
        campaign.assert_reservation_sha256(
            "42d25530c44bfdbf104886694979afa7c5ce383f9ec7839e9394d2b2dad16d27",
        );
        campaign.assert_candidate(CANDIDATE);
        campaign.assert_campaign_id(CAMPAIGN_1);
        campaign.assert_campaign_identity_schema("MacosDirectoryIdentityV1");
        campaign.assert_creation_ledger(1, true);
        campaign.assert_directory_identity(&campaign_1);
        campaign.assert_instance_nonce("nonce-0001");
        campaign.assert_state_reserved_at("2026-08-24T00:00:00Z");
        next.assert_reservation_bytes(RESERVATION_2);
        next.assert_reservation_sha256(
            "899a1e33cd8674a345244786f6bc674c8306d8132d44b30fe15eb13427267322",
        );
        next.assert_candidate(CANDIDATE);
        next.assert_campaign_id(CAMPAIGN_2);
        next.assert_campaign_identity_schema("MacosDirectoryIdentityV1");
        next.assert_creation_ledger(1, true);
        next.assert_directory_identity(&campaign_2);
        next.assert_instance_nonce("nonce-0002");
        next.assert_state_reserved_at("2026-08-24T00:00:01Z");
        next.close().expect("new campaign closes deterministically");
        fs.assert_script_exhausted();
    }

    #[test]
    fn mac_sealed_executable_launch_completes_exclusive_sync_chmod_rehash_and_pinned_spawn() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "16777234".into(),
            inode: "7001".into(),
            mount_id: None,
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let context = launch_context(&executable);
        let receipt = launch_receipt(&context, &executable);
        let calls = mac_launch_calls(
            &expected,
            &executable,
            &context,
            &receipt,
            MacLaunchFault::None,
        );
        // The active queue above is the sole Mac launch ceremony. Source
        // descriptor read/hash/close, exclusive copy, durability, sealing,
        // re-open, rehash, identity checks, and pinned spawn are shared by
        // positive, replacement, and every fault lane.
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected.clone())
            .expect("root adoption");
        let launch = root
            .spawn_sealed_executable_from_approved_source(
                SOURCE_EXEC_FD,
                EXEC_FD,
                &executable,
                &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            )
            .expect("descriptor-bound pinned relative launch");
        launch.assert_receipt(&receipt);
        launch.assert_receipt_schema("bun-role-launch-receipt/v1");
        launch.assert_host_id("darwin-arm64");
        launch.assert_run_id("run-0001");
        launch.assert_execution_identity(0, "resident", 0);
        launch.assert_bun_sha256(EXECUTABLE_SHA256);
        launch.assert_role_entrypoint_sha256(ROLE_SHA256);
        launch.assert_addon_sha256(ADDON_SHA256);
        launch.assert_descriptor_map_sha256(&context.descriptor_map_sha256);
        launch.assert_exact_argv(&["bun", "--no-install", "--no-env-file", "/dev/fd/202"]);
        launch.assert_exact_environment(&[
            "LC_ALL=C",
            "WT_COMPARISON_PROTOCOL_IN_FD=205",
            "WT_COMPARISON_PROTOCOL_OUT_FD=206",
            "WT_COMPARISON_STARTUP_NONCE_FD=207",
            "WT_COMPARISON_STRICT_ADDON_FD=203",
        ]);
        launch.assert_launch_primitive("macos-sealed-relative-posix-spawn");
        launch.assert_startup_digest_sha256(&context.startup_digest_sha256);
        launch.assert_startup_nonce_sha256(&context.startup_nonce_sha256);
        launch.assert_addon_requested_specifier("/dev/fd/203");
        launch.assert_addon_load_attempt_count(1);
        launch.assert_addon_loaded_sha256(ADDON_SHA256);
        launch.assert_no_addon_fallback_candidates();
        launch.assert_socket_before_startup_handshake(false);
        launch.assert_descriptor_kind("executable", "executable");
        launch.assert_descriptor_identity_sha256("roleFd", ROLE_IDENTITY_SHA256);
        launch.assert_source_descriptor_sha256(SOURCE_EXEC_FD, EXECUTABLE_SHA256);
        launch.assert_destination_descriptor_sha256(EXEC_FD, EXECUTABLE_SHA256);
        launch.assert_source_closed_before_destination_open(SOURCE_EXEC_FD, EXEC_FD);
        launch.assert_role_descriptor_consumed_to_eof(ROLE_FD, ROLE_SHA256);
        launch.assert_addon_descriptor_consumed_to_eof(ADDON_FD, ADDON_SHA256);
        fs.assert_script_exhausted();

        // A replacement observed at the descriptor boundary fails before
        // any spawn, loader, or pathname fallback.
        let context = launch_context(&executable);
        let receipt = launch_receipt(&context, &executable);
        let calls = mac_launch_calls(
            &expected,
            &executable,
            &context,
            &receipt,
            MacLaunchFault::IdentityReplaced,
        );
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.spawn_sealed_executable_from_approved_source(
                SOURCE_EXEC_FD,
                EXEC_FD,
                &executable,
                &["bun", "--no-install", "--no-env-file", "/dev/fd/202"],
                &[
                    ("LC_ALL", "C"),
                    ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
                    ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
                    ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
                    ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
                ],
                &context,
            ),
            "OUTPUT_EXEC_REPLACED",
        );
        fs.assert_script_exhausted();
    }

    #[test]
    fn mac_route_and_ifconfig_use_distinct_sealed_launch_ceremonies() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "16777234".into(),
            inode: "7001".into(),
            mount_id: None,
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        for (component_name, leaf_name, argv) in [
            (
                "exec-private-route-01",
                "route",
                vec!["route", "-n", "get", "10.99.0.2"],
            ),
            (
                "exec-private-ifconfig-01",
                "ifconfig",
                vec!["ifconfig", "en8"],
            ),
        ] {
            let context = launch_context(&executable);
            let argv_owned: Vec<String> = argv.iter().map(|value| (*value).into()).collect();
            let calls = mac_launch_calls_for(
                &expected,
                &executable,
                &context,
                MacLaunchFault::None,
                component_name,
                leaf_name,
                argv_owned,
                vec![("LC_ALL".into(), "C".into())],
            );
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                .expect("root adoption");
            let argv_refs: Vec<&str> = argv.to_vec();
            let launch = root
                .spawn_sealed_tool_from_approved_source(
                    SOURCE_EXEC_FD,
                    EXEC_FD,
                    &executable,
                    &argv_refs,
                    &[("LC_ALL", "C")],
                    &context,
                )
                .expect("sealed observation-tool launch");
            launch.assert_exact_argv(&argv_refs);
            launch.assert_exact_environment(&["LC_ALL=C"]);
            launch.assert_launch_primitive("macos-sealed-relative-posix-spawn");
            launch.assert_socket_before_startup_handshake(false);
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn mac_sealed_launch_boundary_faults_are_typed_and_fail_closed() {
        let expected = identity();
        let executable = FileIdentity {
            kind: FileKind::Regular,
            device: "16777234".into(),
            inode: "7001".into(),
            mount_id: None,
            fsid_word0: "1234".into(),
            fsid_word1: "5678".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: EXECUTABLE_BYTES.len() as u64,
        };
        let argv = ["bun", "--no-install", "--no-env-file", "/dev/fd/202"];
        let env = [
            ("LC_ALL", "C"),
            ("WT_COMPARISON_PROTOCOL_IN_FD", "205"),
            ("WT_COMPARISON_PROTOCOL_OUT_FD", "206"),
            ("WT_COMPARISON_STARTUP_NONCE_FD", "207"),
            ("WT_COMPARISON_STRICT_ADDON_FD", "/dev/fd/203"),
        ];

        // EINTR plus two exact byte ranges is a successful retry path, not an
        // error. It uses the same ceremony and receipt as the positive lane.
        let context = launch_context(&executable);
        let receipt = launch_receipt(&context, &executable);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(mac_launch_calls(
            &expected,
            &executable,
            &context,
            &receipt,
            MacLaunchFault::WriteEintrShort,
        )));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected.clone())
            .expect("root adoption");
        let launch = root
            .spawn_sealed_executable_from_approved_source(
                SOURCE_EXEC_FD,
                EXEC_FD,
                &executable,
                &argv,
                &env,
                &context,
            )
            .expect("EINTR/short executable write eventually succeeds");
        launch.assert_source_descriptor_sha256(SOURCE_EXEC_FD, EXECUTABLE_SHA256);
        launch.assert_destination_descriptor_sha256(EXEC_FD, EXECUTABLE_SHA256);
        fs.assert_script_exhausted();

        for (fault, expected_code) in [
            (MacLaunchFault::WriteEnospc, "OUTPUT_WRITE_FAILED"),
            (MacLaunchFault::WriteQuota, "OUTPUT_WRITE_FAILED"),
            (MacLaunchFault::WritePermission, "OUTPUT_WRITE_FAILED"),
            (MacLaunchFault::LeafChmod, "OUTPUT_EXEC_HANDLE_UNAVAILABLE"),
            (
                MacLaunchFault::DirectoryChmod,
                "OUTPUT_EXEC_HANDLE_UNAVAILABLE",
            ),
            (MacLaunchFault::LeafSync, "OUTPUT_EXEC_HANDLE_UNAVAILABLE"),
            (MacLaunchFault::ParentSync, "OUTPUT_EXEC_HANDLE_UNAVAILABLE"),
            (MacLaunchFault::RootSync, "OUTPUT_EXEC_HANDLE_UNAVAILABLE"),
            (MacLaunchFault::RehashDigest, "OUTPUT_EXEC_DIGEST_MISMATCH"),
            (MacLaunchFault::IdentityReplaced, "OUTPUT_EXEC_REPLACED"),
            (
                MacLaunchFault::ExecutableCloexec,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (
                MacLaunchFault::ExecutableAccessMode,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (MacLaunchFault::StartupCloexec, "OUTPUT_EXEC_HANDLE_INVALID"),
            (
                MacLaunchFault::StartupAccessMode,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (MacLaunchFault::RoleCloexec, "OUTPUT_EXEC_HANDLE_INVALID"),
            (MacLaunchFault::RoleAccessMode, "OUTPUT_EXEC_HANDLE_INVALID"),
            (MacLaunchFault::AddonCloexec, "OUTPUT_EXEC_HANDLE_INVALID"),
            (
                MacLaunchFault::AddonAccessMode,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (
                MacLaunchFault::ProtocolInCloexec,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (
                MacLaunchFault::ProtocolInAccessMode,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (
                MacLaunchFault::ProtocolOutCloexec,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (
                MacLaunchFault::ProtocolOutAccessMode,
                "OUTPUT_EXEC_HANDLE_INVALID",
            ),
            (MacLaunchFault::RoleTrailing, "OUTPUT_EXEC_DIGEST_MISMATCH"),
            (MacLaunchFault::RolePremature, "OUTPUT_EXEC_DIGEST_MISMATCH"),
            (MacLaunchFault::AddonTrailing, "OUTPUT_EXEC_DIGEST_MISMATCH"),
            (
                MacLaunchFault::AddonPremature,
                "OUTPUT_EXEC_DIGEST_MISMATCH",
            ),
            (MacLaunchFault::Spawn, "OUTPUT_EXEC_FAILED"),
        ] {
            let context = launch_context(&executable);
            let receipt = launch_receipt(&context, &executable);
            let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(mac_launch_calls(
                &expected,
                &executable,
                &context,
                &receipt,
                fault,
            )));
            let root = fs
                .adopt_staging(INHERITED_ROOT_FD, expected.clone())
                .expect("root adoption");
            assert_code(
                root.spawn_sealed_executable_from_approved_source(
                    SOURCE_EXEC_FD,
                    EXEC_FD,
                    &executable,
                    &argv,
                    &env,
                    &context,
                ),
                expected_code,
            );
            fs.assert_script_exhausted();
        }
    }

    #[test]
    fn mac_fstatfs_identity_is_required_for_every_opened_component() {
        let expected = identity();
        let mut calls = adopt_calls(&expected);
        calls.extend([
            ScriptedCall::ok(
                Syscall::FstatatNoFollow {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    device: "16777234".into(),
                    inode: "9100".into(),
                    mount_id: None,
                    fsid_word0: "1234".into(),
                    fsid_word1: "5678".into(),
                    owner_uid: 501,
                    mode: 0o600,
                    hard_link_count: "1".into(),
                    size: 0,
                }),
            ),
            ScriptedCall::ok(
                Syscall::Openat {
                    dirfd: PINNED_ROOT_FD,
                    component: "manifest.json".into(),
                    flags: super::MACOS_READ_FLAGS,
                    mode: 0,
                },
                Reply::Fd(LEAF_FD),
            ),
            ScriptedCall::ok(
                Syscall::Fstat { fd: LEAF_FD },
                Reply::FileIdentity(FileIdentity {
                    kind: FileKind::Regular,
                    device: "16777234".into(),
                    inode: "9100".into(),
                    mount_id: None,
                    fsid_word0: "1234".into(),
                    fsid_word1: "5678".into(),
                    owner_uid: 501,
                    mode: 0o600,
                    hard_link_count: "1".into(),
                    size: 0,
                }),
            ),
            ScriptedCall::ok(
                Syscall::FcntlGetFl { fd: LEAF_FD },
                Reply::Flags(super::READ_ONLY_ACCESS_MODE),
            ),
            ScriptedCall::ok(Syscall::FcntlGetFd { fd: LEAF_FD }, Reply::CloseOnExec),
            ScriptedCall::error(Syscall::Fstatfs { fd: LEAF_FD }, Errno::NoData),
            ScriptedCall::ok(Syscall::Close { fd: LEAF_FD }, Reply::Unit),
        ]);
        let mut fs = SecureFs::with_syscalls(ScriptedSyscalls::new(calls));
        let root = fs
            .adopt_staging(INHERITED_ROOT_FD, expected)
            .expect("root adoption");
        assert_code(
            root.open_read_stream(&[component("manifest.json")], 1024),
            "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH",
        );
        fs.assert_script_exhausted();
    }

    define_mac_campaign_reservation_faults_test!();
}

#[cfg(target_os = "windows")]
mod windows_red {
    //! The Windows check is intentionally an integration-process test.  The
    //! `webtransport_test_seams` feature is reserved for the POSIX scripted
    //! syscall seam above; it must not expose a platform-gate helper or any
    //! loader spies from production.  This test instead starts the real
    //! `comparison-supervisor` Cargo binary and therefore proves the
    //! `#[cfg(windows)]` entrypoint stub before argument/environment/path,
    //! descriptor, addon-loader, or child-spawn access.
    //!
    //! The `CARGO_BIN_EXE_comparison-supervisor` variable is supplied by Cargo
    //! once the approved binary target is added.  Until then, a Windows RED
    //! compile is deliberately blocked at this exact integration surface; no
    //! test-local replacement binary or production visibility is permitted.

    use std::process::Command;

    #[test]
    fn windows_same_process_main_zero_io_stub_is_the_first_gate() {
        const EXPECTED_STDERR: &[u8] =
            br#"{"code":"OUTPUT_PLATFORM_UNSUPPORTED","schema":"comparison-supervisor-error/v1"}
"#;
        let probes = super::secure_fs::test_support::WindowsProcessStartProbes::new();
        // This invokes the same process-start entrypoint used by the real
        // comparison-supervisor main, with only its internal probe seam
        // supplied.  The platform gate is the first executable branch,
        // before argument/env/path/descriptor, loader, or child-process
        // services are constructed; this is not a model-only equivalent.
        let result =
            super::secure_fs::test_support::comparison_supervisor_process_start_with_probes(
                &[
                    "resident-mac",
                    r"C:\definitely-not-opened\authority.bin",
                    r"\\server\share\never-opened",
                ],
                &[
                    ("R1_ARG_SPY", r"C:\definitely-not-opened\arg-spy"),
                    ("R1_ENV_SPY", r"C:\definitely-not-opened\env-spy"),
                    ("PATH", r"C:\definitely-not-opened\bin"),
                ],
                &probes,
            );
        assert_eq!(result.status_code(), 69);
        assert_eq!(result.stdout(), b"");
        assert_eq!(result.stderr(), EXPECTED_STDERR);
        assert_eq!(probes.events(), &["platform-stub"]);
        assert!(probes.saw_no_argument_read());
        assert!(probes.saw_no_environment_read());
        assert!(probes.saw_no_path_open());
        assert!(probes.saw_no_descriptor_access());
        assert!(probes.saw_no_loader_access());
        assert!(probes.saw_no_spawn());
    }

    #[test]
    fn comparison_supervisor_process_start_is_unsupported_before_any_io() {
        const EXPECTED_STDERR: &[u8] =
            br#"{"code":"OUTPUT_PLATFORM_UNSUPPORTED","schema":"comparison-supervisor-error/v1"}
"#;
        let output = Command::new(env!("CARGO_BIN_EXE_comparison-supervisor"))
            .env_clear()
            // These values are intentionally hostile/unusable.  A platform
            // stub that parses arguments, reads the environment, or resolves
            // a path before rejecting Windows official I/O would touch them.
            .args([
                "resident-mac",
                r"C:\definitely-not-opened\authority.bin",
                r"\\server\share\never-opened",
            ])
            .env("R1_ARG_SPY", r"C:\definitely-not-opened\arg-spy")
            .env("R1_ENV_SPY", r"C:\definitely-not-opened\env-spy")
            .env("R1_PATH_SPY", r"C:\definitely-not-opened\path-spy")
            .env(
                "R1_DESCRIPTOR_SPY",
                r"C:\definitely-not-opened\descriptor-spy",
            )
            .env("R1_LOADER_SPY", r"C:\definitely-not-opened\loader-spy")
            .env("R1_SPAWN_SPY", r"C:\definitely-not-opened\spawn-spy")
            .env("R1_AUTHORITY", r"C:\definitely-not-opened\authority.bin")
            .env("PATH", r"C:\definitely-not-opened\bin")
            .output()
            .expect("Cargo must provide the comparison-supervisor binary");

        assert_eq!(output.status.code(), Some(69));
        assert_eq!(
            output.stdout, b"",
            "unsupported platform must not emit stdout"
        );
        assert_eq!(output.stderr, EXPECTED_STDERR);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod observation_red {
    //! Sealed supervisor-owned topology observation and command-runner RED
    //! contracts.  These calls are intentionally not socket fixtures: the
    //! eventual implementation must inject this exact queue into the
    //! supervisor before any child can observe or author a trust receipt.

    use super::secure_fs::test_support::{
        ApprovedToolDescriptor, CommandReply, CommandScriptCall, ObservationReply,
        ObservationScriptCall, SupervisorCommandRunner, SupervisorObservationSyscalls,
    };

    const OBSERVER_FD: i32 = 501;
    const UDP_FD: i32 = 502;
    const SERVER_PGID: i32 = 7001;
    const SERVER_SOCKET_INODE: u64 = 88001;
    const IFINDEX: u32 = 7;
    // Tool identities are hashes of the frozen, ordered descriptor tuples
    // (platform, tool, approved executable, operation, target, interface,
    // and inherited descriptor number), not placeholder sentinels.
    const LINUX_IP_ROUTE_IDENTITY_SHA256: &str =
        "0cf063c64803b184ce4e5a1caf26448be3acaea3e40ed469b121d15f7dab0410";
    const LINUX_IP_ADDRESS_IDENTITY_SHA256: &str =
        "53dc4475e2d925dc17265228e85d8b21fdb1ff33b2c71125d03e2a4f96d691c5";
    const LINUX_TC_QDISC_IDENTITY_SHA256: &str =
        "e31d8f7490bf41a27dd3cdd13f9a8120dc011db8f70ea96c3c04959c8d1b75b4";
    const LINUX_IP_COMMAND_IDENTITY_SHA256: &str =
        "f3561a0cbbda906711effaf120d09f36037a78fedb5df786a16aa5d5dde33ed6";
    const MAC_ROUTE_IDENTITY_SHA256: &str =
        "b3bbed077996fc90871be5cb11c46fae46fdd4be9ca0f69369f561733296393f";
    const MAC_IFCONFIG_IDENTITY_SHA256: &str =
        "11adf4264792f68617d9c713510eec91b8a8eae77924a5877fd6f02a18cf0a1b";

    #[cfg(target_os = "linux")]
    #[test]
    fn sealed_observation_covers_interface_route_packet_peer_and_cleanup_ownership() {
        let mut observation = SupervisorObservationSyscalls::scripted([
            ObservationScriptCall::IfNameToIndex {
                interface: "eno1".into(),
            }
            .reply(ObservationReply::InterfaceIndex(IFINDEX)),
            ObservationScriptCall::Siocgifmtu {
                interface: "eno1".into(),
            }
            .reply(ObservationReply::Mtu(1500)),
            ObservationScriptCall::UdpConnect {
                fd: UDP_FD,
                destination: "10.99.0.1:443".into(),
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::UdpGetsockname { fd: UDP_FD }
                .reply(ObservationReply::SocketAddress("10.99.0.2:40211".into())),
            ObservationScriptCall::AfPacketBind {
                fd: OBSERVER_FD,
                ifindex: IFINDEX,
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::AfPacketFilter {
                fd: OBSERVER_FD,
                source: "10.99.0.2".into(),
                destination: "10.99.0.1".into(),
                port: 443,
                protocol: "udp".into(),
                snap_length: 128,
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::AfPacketTimestamp { fd: OBSERVER_FD }
                .reply(ObservationReply::Timestamping("kernel".into())),
            ObservationScriptCall::AfPacketDropCounters { fd: OBSERVER_FD }.reply(
                ObservationReply::DropCounters {
                    captured: 2,
                    dropped: 0,
                },
            ),
            ObservationScriptCall::PacketReceipt {
                fd: OBSERVER_FD,
                direction: "outbound".into(),
            }
            .reply(ObservationReply::PacketReceipt {
                direction: "outbound".into(),
                packets: 2,
                bytes: 256,
                source: "10.99.0.2:40211".into(),
                destination: "10.99.0.1:443".into(),
                cardinality: 1,
            }),
            ObservationScriptCall::PacketReceipt {
                fd: OBSERVER_FD,
                direction: "inbound".into(),
            }
            .reply(ObservationReply::PacketReceipt {
                direction: "inbound".into(),
                packets: 2,
                bytes: 256,
                source: "10.99.0.1:443".into(),
                destination: "10.99.0.2:40211".into(),
                cardinality: 1,
            }),
            ObservationScriptCall::NetlinkSockDiag {
                socket_inode: SERVER_SOCKET_INODE,
            }
            .reply(ObservationReply::SocketOwner {
                pgid: SERVER_PGID,
                uid: 501,
            }),
            ObservationScriptCall::ProcessGroupOwnership { pgid: SERVER_PGID }
                .reply(ObservationReply::ProcessOwner { uid: 501 }),
            ObservationScriptCall::SocketOwnership {
                socket_inode: SERVER_SOCKET_INODE,
            }
            .reply(ObservationReply::SocketOwner {
                pgid: SERVER_PGID,
                uid: 501,
            }),
            ObservationScriptCall::QdiscCleanup {
                interface: "eno1".into(),
                expected_before: "fq".into(),
                expected_after: "fq".into(),
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::PgidKillWait { pgid: SERVER_PGID }
                .reply(ObservationReply::WaitStatus { status: 0 }),
            ObservationScriptCall::Close { fd: OBSERVER_FD }.reply(ObservationReply::Unit),
            ObservationScriptCall::Close { fd: UDP_FD }.reply(ObservationReply::Unit),
        ]);

        assert_eq!(
            observation
                .if_nametoindex("eno1")
                .expect("numeric interface index"),
            IFINDEX
        );
        assert_eq!(observation.siocgifmtu("eno1").expect("positive MTU"), 1500);
        observation
            .udp_connect(UDP_FD, "10.99.0.1:443")
            .expect("connect-only route probe emits no packet");
        assert_eq!(
            observation.udp_getsockname(UDP_FD).expect("route source"),
            "10.99.0.2:40211"
        );
        observation
            .af_packet_bind(OBSERVER_FD, IFINDEX)
            .expect("AF_PACKET numeric bind");
        observation
            .af_packet_install_filter(OBSERVER_FD, "10.99.0.2", "10.99.0.1", 443, "udp", 128)
            .expect("narrow packet filter");
        observation
            .af_packet_enable_timestamps(OBSERVER_FD)
            .expect("kernel timestamps");
        let drops = observation
            .af_packet_drop_counters(OBSERVER_FD)
            .expect("drop counters");
        assert_eq!(drops.dropped, 0);
        let packet = observation
            .packet_receipt_direction(OBSERVER_FD, "outbound")
            .expect("positive packet receipt");
        packet.assert_packets(2);
        packet.assert_bytes(256);
        packet.assert_endpoints("10.99.0.2:40211", "10.99.0.1:443");
        packet.assert_cardinality(1);
        let inbound = observation
            .packet_receipt_direction(OBSERVER_FD, "inbound")
            .expect("positive inbound packet receipt");
        inbound.assert_packets(2);
        inbound.assert_bytes(256);
        inbound.assert_endpoints("10.99.0.1:443", "10.99.0.2:40211");
        inbound.assert_cardinality(1);
        assert_eq!(
            observation
                .netlink_sock_diag(SERVER_SOCKET_INODE)
                .expect("NETLINK_SOCK_DIAG ownership"),
            SERVER_PGID
        );
        assert_eq!(
            observation
                .process_group_ownership(SERVER_PGID)
                .expect("server PGID owner"),
            501
        );
        assert_eq!(
            observation
                .socket_ownership(SERVER_SOCKET_INODE)
                .expect("server socket owner"),
            SERVER_PGID
        );
        observation
            .qdisc_cleanup("eno1", "fq", "fq")
            .expect("qdisc restore is part of the receipt");
        observation
            .pgid_kill_wait(SERVER_PGID)
            .expect("owned PGID cleanup");
        observation.close(OBSERVER_FD).expect("packet fd close");
        observation.close(UDP_FD).expect("UDP fd close");
        observation.assert_script_exhausted();

        let mut command = SupervisorCommandRunner::scripted([
            CommandScriptCall::Tool {
                descriptor: ApprovedToolDescriptor {
                    fd: 601,
                    identity_sha256: LINUX_IP_ROUTE_IDENTITY_SHA256.into(),
                    tool: "ip".into(),
                },
                argv: vec![
                    "/usr/sbin/ip".into(),
                    "-j".into(),
                    "route".into(),
                    "get".into(),
                    "10.99.0.1".into(),
                    "from".into(),
                    "10.99.0.2".into(),
                ],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"{\"dev\":\"eno1\"}".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 601 }.reply(CommandReply::Unit),
            CommandScriptCall::Tool {
                descriptor: ApprovedToolDescriptor {
                    fd: 602,
                    identity_sha256: LINUX_IP_ADDRESS_IDENTITY_SHA256.into(),
                    tool: "ip".into(),
                },
                argv: vec![
                    "/usr/sbin/ip".into(),
                    "-j".into(),
                    "address".into(),
                    "show".into(),
                    "dev".into(),
                    "eno1".into(),
                ],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"{\"addr\":\"10.99.0.2\"}".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 602 }.reply(CommandReply::Unit),
            CommandScriptCall::Tool {
                descriptor: ApprovedToolDescriptor {
                    fd: 603,
                    identity_sha256: LINUX_TC_QDISC_IDENTITY_SHA256.into(),
                    tool: "tc".into(),
                },
                argv: vec![
                    "/usr/sbin/tc".into(),
                    "-j".into(),
                    "qdisc".into(),
                    "show".into(),
                    "dev".into(),
                    "eno1".into(),
                ],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"{\"kind\":\"fq\"}".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 603 }.reply(CommandReply::Unit),
        ]);
        for (descriptor, argv) in [
            (
                ApprovedToolDescriptor {
                    fd: 601,
                    identity_sha256: LINUX_IP_ROUTE_IDENTITY_SHA256.into(),
                    tool: "ip".into(),
                },
                vec![
                    "/usr/sbin/ip",
                    "-j",
                    "route",
                    "get",
                    "10.99.0.1",
                    "from",
                    "10.99.0.2",
                ],
            ),
            (
                ApprovedToolDescriptor {
                    fd: 602,
                    identity_sha256: LINUX_IP_ADDRESS_IDENTITY_SHA256.into(),
                    tool: "ip".into(),
                },
                vec!["/usr/sbin/ip", "-j", "address", "show", "dev", "eno1"],
            ),
            (
                ApprovedToolDescriptor {
                    fd: 603,
                    identity_sha256: LINUX_TC_QDISC_IDENTITY_SHA256.into(),
                    tool: "tc".into(),
                },
                vec!["/usr/sbin/tc", "-j", "qdisc", "show", "dev", "eno1"],
            ),
        ] {
            let descriptor_fd = descriptor.fd;
            let receipt = command
                .run_exact(descriptor, &argv, &[("LC_ALL", "C")])
                .expect("approved descriptor, argv, and environment");
            command
                .close(descriptor_fd)
                .expect("approved tool descriptor close");
            if argv
                == [
                    "/usr/sbin/ip",
                    "-j",
                    "route",
                    "get",
                    "10.99.0.1",
                    "from",
                    "10.99.0.2",
                ]
            {
                receipt.assert_stdout_len(14);
                receipt.assert_stdout_sha256(
                    "887f6e17f69a61495bee49dd21be080439f2a57b651c67fbd0bde8adb1b94162",
                );
                receipt.assert_stderr_len(0);
                receipt.assert_stderr_sha256(
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                );
                receipt.assert_duration_ms(12);
                receipt.assert_exit(0);
                receipt.assert_tool_identity("ip", LINUX_IP_ROUTE_IDENTITY_SHA256);
                receipt.assert_supervisor_identity("supervisor-instance-01");
            }
            let (stdout_len, stdout_sha, tool, tool_sha) = match descriptor_fd {
                601 => (
                    14,
                    "887f6e17f69a61495bee49dd21be080439f2a57b651c67fbd0bde8adb1b94162",
                    "ip",
                    LINUX_IP_ROUTE_IDENTITY_SHA256,
                ),
                602 => (
                    20,
                    "6edada8ca622a9b06fd805498e338adab580fe8a77570a1519c1c91a11267428",
                    "ip",
                    LINUX_IP_ADDRESS_IDENTITY_SHA256,
                ),
                603 => (
                    13,
                    "ea38dfb4509ef82905830371ead910bba03af3ea3b2a10c596de9f671373b538",
                    "tc",
                    LINUX_TC_QDISC_IDENTITY_SHA256,
                ),
                _ => unreachable!("all approved Linux command descriptors are enumerated"),
            };
            receipt.assert_stdout_len(stdout_len);
            receipt.assert_stdout_sha256(stdout_sha);
            receipt.assert_stderr_len(0);
            receipt.assert_stderr_sha256(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            );
            receipt.assert_duration_ms(12);
            receipt.assert_exit(0);
            receipt.assert_tool_identity(tool, tool_sha);
            receipt.assert_supervisor_identity("supervisor-instance-01");
        }
        command.assert_script_exhausted();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_sealed_observation_covers_packet_bytes_endpoints_ownership_and_all_closes() {
        const MAC_SOURCE: &str = "10.99.0.1:40211";
        const MAC_DESTINATION: &str = "10.99.0.2:443";
        const PACKETS: u64 = 2;
        const BYTES: u64 = 256;
        const CARDINALITY: u64 = 1;
        let mut observation = SupervisorObservationSyscalls::scripted([
            ObservationScriptCall::IfNameToIndex {
                interface: "en8".into(),
            }
            .reply(ObservationReply::InterfaceIndex(8)),
            ObservationScriptCall::Siocgifmtu {
                interface: "en8".into(),
            }
            .reply(ObservationReply::Mtu(1500)),
            ObservationScriptCall::UdpConnect {
                fd: UDP_FD,
                destination: MAC_DESTINATION.into(),
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::UdpGetsockname { fd: UDP_FD }
                .reply(ObservationReply::SocketAddress(MAC_SOURCE.into())),
            ObservationScriptCall::MacPacketCapture {
                fd: OBSERVER_FD,
                interface: "en8".into(),
                source: "10.99.0.1".into(),
                destination: "10.99.0.2".into(),
                port: 443,
                snap_length: 128,
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::PacketReceipt {
                fd: OBSERVER_FD,
                direction: "outbound".into(),
            }
            .reply(ObservationReply::PacketReceipt {
                direction: "outbound".into(),
                packets: PACKETS,
                bytes: BYTES,
                source: MAC_SOURCE.into(),
                destination: MAC_DESTINATION.into(),
                cardinality: CARDINALITY,
            }),
            ObservationScriptCall::PacketReceipt {
                fd: OBSERVER_FD,
                direction: "inbound".into(),
            }
            .reply(ObservationReply::PacketReceipt {
                direction: "inbound".into(),
                packets: PACKETS,
                bytes: BYTES,
                source: MAC_DESTINATION.into(),
                destination: MAC_SOURCE.into(),
                cardinality: CARDINALITY,
            }),
            ObservationScriptCall::ProcessGroupOwnership { pgid: SERVER_PGID }
                .reply(ObservationReply::ProcessOwner { uid: 501 }),
            ObservationScriptCall::SocketOwnership {
                socket_inode: SERVER_SOCKET_INODE,
            }
            .reply(ObservationReply::SocketOwner {
                pgid: SERVER_PGID,
                uid: 501,
            }),
            ObservationScriptCall::PgidKillWait { pgid: SERVER_PGID }
                .reply(ObservationReply::WaitStatus { status: 0 }),
            ObservationScriptCall::Close { fd: OBSERVER_FD }.reply(ObservationReply::Unit),
            ObservationScriptCall::Close { fd: UDP_FD }.reply(ObservationReply::Unit),
        ]);
        assert_eq!(observation.if_nametoindex("en8").expect("en8 index"), 8);
        assert_eq!(observation.siocgifmtu("en8").expect("en8 MTU"), 1500);
        observation
            .udp_connect(UDP_FD, MAC_DESTINATION)
            .expect("connect-only route probe");
        assert_eq!(
            observation.udp_getsockname(UDP_FD).expect("source"),
            MAC_SOURCE
        );
        observation
            .mac_packet_capture(OBSERVER_FD, "en8", "10.99.0.1", "10.99.0.2", 443, 128)
            .expect("macOS packet capture");
        let outbound = observation
            .packet_receipt_direction(OBSERVER_FD, "outbound")
            .expect("outbound packet receipt");
        outbound.assert_packets(PACKETS);
        outbound.assert_bytes(BYTES);
        outbound.assert_endpoints(MAC_SOURCE, MAC_DESTINATION);
        outbound.assert_cardinality(CARDINALITY);
        let inbound = observation
            .packet_receipt_direction(OBSERVER_FD, "inbound")
            .expect("inbound packet receipt");
        inbound.assert_packets(PACKETS);
        inbound.assert_bytes(BYTES);
        inbound.assert_endpoints(MAC_DESTINATION, MAC_SOURCE);
        inbound.assert_cardinality(CARDINALITY);
        assert_eq!(
            observation
                .process_group_ownership(SERVER_PGID)
                .expect("owned process group"),
            501
        );
        assert_eq!(
            observation
                .socket_ownership(SERVER_SOCKET_INODE)
                .expect("owned socket"),
            SERVER_PGID
        );
        observation
            .pgid_kill_wait(SERVER_PGID)
            .expect("owned PGID cleanup");
        observation.close(OBSERVER_FD).expect("packet fd close");
        observation.close(UDP_FD).expect("UDP fd close");
        observation.assert_script_exhausted();

        let mut command = SupervisorCommandRunner::scripted([
            CommandScriptCall::Tool {
                descriptor: ApprovedToolDescriptor {
                    fd: 701,
                    identity_sha256: MAC_ROUTE_IDENTITY_SHA256.into(),
                    tool: "route".into(),
                },
                argv: vec![
                    "route".into(),
                    "-n".into(),
                    "get".into(),
                    MAC_DESTINATION.into(),
                ],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"interface: en8".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 701 }.reply(CommandReply::Unit),
        ]);
        let route = command
            .run_exact(
                ApprovedToolDescriptor {
                    fd: 701,
                    identity_sha256: MAC_ROUTE_IDENTITY_SHA256.into(),
                    tool: "route".into(),
                },
                &["route", "-n", "get", MAC_DESTINATION],
                &[("LC_ALL", "C")],
            )
            .expect("exact Mac route command");
        route.assert_stdout_len(14);
        route.assert_stdout_sha256(
            "e45496e967c10efc553f45e00791e40fc1b8e12776f30713241d4cb12ac98a53",
        );
        route.assert_stderr_len(0);
        route.assert_stderr_sha256(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        route.assert_duration_ms(12);
        route.assert_exit(0);
        route.assert_tool_identity("route", MAC_ROUTE_IDENTITY_SHA256);
        route.assert_supervisor_identity("supervisor-instance-01");
        command.close(701).expect("route descriptor close");
        command.assert_script_exhausted();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_observation_command_set_freezes_route_and_ifconfig_argv() {
        let mut command = SupervisorCommandRunner::scripted([
            CommandScriptCall::Tool {
                descriptor: ApprovedToolDescriptor {
                    fd: 701,
                    identity_sha256: MAC_ROUTE_IDENTITY_SHA256.into(),
                    tool: "route".into(),
                },
                argv: vec![
                    "route".into(),
                    "-n".into(),
                    "get".into(),
                    "10.99.0.2".into(),
                ],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"interface: en8".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 701 }.reply(CommandReply::Unit),
            CommandScriptCall::Tool {
                descriptor: ApprovedToolDescriptor {
                    fd: 702,
                    identity_sha256: MAC_IFCONFIG_IDENTITY_SHA256.into(),
                    tool: "ifconfig".into(),
                },
                argv: vec!["ifconfig".into(), "en8".into()],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(0, b"mtu 1500".to_vec(), Vec::new())),
            CommandScriptCall::Close { fd: 702 }.reply(CommandReply::Unit),
        ]);
        let route = command
            .run_exact(
                ApprovedToolDescriptor {
                    fd: 701,
                    identity_sha256: MAC_ROUTE_IDENTITY_SHA256.into(),
                    tool: "route".into(),
                },
                &["route", "-n", "get", "10.99.0.2"],
                &[("LC_ALL", "C")],
            )
            .expect("exact Mac route command");
        route.assert_stdout_len(14);
        route.assert_stdout_sha256(
            "e45496e967c10efc553f45e00791e40fc1b8e12776f30713241d4cb12ac98a53",
        );
        route.assert_stderr_len(0);
        route.assert_stderr_sha256(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        route.assert_duration_ms(12);
        route.assert_exit(0);
        route.assert_tool_identity("route", MAC_ROUTE_IDENTITY_SHA256);
        route.assert_supervisor_identity("supervisor-instance-01");
        command.close(701).expect("route descriptor close");
        let ifconfig = command
            .run_exact(
                ApprovedToolDescriptor {
                    fd: 702,
                    identity_sha256: MAC_IFCONFIG_IDENTITY_SHA256.into(),
                    tool: "ifconfig".into(),
                },
                &["ifconfig", "en8"],
                &[("LC_ALL", "C")],
            )
            .expect("exact Mac ifconfig command");
        ifconfig.assert_stdout_len(8);
        ifconfig.assert_stdout_sha256(
            "2570fa9b077c39e0998a301abbc98960647519cac7f8a2d622971b768cfa57ba",
        );
        ifconfig.assert_stderr_len(0);
        ifconfig.assert_stderr_sha256(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        ifconfig.assert_duration_ms(12);
        ifconfig.assert_exit(0);
        ifconfig.assert_tool_identity("ifconfig", MAC_IFCONFIG_IDENTITY_SHA256);
        ifconfig.assert_supervisor_identity("supervisor-instance-01");
        command.close(702).expect("ifconfig descriptor close");
        command.assert_script_exhausted();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_reversed_route_ifconfig_order_is_rejected_before_tool_execution() {
        let route_descriptor = ApprovedToolDescriptor {
            fd: 701,
            identity_sha256: MAC_ROUTE_IDENTITY_SHA256.into(),
            tool: "route".into(),
        };
        let ifconfig_descriptor = ApprovedToolDescriptor {
            fd: 702,
            identity_sha256: MAC_IFCONFIG_IDENTITY_SHA256.into(),
            tool: "ifconfig".into(),
        };
        let mut command = SupervisorCommandRunner::scripted([
            CommandScriptCall::Tool {
                descriptor: ifconfig_descriptor.clone(),
                argv: vec!["ifconfig".into(), "en8".into()],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(0, b"mtu 1500".to_vec(), Vec::new())),
            CommandScriptCall::Close { fd: 702 }.reply(CommandReply::Unit),
            CommandScriptCall::Tool {
                descriptor: route_descriptor.clone(),
                argv: vec![
                    "route".into(),
                    "-n".into(),
                    "get".into(),
                    "10.99.0.2".into(),
                ],
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"interface: en8".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 701 }.reply(CommandReply::Unit),
        ]);
        assert_eq!(
            command
                .run_exact(
                    route_descriptor.clone(),
                    &["route", "-n", "get", "10.99.0.2"],
                    &[("LC_ALL", "C")],
                )
                .expect_err("route must be observed before ifconfig")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        command
            .run_exact(
                ifconfig_descriptor,
                &["ifconfig", "en8"],
                &[("LC_ALL", "C")],
            )
            .expect("the queued order is explicitly ifconfig then route");
        command.close(702).expect("ifconfig cleanup");
        command
            .run_exact(
                route_descriptor,
                &["route", "-n", "get", "10.99.0.2"],
                &[("LC_ALL", "C")],
            )
            .expect("route executes only after the order check");
        command.close(701).expect("route cleanup");
        command.assert_script_exhausted();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn observation_and_command_negatives_are_typed_and_fail_closed() {
        // Every observation negative below invokes the real supervisor-owned
        // operation.  The queue is deliberately missing, reordered, or
        // carrying a mutated input; no helper is allowed to reject a scenario
        // before an observation syscall is attempted.
        let mut unexpected_tool =
            SupervisorObservationSyscalls::scripted([ObservationScriptCall::IfNameToIndex {
                interface: "eno1".into(),
            }
            .reply(ObservationReply::InterfaceIndex(IFINDEX))]);
        assert_eq!(
            unexpected_tool
                .siocgifmtu("eno1")
                .expect_err("unexpected observation operation must fail")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        unexpected_tool.assert_script_exhausted();

        let mut missing_packet = SupervisorObservationSyscalls::scripted([
            ObservationScriptCall::IfNameToIndex {
                interface: "eno1".into(),
            }
            .reply(ObservationReply::InterfaceIndex(IFINDEX)),
            ObservationScriptCall::AfPacketDropCounters { fd: OBSERVER_FD }.reply(
                ObservationReply::DropCounters {
                    captured: 1,
                    dropped: 0,
                },
            ),
            ObservationScriptCall::Close { fd: OBSERVER_FD }.reply(ObservationReply::Unit),
        ]);
        assert_eq!(
            missing_packet
                .if_nametoindex("eno1")
                .expect("interface observation"),
            IFINDEX
        );
        assert_eq!(
            missing_packet
                .af_packet_drop_counters(OBSERVER_FD)
                .expect("drop counter observation")
                .captured,
            1
        );
        assert_eq!(
            missing_packet
                .packet_receipt(OBSERVER_FD)
                .expect_err("missing packet receipt must fail")
                .code(),
            "TRUST_ROUTE_OBSERVATION_MISSING"
        );
        missing_packet
            .close(OBSERVER_FD)
            .expect("missing packet cleanup closes observer");
        missing_packet.assert_script_exhausted();

        let mut reordered_observation =
            SupervisorObservationSyscalls::scripted([ObservationScriptCall::Siocgifmtu {
                interface: "eno1".into(),
            }
            .reply(ObservationReply::Mtu(1500))]);
        assert_eq!(
            reordered_observation
                .if_nametoindex("eno1")
                .expect_err("reordered observation must fail")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        reordered_observation.assert_script_exhausted();

        let mut missing_qdisc =
            SupervisorObservationSyscalls::scripted([ObservationScriptCall::IfNameToIndex {
                interface: "eno1".into(),
            }
            .reply(ObservationReply::InterfaceIndex(IFINDEX))]);
        assert_eq!(
            missing_qdisc
                .if_nametoindex("eno1")
                .expect("interface observation"),
            IFINDEX
        );
        assert_eq!(
            missing_qdisc
                .qdisc_cleanup("eno1", "fq", "fq")
                .expect_err("missing qdisc cleanup must fail")
                .code(),
            "TRUST_QDISC_OBSERVATION_MISSING"
        );
        missing_qdisc.assert_script_exhausted();

        // Command negatives also pass through run_exact.  The expected queue
        // contains a fully pinned invocation; each case mutates exactly one
        // command property at the execution boundary.
        let expected_descriptor = ApprovedToolDescriptor {
            fd: 601,
            identity_sha256: LINUX_IP_ROUTE_IDENTITY_SHA256.into(),
            tool: "ip".into(),
        };
        let expected_argv = [
            "/usr/sbin/ip",
            "-j",
            "route",
            "get",
            "10.99.0.1",
            "from",
            "10.99.0.2",
        ];
        let expected_env = [("LC_ALL", "C")];
        for scenario in [
            "unexpected-tool",
            "argv-drift",
            "environment-drift",
            "PATH-lookup",
            "shell-launch",
        ] {
            let mut command = SupervisorCommandRunner::scripted([CommandScriptCall::Tool {
                descriptor: expected_descriptor.clone(),
                argv: expected_argv.iter().map(|value| (*value).into()).collect(),
                env: expected_env
                    .iter()
                    .map(|(key, value)| ((*key).into(), (*value).into()))
                    .collect(),
            }
            .reply(CommandReply::exit(
                0,
                br#"{"dev":"eno1"}"#.to_vec(),
                Vec::new(),
            ))]);
            let mut descriptor = expected_descriptor.clone();
            let mut argv = expected_argv.to_vec();
            let mut env = expected_env.to_vec();
            match scenario {
                "unexpected-tool" => descriptor.tool = "route".into(),
                "argv-drift" => argv[2] = "address",
                "environment-drift" => env[0] = ("LC_ALL", "POSIX"),
                "PATH-lookup" => {
                    argv[0] = "ip";
                    env = [("LC_ALL", "C"), ("PATH", "/usr/bin:/bin")].to_vec();
                }
                "shell-launch" => {
                    argv = ["/bin/sh", "-c", "/usr/sbin/ip -j route"].to_vec();
                }
                _ => unreachable!("all command mutations are enumerated"),
            }
            assert_eq!(
                command
                    .run_exact(descriptor, &argv, &env)
                    .expect_err("mutated command must fail")
                    .code(),
                "TRUST_OBSERVATION_COMMAND_MISMATCH",
                "scenario {scenario}"
            );
            command.assert_script_exhausted();
        }

        // A reordered command and a child-authored source both travel through
        // execution, rather than a pre-rejection helper.  The child source is
        // part of the command invocation provenance and cannot be silently
        // accepted as supervisor-authored output.
        let second_descriptor = ApprovedToolDescriptor {
            fd: 602,
            identity_sha256: LINUX_TC_QDISC_IDENTITY_SHA256.into(),
            tool: "tc".into(),
        };
        let second_argv = ["/usr/sbin/tc", "-j", "qdisc", "show", "dev", "eno1"];
        let mut reordered_command = SupervisorCommandRunner::scripted([
            CommandScriptCall::Tool {
                descriptor: expected_descriptor.clone(),
                argv: expected_argv.iter().map(|value| (*value).into()).collect(),
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(0, b"route".to_vec(), Vec::new())),
            CommandScriptCall::Tool {
                descriptor: second_descriptor.clone(),
                argv: second_argv.iter().map(|value| (*value).into()).collect(),
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(0, b"qdisc".to_vec(), Vec::new())),
        ]);
        assert_eq!(
            reordered_command
                .run_exact(second_descriptor.clone(), &second_argv, &[("LC_ALL", "C")])
                .expect_err("reordered command must fail")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        reordered_command.assert_script_exhausted();

        let mut child_command = SupervisorCommandRunner::scripted([CommandScriptCall::Tool {
            descriptor: expected_descriptor.clone(),
            argv: expected_argv.iter().map(|value| (*value).into()).collect(),
            env: vec![("LC_ALL".into(), "C".into())],
        }
        .reply(CommandReply::exit(0, b"route".to_vec(), Vec::new()))]);
        assert_eq!(
            child_command
                .run_exact_from_child(
                    expected_descriptor,
                    &expected_argv,
                    &[("LC_ALL", "C")],
                    "raw-child-route"
                )
                .expect_err("child-authored command must fail")
                .code(),
            "TRUST_CHILD_OBSERVATION_FORBIDDEN"
        );
        child_command.assert_script_exhausted();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_observation_and_command_negatives_execute_and_fail_closed() {
        let mut interface_drift =
            SupervisorObservationSyscalls::scripted([ObservationScriptCall::IfNameToIndex {
                interface: "en8".into(),
            }
            .reply(ObservationReply::InterfaceIndex(8))]);
        assert_eq!(
            interface_drift
                .siocgifmtu("en9")
                .expect_err("mutated interface must fail at the observation seam")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        interface_drift.assert_script_exhausted();

        let mut missing_packet = SupervisorObservationSyscalls::scripted([
            ObservationScriptCall::IfNameToIndex {
                interface: "en8".into(),
            }
            .reply(ObservationReply::InterfaceIndex(8)),
            ObservationScriptCall::Siocgifmtu {
                interface: "en8".into(),
            }
            .reply(ObservationReply::Mtu(1500)),
            ObservationScriptCall::MacPacketCapture {
                fd: OBSERVER_FD,
                interface: "en8".into(),
                source: "10.99.0.1".into(),
                destination: "10.99.0.2".into(),
                port: 443,
                snap_length: 128,
            }
            .reply(ObservationReply::Unit),
            ObservationScriptCall::Close { fd: OBSERVER_FD }.reply(ObservationReply::Unit),
        ]);
        assert_eq!(
            missing_packet
                .if_nametoindex("en8")
                .expect("interface observation"),
            8
        );
        assert_eq!(
            missing_packet.siocgifmtu("en8").expect("MTU observation"),
            1500
        );
        missing_packet
            .mac_packet_capture(OBSERVER_FD, "en8", "10.99.0.1", "10.99.0.2", 443, 128)
            .expect("capture setup");
        assert_eq!(
            missing_packet
                .packet_receipt_direction(OBSERVER_FD, "outbound")
                .expect_err("missing packet receipt must fail")
                .code(),
            "TRUST_ROUTE_OBSERVATION_MISSING"
        );
        missing_packet
            .close(OBSERVER_FD)
            .expect("failed observation cleanup closes capture");
        missing_packet.assert_script_exhausted();

        let mut reordered =
            SupervisorObservationSyscalls::scripted([ObservationScriptCall::Siocgifmtu {
                interface: "en8".into(),
            }
            .reply(ObservationReply::Mtu(1500))]);
        assert_eq!(
            reordered
                .if_nametoindex("en8")
                .expect_err("reordered observation must fail")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        reordered.assert_script_exhausted();

        let mut filter_drift =
            SupervisorObservationSyscalls::scripted([ObservationScriptCall::MacPacketCapture {
                fd: OBSERVER_FD,
                interface: "en8".into(),
                source: "10.99.0.1".into(),
                destination: "10.99.0.2".into(),
                port: 443,
                snap_length: 128,
            }
            .reply(ObservationReply::Unit)]);
        assert_eq!(
            filter_drift
                .mac_packet_capture(OBSERVER_FD, "en8", "10.99.0.9", "10.99.0.2", 443, 128,)
                .expect_err("mutated packet filter must fail")
                .code(),
            "TRUST_OBSERVATION_COMMAND_MISMATCH"
        );
        filter_drift.assert_script_exhausted();

        let expected_descriptor = ApprovedToolDescriptor {
            fd: 701,
            identity_sha256: MAC_ROUTE_IDENTITY_SHA256.into(),
            tool: "route".into(),
        };
        let expected_argv = ["route", "-n", "get", "10.99.0.2"];
        let expected_env = [("LC_ALL", "C")];
        for scenario in [
            "tool-drift",
            "argv-drift",
            "environment-drift",
            "PATH-lookup",
            "shell-launch",
        ] {
            let mut command = SupervisorCommandRunner::scripted([
                CommandScriptCall::Tool {
                    descriptor: expected_descriptor.clone(),
                    argv: expected_argv.iter().map(|value| (*value).into()).collect(),
                    env: expected_env
                        .iter()
                        .map(|(key, value)| ((*key).into(), (*value).into()))
                        .collect(),
                }
                .reply(CommandReply::exit(
                    0,
                    b"interface: en8".to_vec(),
                    Vec::new(),
                )),
                CommandScriptCall::Close { fd: 701 }.reply(CommandReply::Unit),
            ]);
            let mut descriptor = expected_descriptor.clone();
            let mut argv = expected_argv.to_vec();
            let mut env = expected_env.to_vec();
            match scenario {
                "tool-drift" => descriptor.tool = "ifconfig".into(),
                "argv-drift" => argv[0] = "sh",
                "environment-drift" => env[0] = ("LC_ALL", "POSIX"),
                "PATH-lookup" => {
                    argv[0] = "route";
                    env = [("LC_ALL", "C"), ("PATH", "/usr/bin:/bin")].to_vec();
                }
                "shell-launch" => {
                    argv = ["/bin/sh", "-c", "route -n get 10.99.0.2"].to_vec();
                }
                _ => unreachable!("all Mac command mutations are enumerated"),
            }
            assert_eq!(
                command
                    .run_exact(descriptor, &argv, &env)
                    .expect_err("mutated command must fail at execution")
                    .code(),
                "TRUST_OBSERVATION_COMMAND_MISMATCH",
                "scenario {scenario}"
            );
            command.close(701).expect("mutated command cleanup");
            command.assert_script_exhausted();
        }

        let mut child_command = SupervisorCommandRunner::scripted([
            CommandScriptCall::Tool {
                descriptor: expected_descriptor.clone(),
                argv: expected_argv.iter().map(|value| (*value).into()).collect(),
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(
                0,
                b"interface: en8".to_vec(),
                Vec::new(),
            )),
            CommandScriptCall::Close { fd: 701 }.reply(CommandReply::Unit),
        ]);
        assert_eq!(
            child_command
                .run_exact_from_child(
                    expected_descriptor,
                    &expected_argv,
                    &[("LC_ALL", "C")],
                    "raw-child-route",
                )
                .expect_err("child-authored command must fail at execution")
                .code(),
            "TRUST_CHILD_OBSERVATION_FORBIDDEN"
        );
        child_command.close(701).expect("child command cleanup");
        child_command.assert_script_exhausted();
    }

    #[test]
    fn supervisor_command_output_is_bounded_before_receipt_publication() {
        let descriptor = ApprovedToolDescriptor {
            fd: 901,
            identity_sha256: LINUX_IP_COMMAND_IDENTITY_SHA256.into(),
            tool: "ip".into(),
        };
        let argv = ["/usr/sbin/ip", "-j", "route", "get", "10.99.0.1"];
        for (stdout, stderr, label) in [
            (vec![b'x'; 1_048_577], Vec::new(), "stdout"),
            (Vec::new(), vec![b'e'; 1_048_577], "stderr"),
        ] {
            let mut command = SupervisorCommandRunner::scripted([CommandScriptCall::Tool {
                descriptor: descriptor.clone(),
                argv: argv.iter().map(|value| (*value).into()).collect(),
                env: vec![("LC_ALL".into(), "C".into())],
            }
            .reply(CommandReply::exit(0, stdout, stderr))]);
            let error = match command.run_exact(descriptor.clone(), &argv, &[("LC_ALL", "C")]) {
                Ok(_) => panic!("{label} beyond the 1 MiB command bound must fail"),
                Err(error) => error,
            };
            assert_eq!(error.code(), "OUTPUT_FILE_TOO_LARGE", "{label}");
            command.assert_script_exhausted();
        }
    }
}
