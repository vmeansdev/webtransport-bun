//! `comparison-supervisor`: the sole official comparison filesystem and
//! process supervisor for the R1 WS/WT comparison campaign.
//!
//! The Windows stub is the first executable branch: it runs before argument
//! parsing, environment access, descriptor access, module/addon loading,
//! pathname access, child spawn, or artifact access, and exits with the
//! frozen boundary/platform-unavailable code.
//!
//! On macOS and Linux the supervisor runs its live trust bootstrap: authority
//! bytes arrive only over the anonymous bootstrap pipe, the expected digest
//! only over the independent digest descriptor, the campaign and staging
//! roots are taken into supervisor ownership and matched field-for-field
//! against the authority's declarations, and the lock, capability and
//! manifest are read through those pinned roots.  Absent, malformed, or
//! invalid authority fails closed with `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`
//! and writes no official output.

// The binary compiles the boundary module directly rather than linking the
// napi addon library: the cdylib's N-API imports resolve only inside a Node
// or Bun host process, never in a standalone executable.
#[cfg_attr(not(test), allow(dead_code))]
#[path = "../secure_fs.rs"]
mod secure_fs;

use std::io::Write;
use std::process::ExitCode;

/// SHA-256 of a byte slice as a lowercase 64-char hex string.
///
/// The same encoder the supervisor uses for the trust bootstrap receipts
/// and the run-command frame payloads. Kept local to the binary so a
/// divergence from the secure-fs canonicalizer is a single-file review.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Resolves one `--name <decimal fd>` option, requiring exactly one
/// occurrence and a non-negative decimal value.
///
/// This resolves only the four descriptors the trust bootstrap itself needs.
/// The complete frozen option list, its exact order, mode dispatch, and the
/// remaining five descriptors are the entrypoint contract and are validated
/// there; a descriptor this function does not own is left untouched.
#[cfg(not(windows))]
fn descriptor_option(args: &[String], name: &str) -> Result<i32, &'static str> {
    let mut found: Option<i32> = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            let value = args
                .get(index + 1)
                .ok_or("TRUST_DESCRIPTOR_ARGUMENT_INVALID")?;
            let parsed = value
                .parse::<i32>()
                .map_err(|_| "TRUST_DESCRIPTOR_ARGUMENT_INVALID")?;
            if parsed < 0 {
                return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
            }
            // A repeated descriptor option is an ambiguity the supervisor
            // must not resolve by preferring one occurrence.
            if found.is_some() {
                return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
            }
            found = Some(parsed);
            index += 2;
            continue;
        }
        index += 1;
    }
    found.ok_or("TRUST_DESCRIPTOR_ARGUMENT_INVALID")
}

/// Every descriptor the supervisor owns must be a distinct number: two
/// options naming one descriptor would let a single handle stand in for two
/// independent roots.
#[cfg(not(windows))]
fn run_keygen_ed25519(args: &[String]) -> Result<(), &'static str> {
    let mut private_out: Option<&str> = None;
    let mut public_out: Option<&str> = None;
    let mut overwrite = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--private-out=") {
            private_out = Some(value);
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--public-out=") {
            public_out = Some(value);
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--overwrite=") {
            overwrite = match value {
                "allow" => true,
                "refuse" => false,
                _ => return Err("TRUST_SIGNING_KEY_ARGUMENT_INVALID"),
            };
            index += 1;
            continue;
        }
        return Err("TRUST_SIGNING_KEY_ARGUMENT_INVALID");
    }
    let private_out = private_out.ok_or("TRUST_SIGNING_KEY_ARGUMENT_INVALID")?;
    let public_out = public_out.ok_or("TRUST_SIGNING_KEY_ARGUMENT_INVALID")?;
    let pair = secure_fs::cross_supervisor::generate_ed25519_keypair();
    write_exclusive_bytes(private_out, &pair.private_pkcs8_der, overwrite)?;
    write_exclusive_bytes(public_out, &pair.public_raw32, overwrite)?;
    Ok(())
}

/// Idempotent private-key destruction used by stage/run cleanup traps (A3).
#[cfg(not(windows))]
fn run_destroy_signing_key(args: &[String]) -> Result<(), &'static str> {
    let mut private_key: Option<&str> = None;
    let mut missing_ok = false;
    let mut expected_public_key_sha256: Option<&str> = None;
    for arg in args {
        if let Some(value) = arg.strip_prefix("--private-key=") {
            private_key = Some(value);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--missing=") {
            missing_ok = value == "ok";
            continue;
        }
        if let Some(value) = arg.strip_prefix("--expected-public-key-sha256=") {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err("TRUST_SIGNING_KEY_ARGUMENT_INVALID");
            }
            expected_public_key_sha256 = Some(value);
            continue;
        }
        return Err("TRUST_SIGNING_KEY_ARGUMENT_INVALID");
    }
    let private_key = private_key.ok_or("TRUST_SIGNING_KEY_ARGUMENT_INVALID")?;
    if let Some(expected) = expected_public_key_sha256 {
        secure_fs::cross_supervisor::verify_private_key_sibling_public_sha256(
            private_key,
            expected,
        )
        .map_err(|err| match err {
            secure_fs::cross_supervisor::CrossSupervisorError::SigningKeyMismatch
            | secure_fs::cross_supervisor::CrossSupervisorError::TrustProtocol => {
                "TRUST_SIGNING_KEY_ARGUMENT_INVALID"
            }
            _ => "TRUST_SIGNING_KEY_DESTROY_FAILED",
        })?;
    }
    secure_fs::cross_supervisor::destroy_signing_key_path(private_key, missing_ok).map_err(|err| {
        match err {
            secure_fs::cross_supervisor::CrossSupervisorError::TrustProtocol => {
                "TRUST_SIGNING_KEY_ARGUMENT_INVALID"
            }
            _ => "TRUST_SIGNING_KEY_DESTROY_FAILED",
        }
    })
}

/// Prove a private key path is absent after destroy (A3 recovery path).
#[cfg(not(windows))]
fn run_prove_signing_key_absent(args: &[String]) -> Result<(), &'static str> {
    let mut private_key: Option<&str> = None;
    for arg in args {
        if let Some(value) = arg.strip_prefix("--private-key=") {
            private_key = Some(value);
            continue;
        }
        return Err("TRUST_SIGNING_KEY_ARGUMENT_INVALID");
    }
    let private_key = private_key.ok_or("TRUST_SIGNING_KEY_ARGUMENT_INVALID")?;
    secure_fs::cross_supervisor::prove_signing_key_absent(private_key).map_err(|err| match err {
        secure_fs::cross_supervisor::CrossSupervisorError::TrustProtocol => {
            "TRUST_SIGNING_KEY_ARGUMENT_INVALID"
        }
        _ => "TRUST_SIGNING_KEY_STILL_PRESENT",
    })
}

#[cfg(unix)]
fn write_exclusive_bytes(path: &str, bytes: &[u8], overwrite: bool) -> Result<(), &'static str> {
    use std::ffi::CString;
    let c_path = CString::new(path).map_err(|_| "TRUST_SIGNING_KEY_ARGUMENT_INVALID")?;
    if overwrite {
        unsafe {
            let _ = libc::unlink(c_path.as_ptr());
        }
    }
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
            0o400,
        )
    };
    if fd < 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EEXIST) {
            return Err("TRUST_SIGNING_KEY_EXISTS");
        }
        return Err("TRUST_PROTOCOL");
    }
    let mut written = 0usize;
    while written < bytes.len() {
        let n = unsafe { libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written) };
        if n < 0 {
            unsafe {
                let _ = libc::close(fd);
            }
            return Err("TRUST_PROTOCOL");
        }
        written += n as usize;
    }
    if unsafe { libc::fsync(fd) } != 0 {
        unsafe {
            let _ = libc::close(fd);
        }
        return Err("TRUST_PROTOCOL");
    }
    if unsafe { libc::close(fd) } != 0 {
        return Err("TRUST_PROTOCOL");
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_exclusive_bytes(_path: &str, _bytes: &[u8], _overwrite: bool) -> Result<(), &'static str> {
    Err("TRUST_PLATFORM_UNSUPPORTED")
}

/// The four trust-bootstrap descriptors.  The campaign root is the one
/// option that is present on the Mac pair and absent on the Linux rig's
/// single root (`optional_descriptor_option`); whether this host may take
/// either shape is `bootstrap::root_descriptors`' decision at bootstrap,
/// never the argv's.
#[cfg(not(windows))]
fn resolve_descriptors(
    args: &[String],
) -> Result<secure_fs::supervisor::ResidentDescriptors, &'static str> {
    let descriptors = secure_fs::supervisor::ResidentDescriptors {
        authority_fd: descriptor_option(args, "--authority-fd")?,
        authority_digest_fd: descriptor_option(args, "--authority-digest-fd")?,
        campaign_root_fd: optional_descriptor_option(args, "--campaign-root-fd")?,
        staging_root_fd: descriptor_option(args, "--staging-root-fd")?,
    };
    let mut numbers = vec![
        descriptors.authority_fd,
        descriptors.authority_digest_fd,
        descriptors.staging_root_fd,
    ];
    numbers.extend(descriptors.campaign_root_fd);
    for (position, number) in numbers.iter().enumerate() {
        if numbers[position + 1..].contains(number) {
            return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
        }
    }
    Ok(descriptors)
}

/// The resident phase loop: one execution's admission, and the frames that
/// carry it.
///
/// The supervisor writes the run-command input frame, then waits for the role
/// child's `artifact-payload` output frame.  It holds both instants itself, so
/// the interval the leg had to happen in is a supervisor observation and not
/// something the child can state.  A series claiming a window outside that
/// interval did not happen on this run.
///
/// Fail-closed by construction, and the direction matters: the cost of a bug
/// here is a refused honest execution, never an admitted fabricated one.  A
/// refusal creates no descriptor file — the supervisor is the only writer, so
/// a refused series is unwritable rather than merely unpublished.
///
/// One loop per supervisor process, holding the campaign's whole execution
/// set.  The registry is what makes a grant single-use, so it is also what
/// stops one honest leg from answering for every cell: the second cell to
/// present that leg is presenting a grant this registry has already spent.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct ResidentLoop {
    grants: secure_fs::measurement::GrantRegistry,
    /// The campaign the bootstrap validated.  Taken from the authority, never
    /// from a frame: a controller that could name its own campaign could name
    /// one whose executions this supervisor has not been counting.
    campaign_id: String,
    candidate: String,
    /// The execution ordinal, assigned here.  The controller says which run
    /// and which transport it wants opened; it does not get to say which
    /// execution that is, because the execution is the thing the grant is
    /// bound to and the registry is the thing counting them.
    next_execution_index: u64,
    /// The one execution currently open.  The loop admits against this and
    /// never against anything a frame names.
    open: Option<OpenExecution>,
    /// The registry's accepted facts outlive its consumed grant. No frame
    /// can replace these before the next execution or terminal cleanup.
    accepted: Option<AcceptedExecution>,
    execution_authority: Option<ExecutionAuthority>,
    frames: secure_fs::supervisor::frame::SessionFrameBudget,
    admitted: u64,
    refused: u64,
    /// The sha256 of the supervisor's local Bun toolchain observation,
    /// computed at startup. The controller assembles the two-host join
    /// by reading this value from each supervisor; the per-host
    /// observation itself is what `observe_bun_toolchain` reads off the
    /// Bun executable (version, revision, digest, platform token).
    toolchain_sha256: Option<String>,
    /// The Phase-B cohort this supervisor is running, when the controller
    /// installed one.
    ///
    /// `None` is the production state today and is a refusal rather than a
    /// gap the loop papers over: a cohort session needs the rig signing key,
    /// the staged Mac public key and this execution's Phase-A binding, and a
    /// supervisor holding none of them must answer every cohort request with
    /// `COHORT_NOT_READY` rather than accept a grant it cannot sign for.
    cohort: Option<CohortRuntime>,
    /// The Phase-B Mac cohort runtime, when the launcher handed this
    /// supervisor the two §2.9(1) descriptors.
    ///
    /// Campaign-scoped, holding one `MacCohortSession` per execution: the Mac
    /// supervisor is spawned once per campaign (`spawnMacSupervisor` has one
    /// call site), so `executionIndex`, `receiptSequence` monotonicity and the
    /// §3.3 channel counter all live in one process across §3.2's four
    /// executions.
    mac_cohort: Option<secure_fs::cohort::mac::MacCohortRuntime>,
}

/// The three things a live cohort needs beyond the protocol itself: the
/// session that decides, the launcher that spawns, and the server child that
/// answers the warmup and barrier transitions.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct CohortRuntime {
    /// One campaign's rig supervisor, holding one session per execution.
    /// Campaign-scoped rather than execution-scoped because
    /// `spawnRigSupervisor` has one call site and §3.2 runs four executions
    /// through it.
    runtime: secure_fs::cohort::rig::RigCohortRuntime,
    spawner: Box<dyn secure_fs::cohort::rig::ServerSpawner>,
    child: Box<dyn secure_fs::cohort::rig::ServerChildChannel>,
}

/// An execution the supervisor has opened and not yet closed.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct OpenExecution {
    key: secure_fs::measurement::ExecutionKey,
    grant_sha256: String,
    grant: Vec<u8>,
    /// The `cross-supervisor-execution/v1` digest the Mac runtime retained
    /// for this execution, when it was opened through
    /// `mac-open-execution-request/v1` (amendment C2).  `None` for an
    /// execution opened over the legacy `open-execution` frame.
    cross_execution_sha256: Option<String>,
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct AcceptedExecution {
    grant: Vec<u8>,
    receipt: secure_fs::measurement::AdmissionReceipt,
    payload: Vec<u8>,
    cross_execution_sha256: Option<String>,
}

/// Exact identities read through the validated bootstrap, never through the
/// controller's execution draft.
#[cfg(not(windows))]
#[derive(Clone)]
struct ExecutionAuthority {
    authority_sha256: String,
    campaign_lock_sha256: String,
    staged_capability_sha256: String,
    source_archive_sha256: String,
    approved_plan_sha256: String,
    approval_record_sha256: String,
}

#[cfg(not(windows))]
impl ExecutionAuthority {
    fn validate(
        &self,
        draft: &serde_json::Value,
        campaign: &str,
        candidate: &str,
    ) -> Result<(), &'static str> {
        for (field, expected) in [
            ("authoritySha256", self.authority_sha256.as_str()),
            ("campaignLockSha256", self.campaign_lock_sha256.as_str()),
            (
                "stagedCapabilitySha256",
                self.staged_capability_sha256.as_str(),
            ),
            ("sourceArchiveSha256", self.source_archive_sha256.as_str()),
            ("approvedPlanSha256", self.approved_plan_sha256.as_str()),
            ("approvalRecordSha256", self.approval_record_sha256.as_str()),
            ("campaignId", campaign),
            ("candidate", candidate),
        ] {
            if draft.get(field).and_then(serde_json::Value::as_str) != Some(expected) {
                return Err("CROSS_SUPERVISOR_MISMATCH");
            }
        }
        Ok(())
    }
}

/// What one served session did.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct LoopSummary {
    admitted: u64,
    refused: u64,
    frames: u64,
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
impl ResidentLoop {
    fn new(campaign_id: &str, candidate: &str) -> Self {
        Self {
            grants: secure_fs::measurement::GrantRegistry::new(),
            campaign_id: campaign_id.to_owned(),
            candidate: candidate.to_owned(),
            next_execution_index: 0,
            open: None,
            accepted: None,
            execution_authority: None,
            frames: secure_fs::supervisor::frame::SessionFrameBudget::new(),
            admitted: 0,
            refused: 0,
            toolchain_sha256: None,
            cohort: None,
            mac_cohort: None,
        }
    }

    /// Install the campaign's Mac cohort runtime.  One per process, for the
    /// same reason the rig's is one per process: a second install would give
    /// the same frames two key sets to choose from.
    fn install_mac_cohort_runtime(
        &mut self,
        runtime: secure_fs::cohort::mac::MacCohortRuntime,
    ) -> Result<(), &'static str> {
        if self.mac_cohort.is_some() {
            return Err("COHORT_NOT_READY");
        }
        self.mac_cohort = Some(runtime);
        Ok(())
    }

    /// Route one controller -> Mac cohort request to the transition it names.
    ///
    /// Every refusal code this returns is a member of §7's closed table,
    /// because `MacRefusal::code()` is the only thing that produces one.  The
    /// rig path does not have that property today and the difference is
    /// deliberate.
    fn mac_cohort_request(&mut self, kind: &str, payload: &[u8]) -> Result<Vec<u8>, &'static str> {
        let now_ms = secure_fs::measurement::now_epoch_millis().max(0.0) as u64;
        let mac = self.mac_cohort.as_mut().ok_or("COHORT_NOT_READY")?;
        mac.dispatch(kind, payload, now_ms)
            .map_err(|refusal| refusal.code())
    }

    /// MAC_EXECUTION_OPEN (§2.9(2c), amendment C2): the one Phase-A frame that
    /// opens an execution through the Mac runtime.
    ///
    /// Sequence first (net 1, the same bounded tracking every cohort frame
    /// gets), then the draft is validated against the bootstrap authority and
    /// the campaign this loop was opened for, then the loop — the sole
    /// allocator of ordinals — issues the measurement grant, and only then
    /// does the Mac runtime construct the execution and sign its receipt over
    /// that grant.  A construction refusal abandons the grant it was issued
    /// for: an execution the Mac would not sign for is not left open.
    fn mac_open_execution(&mut self, payload: &[u8]) -> Result<Vec<u8>, &'static str> {
        use secure_fs::cohort::mac;
        let now_ms = secure_fs::measurement::now_epoch_millis().max(0.0) as u64;
        let authority = self.execution_authority.clone().ok_or("COHORT_NOT_READY")?;
        let mac_runtime = self.mac_cohort.as_mut().ok_or("COHORT_NOT_READY")?;
        mac_runtime
            .charge_request_seq(mac::MAC_OPEN_EXECUTION_KIND, payload)
            .map_err(|refusal| refusal.code())?;
        let request =
            mac::read_open_execution_request(payload).map_err(|refusal| refusal.code())?;
        authority.validate(&request.draft, &self.campaign_id, &self.candidate)?;
        let grant = self.open_next_execution(
            &request.facts.run_id,
            &request.facts.transport,
            request.facts.declared_message_count,
            request.facts.declared_message_bytes,
        )?;
        let mac_runtime = self.mac_cohort.as_mut().ok_or("COHORT_NOT_READY")?;
        let opened = match mac_runtime.construct_execution(&request, &grant, now_ms) {
            Ok(opened) => opened,
            Err(refusal) => {
                if let Some(open) = self.open.take() {
                    self.grants.abandon(&open.key);
                }
                return Err(refusal.code());
            }
        };
        let open = self.open.as_mut().ok_or("MEASUREMENT_GRANT_ABSENT")?;
        if open.key.execution_index != opened.execution_index {
            return Err("CROSS_SUPERVISOR_MISMATCH");
        }
        open.cross_execution_sha256 = Some(opened.execution_sha256.clone());
        mac_runtime
            .opened_ack(request.request_seq, &opened.execution_sha256)
            .map_err(|refusal| refusal.code())
    }

    /// Install the cohort this session will run.  One per session: a second
    /// install would give the same frames two cohorts to choose from.
    fn install_cohort_runtime(&mut self, runtime: CohortRuntime) -> Result<(), &'static str> {
        if self.cohort.is_some() {
            return Err("COHORT_NOT_READY");
        }
        self.cohort = Some(runtime);
        Ok(())
    }

    /// Route one controller -> rig cohort request to the transition it names.
    ///
    /// The kind chooses the transition and the session chooses whether that
    /// transition is legal right now; nothing inside the payload gets to do
    /// either.
    fn cohort_request(&mut self, kind: &str, payload: &[u8]) -> Result<Vec<u8>, &'static str> {
        let now_ms = secure_fs::measurement::now_epoch_millis().max(0.0) as u64;
        let cohort = self.cohort.as_mut().ok_or("COHORT_NOT_READY")?;
        // §3.3: the kind on the wire is the payload schema with `/v1` removed,
        // so this switch is written in header spelling and the payload's own
        // `schema` field is re-checked by each transition's parser.
        //
        // ACCEPT_COHORT is the one transition with no session yet: it is the
        // frame that carries the acceptance the session is built from. Every
        // other kind is routed to the session that already owns the execution
        // the frame names, and refuses if there is none.
        // §5 RIG_EXECUTION_ACCEPTED carries no execution digest of its own:
        // the execution is whatever the authenticated Mac receipt names, so it
        // is routed before the digest lookup every later kind goes through.
        if kind == "rig-accept-execution-request" {
            return cohort
                .runtime
                .accept_execution(payload, now_ms)
                .map_err(|refusal| refusal.code());
        }
        if kind == "rig-accept-cohort-request" {
            return cohort
                .runtime
                .accept_cohort(payload, now_ms)
                .map_err(|refusal| refusal.code());
        }
        let execution_sha256 = secure_fs::cohort::rig::request_execution_sha256(payload)
            .map_err(|refusal| refusal.code())?;
        let CohortRuntime {
            runtime,
            spawner,
            child,
        } = cohort;
        let session = runtime
            .session_mut(&execution_sha256)
            .map_err(|refusal| refusal.code())?;
        let result = match kind {
            "rig-spawn-server-request" => session.spawn_server(payload, spawner.as_mut()),
            "rig-begin-warmup-request" => session.begin_warmup(payload, child.as_mut()),
            "rig-finish-warmup-request" => session.finish_warmup(payload, child.as_mut(), now_ms),
            "rig-measure-start-request" => session.measure_start(payload),
            "rig-present-start-barrier-request" => {
                session.present_start_barrier(payload, child.as_mut(), now_ms)
            }
            "rig-stop-and-capture-request" => {
                session.stop_and_capture(payload, child.as_mut(), now_ms)
            }
            "rig-teardown-server-request" => {
                let mut reaper = secure_fs::cohort::LibcProcessGroupReaper::default();
                session.teardown_server(payload, child.as_mut(), &mut reaper)
            }
            _ => return Err("TRUST_CHILD_FRAME_INVALID"),
        };
        result.map_err(|refusal| refusal.code())
    }

    /// The `executionSha256` a cohort request binds, when this supervisor
    /// already holds a session for it.
    ///
    /// §2.7's refusal states the **bound** execution, not the one the frame
    /// asked about: before the binding exists the honest answer is `null`, and
    /// echoing back a digest the controller supplied would make the refusal
    /// look like a statement about an execution this rig had accepted.
    fn bound_execution_sha256(&mut self, payload: &[u8]) -> Option<String> {
        let claimed = secure_fs::cohort::rig::request_execution_sha256(payload).ok()?;
        if let Some(cohort) = self.cohort.as_mut() {
            if cohort.runtime.session_mut(&claimed).is_ok() {
                return Some(claimed);
            }
        }
        let mac = self.mac_cohort.as_mut()?;
        mac.session_mut(&claimed).ok()?;
        Some(claimed)
    }

    /// Reap every process group the cohort owns.  Runs on every terminal path
    /// of the session, including a protocol violation, because a refused
    /// cohort must not outlive the connection that refused it.
    fn teardown_cohort(&mut self) {
        if let Some(cohort) = self.cohort.as_mut() {
            let mut reaper = secure_fs::cohort::LibcProcessGroupReaper::default();
            cohort.runtime.teardown_all(&mut reaper);
        }
    }

    /// Observe the supervisor's local Bun toolchain and store the sha256
    /// of its canonical bytes. The Bun executable path comes from the
    /// staged archive the trust bootstrap already verified; reading it
    /// again here is the supervisor's own measurement, not an echo of
    /// anything the child said.
    fn observe_local_toolchain(&mut self, bun: std::fs::File, label: &str) -> Result<(), String> {
        use secure_fs::supervisor::records::{observe_bun_toolchain, ObservedToolchainHostFacts};
        let facts: ObservedToolchainHostFacts = observe_bun_toolchain(bun, label)?;
        // The canonical record the controller hashes is the strict
        // subset the per-host observation publishes, not the
        // supervisor's full structured record. Encoding matches the
        // TypeScript `ObservedToolchainHostFacts` shape so the
        // controller can re-hash the same bytes the supervisor wrote.
        //
        // **Do not refactor this into a typed struct with
        // `derive(Serialize)`.** The `serde_json::json!` macro below
        // produces a `Value::Object`, whose underlying `Map` is
        // BTreeMap-backed and therefore orders keys alphabetically.
        // The controller's TypeScript `canonicalJson` (canonical.ts)
        // also sorts keys alphabetically, so the two encoders
        // produce byte-identical output for the same record. A
        // `derive(Serialize)` struct serializes in declaration
        // order, which would diverge from the controller's
        // canonicalizer and the per-host sha256 would no longer be
        // reproducible by the controller -- the controller has no
        // other way to verify the supervisor's hash because the
        // per-host record itself is not on the wire (only
        // `toolchainSha256` is). I verified the byte-match end-to-end
        // on 2026-08-28; do not regress it.
        let record = serde_json::json!({
            "schema": "observed-toolchain/v1",
            "platform": facts.platform,
            "bunVersion": facts.bun_version,
            "bunRevision": facts.bun_revision,
            "bunExecutableSha256": facts.bun_executable_sha256,
        });
        let bytes = serde_json::to_vec(&record).map_err(|err| err.to_string())?;
        let digest = sha256_hex(&bytes);
        self.toolchain_sha256 = Some(digest);
        Ok(())
    }

    /// The supervisor's local toolchain observation's sha256, or
    /// `None` if the supervisor has not yet observed one. The
    /// controller reads this to assemble the two-host set.
    fn toolchain_sha256(&self) -> Option<&str> {
        self.toolchain_sha256.as_deref()
    }

    /// Mint one execution's grant and return the `run-command` payload that
    /// carries it.
    ///
    /// Called as the run-command input frame is written — before the child
    /// exists, so before it can have measured anything.  The issuing instant
    /// is the bracket's lower edge and the registry keeps it; nothing about it
    /// comes back out of a frame.
    fn open_execution(
        &mut self,
        request: &secure_fs::measurement::GrantRequest,
    ) -> Result<Vec<u8>, &'static str> {
        self.grants
            .issue(request)
            .and_then(|grant| grant.run_command_payload())
            .map_err(|refusal| refusal.code())
    }

    /// Open the next execution of this campaign for one run and transport.
    ///
    /// This is the identity-owning entry: the campaign and the ordinal are the
    /// supervisor's, the run and the transport are the controller's statement
    /// of what it wants measured, and the two counts are what the grant will
    /// hold the resulting series to.
    ///
    /// Opening while an execution is already open abandons the old one, which
    /// spends its grant.  A child that never presented does not get to leave a
    /// live bracket behind for the next presentation to find.
    fn open_next_execution(
        &mut self,
        run_id: &str,
        transport: &str,
        declared_message_count: u64,
        declared_message_bytes: u64,
    ) -> Result<Vec<u8>, &'static str> {
        if let Some(previous) = self.open.take() {
            self.grants.abandon(&previous.key);
        }
        self.accepted = None;
        self.next_execution_index += 1;
        let key = secure_fs::measurement::ExecutionKey {
            campaign_id: self.campaign_id.clone(),
            run_id: run_id.to_owned(),
            execution_index: self.next_execution_index,
            transport: transport.to_owned(),
        };
        let payload = self.open_execution(&secure_fs::measurement::GrantRequest {
            candidate: self.candidate.clone(),
            execution: key.clone(),
            declared_message_count,
            declared_message_bytes,
        })?;
        self.open = Some(OpenExecution {
            key,
            grant_sha256: secure_fs::measurement::sha256_hex_of(&payload),
            grant: payload.clone(),
            cross_execution_sha256: None,
        });
        Ok(payload)
    }

    /// Stamped as the `artifact-payload` frame is accepted, closing the
    /// bracket the series is checked against.
    ///
    /// The execution is named here, by the supervisor that opened it — never
    /// read out of the frame, which would let the payload choose which grant
    /// it is checked against.
    fn accept_artifact_payload(
        &mut self,
        execution: &secure_fs::measurement::ExecutionKey,
        frame_bytes: &[u8],
    ) -> Result<secure_fs::measurement::AdmittedSeries, &'static str> {
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis();
        self.grants
            .admit_artifact_payload_frame(execution, frame_bytes, accepted_at_ms)
    }

    /// Admit — or refuse — the open execution's one presentation, and produce
    /// the receipt for it.
    ///
    /// A frame that arrives with no execution open is late, unsolicited, or a
    /// second presentation, and all three are the same answer: this execution
    /// has no unspent grant.  That is the fail-closed direction and it is why
    /// the open slot is taken rather than read.
    fn present_artifact_payload(
        &mut self,
        frame_bytes: &[u8],
    ) -> Result<(secure_fs::measurement::AdmissionReceipt, Vec<u8>), &'static str> {
        let open = self.open.take().ok_or("MEASUREMENT_GRANT_ABSENT")?;
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis();
        let payload = match secure_fs::measurement::artifact_payload_of(frame_bytes) {
            Ok(payload) => payload,
            Err(code) => {
                // A presentation that never became a series still spends the
                // execution's one attempt.
                self.grants.abandon(&open.key);
                return Err(code);
            }
        };
        let series = self
            .grants
            .admit_payload(&open.key, &payload, accepted_at_ms)
            .map_err(|refusal| refusal.code())?;
        let receipt = secure_fs::measurement::AdmissionReceipt {
            execution: open.key,
            grant_sha256: open.grant_sha256,
            payload_sha256: secure_fs::measurement::sha256_hex_of(&payload),
            series,
            frame_accepted_at_ms: accepted_at_ms,
        };
        // C2: the verified facts are transferred into the execution-scoped
        // Mac state **before** the open slot is gone, so every later Mac mint
        // reads the series this loop admitted and never a controller value.
        if let Some(execution_sha256) = open.cross_execution_sha256.as_deref() {
            let mac = self.mac_cohort.as_mut().ok_or("COHORT_NOT_READY")?;
            mac.retain_admitted_series(execution_sha256, &receipt, &payload)
                .map_err(|refusal| refusal.code())?;
        }
        self.accepted = Some(AcceptedExecution {
            grant: open.grant,
            receipt: receipt.clone(),
            payload: payload.clone(),
            cross_execution_sha256: open.cross_execution_sha256,
        });
        Ok((receipt, payload))
    }

    /// Carry frames for one session, committing every series admitted and no
    /// series refused.
    ///
    /// The write is inside the admitted branch and nowhere else.  That is the
    /// property the whole design rests on, and it is one line: `sink.commit`
    /// is unreachable from a refusal, so a refused series is not written by
    /// this process, and this process is the only one holding the campaign
    /// root.
    ///
    /// A refused series ends its execution and not the session — the grant is
    /// spent, so that execution cannot present again, and the remaining
    /// executions of a 768-cell campaign should not be lost to one bad child.
    /// A malformed *frame* is different: the peer is not speaking the protocol,
    /// so nothing later in the stream can be trusted to be a frame boundary,
    /// and the session ends.
    fn serve<R: std::io::Read, W: std::io::Write, S: secure_fs::measurement::AdmittedSink>(
        &mut self,
        reader: &mut R,
        writer: &mut W,
        sink: &mut S,
    ) -> Result<LoopSummary, &'static str> {
        use secure_fs::measurement as m;
        loop {
            let frame = match m::read_frame(reader, m::ARTIFACT_PAYLOAD_MAX_BYTES) {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(code) => return self.terminate(writer, code),
            };
            if self.frames.charge().is_err() {
                return self.terminate(writer, "FRAME_SESSION_LIMIT");
            }
            let decoded = match secure_fs::supervisor::frame::decode_single_frame(
                &frame,
                m::ARTIFACT_PAYLOAD_MAX_BYTES,
            ) {
                Ok(decoded) => decoded,
                Err(_) => return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID"),
            };
            let header = match secure_fs::supervisor::records::strict_parse(&decoded.header) {
                Ok(header) => header,
                Err(_) => return self.terminate(writer, "TRUST_RECORD_MALFORMED"),
            };
            match header
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
            {
                m::OPEN_EXECUTION_KIND => {
                    let opened = self.open_requested(&decoded.payload);
                    match opened {
                        Ok(payload) => {
                            m::write_frame(
                                writer,
                                m::RUN_COMMAND_KIND,
                                &payload,
                                m::RUN_COMMAND_MAX_BYTES,
                            )?;
                        }
                        Err(code) => return self.terminate(writer, code),
                    }
                }
                m::ARTIFACT_PAYLOAD_KIND => match self.present_artifact_payload(&frame) {
                    Ok((receipt, payload)) => {
                        // Committed first, answered second: the receipt the
                        // controller gets back is a statement that the series
                        // is written, not a promise that it will be.
                        sink.commit(&receipt, &payload)?;
                        self.admitted += 1;
                        m::write_frame(
                            writer,
                            m::ADMISSION_RECEIPT_KIND,
                            &receipt.canonical_bytes(),
                            m::RUN_COMMAND_MAX_BYTES,
                        )?;
                    }
                    Err(code) => {
                        self.refused += 1;
                        m::write_frame(
                            writer,
                            m::ADMISSION_REFUSAL_KIND,
                            refusal_payload(code).as_bytes(),
                            m::RUN_COMMAND_MAX_BYTES,
                        )?;
                    }
                },
                // Phase A in the binary (§2.9(2c)): the Mac execution open.
                secure_fs::cohort::mac::MAC_OPEN_EXECUTION_KIND => {
                    let request_cap = secure_fs::cohort::mac::request_payload_cap(
                        secure_fs::cohort::mac::MAC_OPEN_EXECUTION_KIND,
                    ) as u64;
                    if decoded.payload.len() as u64 > request_cap {
                        return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID");
                    }
                    let payload = decoded.payload.clone();
                    match self.mac_open_execution(&payload) {
                        Ok(ack) => {
                            m::write_frame(
                                writer,
                                secure_fs::cohort::mac::MAC_EXECUTION_OPENED_ACK_KIND,
                                &ack,
                                secure_fs::cohort::mac::ack_payload_cap(
                                    secure_fs::cohort::mac::MAC_EXECUTION_OPENED_ACK_KIND,
                                ) as u64,
                            )?;
                        }
                        Err(code) => {
                            return self.terminate_cohort(writer, &payload, code);
                        }
                    }
                }
                // Phase B: the eight controller -> Mac cohort request kinds.
                //
                // Placed before the rig arm because the two kind sets are
                // disjoint by construction (`mac-*` against `rig-*`) and the
                // order therefore cannot matter; it is written first only
                // because a reader arriving at `ack_kind_for` should see both
                // supervisors, not one.
                kind if secure_fs::cohort::mac::ack_kind_for(kind).is_some() => {
                    let ack_kind = secure_fs::cohort::mac::ack_kind_for(kind).expect("kind");
                    // The **kind's** cap, not one number for all eight.
                    // Registry edits (c) and (e) moved two requests off
                    // `CAPS.remotePayloadDefault` (384 KiB and 14 MiB encoded),
                    // and a single 1 MiB gate here would refuse the largest
                    // legal frame in the protocol as a malformed child frame —
                    // before the codec that knows its cap ever saw it.
                    let request_cap = secure_fs::cohort::mac::request_payload_cap(kind) as u64;
                    if decoded.payload.len() as u64 > request_cap {
                        return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID");
                    }
                    let payload = decoded.payload.clone();
                    match self.mac_cohort_request(kind, &payload) {
                        Ok(ack) => {
                            m::write_frame(
                                writer,
                                ack_kind,
                                &ack,
                                secure_fs::cohort::mac::ack_payload_cap(ack_kind) as u64,
                            )?;
                        }
                        Err(code) => {
                            return self.terminate_cohort(writer, &payload, code);
                        }
                    }
                }
                // Phase B: the eight controller -> rig cohort request kinds.
                //
                // §2.7: a refused cohort transition is **terminal**. §3.3 is
                // unambiguous — "The refusal kind is `remote-supervisor-refusal`.
                // No alias kind is accepted" — and `RemoteSupervisorRefusalV1`
                // is `terminal: true`, which is not decoration: one remote
                // channel carries one open execution, so a refused transition
                // ends that arm. Phase A keeps `measurement-refusal/v1`; only
                // this dispatch changed.
                kind if secure_fs::cohort::rig::ack_kind_for(kind).is_some() => {
                    let ack_kind = secure_fs::cohort::rig::ack_kind_for(kind).expect("kind");
                    if decoded.payload.len() as u64
                        > secure_fs::cohort::rig::COHORT_REMOTE_FRAME_MAX_BYTES
                    {
                        return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID");
                    }
                    let payload = decoded.payload.clone();
                    match self.cohort_request(kind, &payload) {
                        Ok(ack) => {
                            m::write_frame(
                                writer,
                                ack_kind,
                                &ack,
                                secure_fs::cohort::rig::COHORT_REMOTE_FRAME_MAX_BYTES,
                            )?;
                        }
                        Err(code) => {
                            return self.terminate_cohort(writer, &payload, code);
                        }
                    }
                }
                _ => return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID"),
            }
        }
        self.teardown_cohort();
        Ok(self.summary())
    }

    /// Read an `open-execution` request and open what it asks for.
    fn open_requested(&mut self, payload: &[u8]) -> Result<Vec<u8>, &'static str> {
        let request = secure_fs::supervisor::records::strict_parse(payload)
            .map_err(|_| "TRUST_RECORD_MALFORMED")?;
        let text = |key: &str| -> Result<String, &'static str> {
            request
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or("TRUST_RECORD_MALFORMED")
        };
        let count = |key: &str| -> Result<u64, &'static str> {
            request
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .ok_or("TRUST_RECORD_MALFORMED")
        };
        self.open_next_execution(
            &text("runId")?,
            &text("transport")?,
            count("declaredMessageCount")?,
            count("declaredMessageBytes")?,
        )
    }

    /// §2.7: end the arm on a refused cohort transition, having said why in
    /// the codec §3.3 froze for this channel.
    ///
    /// `remote-supervisor-refusal/v1`, not `measurement-refusal/v1`: plan 531
    /// says "The refusal kind is `remote-supervisor-refusal`. No alias kind is
    /// accepted." `terminal: true` is the record's meaning and this method is
    /// what makes it true — the session ends here, the cohort is reaped, and
    /// the controller appends exactly one index entry for the arm.
    fn terminate_cohort<W: std::io::Write>(
        &mut self,
        writer: &mut W,
        payload: &[u8],
        code: &'static str,
    ) -> Result<LoopSummary, &'static str> {
        // A refusal states what it read.  A payload whose `requestSeq` is not
        // there to read is a malformed frame, not a refused transition, and it
        // takes the malformed-frame path rather than being answered with an
        // `ackRequestSeq` this supervisor invented.
        let request_seq = match serde_json::from_slice::<serde_json::Value>(payload)
            .ok()
            .as_ref()
            .and_then(|value| value.get("requestSeq"))
            .and_then(serde_json::Value::as_u64)
        {
            Some(seq) => seq,
            None => return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID"),
        };
        let execution_sha256 = self.bound_execution_sha256(payload);
        let response_seq = execution_sha256
            .as_deref()
            .and_then(|execution| {
                if let Some(cohort) = self.cohort.as_mut() {
                    if let Ok(session) = cohort.runtime.session_mut(execution) {
                        return Some(session.response_sequence());
                    }
                }
                let mac = self.mac_cohort.as_mut()?;
                Some(mac.session_mut(execution).ok()?.response_sequence())
            })
            .unwrap_or(0);
        // §2.7's three codes are the ones a *staging* or *reachability*
        // failure produces; everything a transition can refuse with is a FAIL.
        let campaign_status = match code {
            "RIG_UNREACHABLE" | "HOST_FD_PREFLIGHT" | "STALE_OR_INVALID_STAGING" => "REFUSED",
            _ => "FAIL",
        };
        let refusal = serde_json::json!({
            "schema": "remote-supervisor-refusal/v1",
            "responseSeq": response_seq,
            "ackRequestSeq": request_seq,
            "executionSha256": match execution_sha256 {
                Some(execution) => serde_json::Value::from(execution),
                None => serde_json::Value::Null,
            },
            "code": code,
            "campaignStatus": campaign_status,
            "terminal": true,
        });
        let bytes = secure_fs::cohort::canonical_bytes(&refusal).map_err(|_| "TRUST_PROTOCOL")?;
        if let Some(open) = self.open.take() {
            self.grants.abandon(&open.key);
        }
        self.teardown_cohort();
        self.refused += 1;
        let _ = secure_fs::measurement::write_frame(
            writer,
            "remote-supervisor-refusal",
            &bytes,
            secure_fs::cohort::rig::COHORT_REMOTE_FRAME_MAX_BYTES,
        );
        Err(code)
    }

    /// End the session on a protocol violation, having said why.
    fn terminate<W: std::io::Write>(
        &mut self,
        writer: &mut W,
        code: &'static str,
    ) -> Result<LoopSummary, &'static str> {
        if let Some(open) = self.open.take() {
            self.grants.abandon(&open.key);
        }
        self.teardown_cohort();
        self.refused += 1;
        let _ = secure_fs::measurement::write_frame(
            writer,
            secure_fs::measurement::ADMISSION_REFUSAL_KIND,
            refusal_payload(code).as_bytes(),
            secure_fs::measurement::RUN_COMMAND_MAX_BYTES,
        );
        Err(code)
    }

    fn summary(&self) -> LoopSummary {
        LoopSummary {
            admitted: self.admitted,
            refused: self.refused,
            frames: self.frames.used(),
        }
    }
}

/// The refusal record one refused presentation answers with.
///
/// A bounded code and nothing else — the same discipline every other refusal
/// on this boundary keeps, so a refusal cannot carry a path, a host, or a hint
/// about which comparison it failed.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
fn refusal_payload(code: &str) -> String {
    format!("{{\"code\":\"{code}\",\"schema\":\"measurement-refusal/v1\"}}\n")
}

// ---------------------------------------------------------------------------
// Phase B: installing a live cohort runtime
// ---------------------------------------------------------------------------

/// The two descriptors a Phase B rig supervisor needs beyond the bootstrap.
///
/// Both or neither: a supervisor holding a signing key but no role root could
/// sign receipts for a child it cannot launch, and one holding a role root but
/// no key could spawn a server it cannot receipt for.  Both are worse than a
/// supervisor that refuses every cohort frame, which is what "neither" gets.
///
/// **§2.13 removed two.** Round two gave this process the execution acceptance
/// and its signature as descriptors read once at startup. `spawnRigSupervisor`
/// has exactly one call site, so the process is campaign-scoped, and an
/// acceptance read at startup binds the whole campaign to execution 1 —
/// executions 2, 3 and 4 refuse on `executionSha256`. The acceptance now
/// travels on `rig-accept-cohort-request/v1`, symmetric with the Mac's
/// `mac-open-cohort-request/v1`, and only campaign-scoped material stays on a
/// descriptor.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CohortInstallDescriptors {
    /// The rig Ed25519 private key, PKCS#8 DER.  A descriptor and never a
    /// path or an environment variable: the key lives outside every root this
    /// supervisor owns, so the launcher opens it and this process inherits
    /// the open file and no way to name it.
    signing_key_fd: i32,
    /// The directory holding the staged role entrypoints.  The spawned child
    /// `fchdir`s to it, so the supervisor never handles a path for the thing
    /// it executes.
    role_root_fd: i32,
}

/// Resolve one optional `--name <fd>` option.
#[cfg(not(windows))]
fn optional_descriptor_option(args: &[String], name: &str) -> Result<Option<i32>, &'static str> {
    if !args.iter().any(|arg| arg == name) {
        return Ok(None);
    }
    descriptor_option(args, name).map(Some)
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
fn cohort_install_descriptors(
    args: &[String],
) -> Result<Option<CohortInstallDescriptors>, &'static str> {
    const NAMES: [&str; 2] = ["--cohort-signing-key-fd", "--cohort-role-root-fd"];
    let mut resolved = [0i32; 2];
    let mut present = 0usize;
    for (slot, name) in NAMES.iter().enumerate() {
        match optional_descriptor_option(args, name)? {
            Some(fd) => {
                resolved[slot] = fd;
                present += 1;
            }
            None => resolved[slot] = -1,
        }
    }
    if present == 0 {
        return Ok(None);
    }
    if present != NAMES.len() {
        return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
    }
    for (position, number) in resolved.iter().enumerate() {
        if resolved[position + 1..].contains(number) {
            return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
        }
    }
    Ok(Some(CohortInstallDescriptors {
        signing_key_fd: resolved[0],
        role_root_fd: resolved[1],
    }))
}

/// The two descriptors a Phase B **Mac** supervisor needs beyond the
/// bootstrap (§2.9(1), review NEW-3).
///
/// Both or neither, and that is the whole rule: a supervisor holding the Mac
/// signing key but not the staged rig public key could sign a barrier over a
/// rig record it never authenticated, which is precisely the property §2.9
/// exists to make impossible; one holding the rig key but no signing key could
/// authenticate everything and say nothing.  Present-but-incomplete is
/// `TRUST_DESCRIPTOR_ARGUMENT_INVALID` and a failed install is fatal at
/// startup, never a silent fall back to "no cohort".
///
/// **Two, not four.** Revision 3 gave this binary an execution binding and a
/// role-plan descriptor as well.  The Mac supervisor is spawned once per
/// campaign, so a per-`<runId>` descriptor read at startup pins the whole
/// campaign to execution 1; both per-execution inputs now travel on
/// `mac-open-cohort-request/v1`, whose frozen key set already carries the
/// role-plan bytes, their digest and their size.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MacCohortInstallDescriptors {
    /// The Mac Ed25519 private key, PKCS#8 DER.  A descriptor and never a path
    /// or an environment variable: plan 238 puts the key at mode 0400 owned by
    /// `_wtcompare`, outside every root this supervisor owns, so the launcher
    /// opens it and this process inherits an open file and no way to name it.
    mac_signing_key_fd: i32,
    /// The staged **rig public** key.  The descriptor that makes §2.9's
    /// security property true: without it this process could not tell a rig
    /// receipt from a controller's forgery, and every one of the five §2.9(5)
    /// attacks would succeed.
    staged_rig_public_key_fd: i32,
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
fn mac_cohort_install_descriptors(
    args: &[String],
) -> Result<Option<MacCohortInstallDescriptors>, &'static str> {
    const NAMES: [&str; 2] = [
        "--cohort-mac-signing-key-fd",
        "--cohort-staged-rig-public-key-fd",
    ];
    let mut resolved = [0i32; 2];
    let mut present = 0usize;
    for (slot, name) in NAMES.iter().enumerate() {
        match optional_descriptor_option(args, name)? {
            Some(fd) => {
                resolved[slot] = fd;
                present += 1;
            }
            None => resolved[slot] = -1,
        }
    }
    if present == 0 {
        return Ok(None);
    }
    if present != NAMES.len() {
        return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
    }
    for (position, number) in resolved.iter().enumerate() {
        if resolved[position + 1..].contains(number) {
            return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
        }
    }
    Ok(Some(MacCohortInstallDescriptors {
        mac_signing_key_fd: resolved[0],
        staged_rig_public_key_fd: resolved[1],
    }))
}

/// Read a whole descriptor under a cap charged before the read allocates.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
fn read_all_from_fd(fd: i32, cap: usize) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        // SAFETY: reads into a local buffer from a descriptor this process owns.
        let read = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
        if read < 0 {
            return Err("TRUST_PROTOCOL");
        }
        if read == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&chunk[..read as usize]);
        if out.len() > cap {
            return Err("TRUST_RECORD_OVERSIZE");
        }
    }
}

/// A digest naming the clock epoch this host is currently running on.
///
/// `linuxClockId` has to identify the monotonic clock the baseline and the
/// final snapshot were read on, and the one thing that actually changes when
/// that clock restarts is the boot session.  Reading it is the supervisor's
/// own observation; a launcher-supplied label would be a value the launcher
/// could keep constant across a reboot that invalidated every ns reading.
#[cfg(target_os = "linux")]
#[cfg_attr(not(test), allow(dead_code))]
fn observe_clock_identity() -> Result<String, &'static str> {
    let path =
        std::ffi::CString::new("/proc/sys/kernel/random/boot_id").map_err(|_| "TRUST_PROTOCOL")?;
    // SAFETY: opens a well-known read-only procfs leaf.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err("TRUST_PROTOCOL");
    }
    let bytes = read_all_from_fd(fd, 4096);
    // SAFETY: closes the descriptor this function opened.
    unsafe {
        let _ = libc::close(fd);
    }
    let bytes = bytes?;
    let trimmed = bytes
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<u8>>();
    if trimmed.is_empty() {
        return Err("TRUST_PROTOCOL");
    }
    Ok(sha256_hex(&trimmed))
}

#[cfg(target_os = "macos")]
#[cfg_attr(not(test), allow(dead_code))]
fn observe_clock_identity() -> Result<String, &'static str> {
    let name = std::ffi::CString::new("kern.bootsessionuuid").map_err(|_| "TRUST_PROTOCOL")?;
    let mut buf = [0u8; 128];
    let mut len = buf.len();
    // SAFETY: sysctlbyname writes at most `len` bytes into the local buffer.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || len == 0 {
        return Err("TRUST_PROTOCOL");
    }
    let trimmed = buf[..len]
        .iter()
        .copied()
        .filter(|byte| *byte != 0 && !byte.is_ascii_whitespace())
        .collect::<Vec<u8>>();
    if trimmed.is_empty() {
        return Err("TRUST_PROTOCOL");
    }
    Ok(sha256_hex(&trimmed))
}

// --- the server child's control pipe, from the rig's end -------------------

/// §3.4's rig<->server codec: `u32be payloadLength || canonical JSON bytes`,
/// one independent sequence per direction, 32 frames each way.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
struct ServerChildPipe {
    /// Parent end of the child's FD 4.
    read_fd: i32,
    /// Parent end of the child's FD 3.
    write_fd: i32,
    pending: Vec<u8>,
    outbound_sequence: u64,
    inbound_sequence: u64,
    execution_sha256: String,
}

#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
impl ServerChildPipe {
    const MAX_FRAME_BYTES: usize = 64 * 1024;
    const MAX_FRAMES_PER_DIRECTION: u64 = 32;

    /// A new R->C record with the two fields every §3.4 frame carries.
    ///
    /// `sequence` is added by `send`, from this channel's own counter.
    fn frame(&self, schema: &str) -> serde_json::Map<String, serde_json::Value> {
        let mut record = serde_json::Map::new();
        record.insert("schema".to_owned(), serde_json::Value::from(schema));
        record.insert(
            "executionSha256".to_owned(),
            serde_json::Value::from(self.execution_sha256.clone()),
        );
        record
    }

    /// The R->C sequence the next outbound frame will carry.
    fn outbound_sequence(&self) -> u64 {
        self.outbound_sequence
    }

    /// The C->R sequence the next inbound frame must carry.
    fn inbound_sequence(&self) -> u64 {
        self.inbound_sequence
    }

    fn send(
        &mut self,
        mut record: serde_json::Map<String, serde_json::Value>,
    ) -> Result<Vec<u8>, &'static str> {
        if self.outbound_sequence >= Self::MAX_FRAMES_PER_DIRECTION {
            return Err("SEQUENCE_INVALID");
        }
        record.insert(
            "sequence".to_owned(),
            serde_json::Value::from(self.outbound_sequence),
        );
        let bytes = secure_fs::cohort::canonical_bytes(&serde_json::Value::Object(record))
            .map_err(|_| "FRAME_INVALID")?;
        if bytes.len() > Self::MAX_FRAME_BYTES {
            return Err("FRAME_INVALID");
        }
        let mut framed = Vec::with_capacity(4 + bytes.len());
        framed.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        framed.extend_from_slice(&bytes);
        write_all_to_fd(self.write_fd, &framed)?;
        self.outbound_sequence += 1;
        Ok(bytes)
    }

    /// One inbound frame, its schema and sequence checked before its fields.
    fn receive(
        &mut self,
        expected_schema: &str,
    ) -> Result<(Vec<u8>, serde_json::Value), &'static str> {
        loop {
            if self.pending.len() >= 4 {
                let declared = u32::from_be_bytes([
                    self.pending[0],
                    self.pending[1],
                    self.pending[2],
                    self.pending[3],
                ]) as usize;
                if declared > Self::MAX_FRAME_BYTES {
                    return Err("FRAME_INVALID");
                }
                if self.pending.len() >= 4 + declared {
                    let body: Vec<u8> = self.pending[4..4 + declared].to_vec();
                    self.pending.drain(..4 + declared);
                    return self.admit(expected_schema, body);
                }
            }
            let mut chunk = [0u8; 4096];
            // SAFETY: reads into a local buffer from a descriptor this process owns.
            let read = unsafe { libc::read(self.read_fd, chunk.as_mut_ptr().cast(), chunk.len()) };
            if read < 0 {
                return Err("CHILD_LIFECYCLE");
            }
            if read == 0 {
                return Err("UNEXPECTED_EOF");
            }
            self.pending.extend_from_slice(&chunk[..read as usize]);
        }
    }

    fn admit(
        &mut self,
        expected_schema: &str,
        body: Vec<u8>,
    ) -> Result<(Vec<u8>, serde_json::Value), &'static str> {
        if self.inbound_sequence >= Self::MAX_FRAMES_PER_DIRECTION {
            return Err("SEQUENCE_INVALID");
        }
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| "FRAME_INVALID")?;
        // The digest the rig carries onward is over these exact bytes, so the
        // frame has to be the canonical encoding of what it decodes to; a
        // re-encode that differs is a second record wearing the first's digest.
        let reencoded = secure_fs::cohort::canonical_bytes(&value).map_err(|_| "FRAME_INVALID")?;
        if reencoded != body {
            return Err("FRAME_INVALID");
        }
        let map = value.as_object().ok_or("FRAME_INVALID")?;
        if map.get("schema").and_then(serde_json::Value::as_str) != Some(expected_schema) {
            return Err("STATE_INVALID");
        }
        if map.get("sequence").and_then(serde_json::Value::as_u64) != Some(self.inbound_sequence) {
            return Err("SEQUENCE_INVALID");
        }
        if map
            .get("executionSha256")
            .and_then(serde_json::Value::as_str)
            != Some(self.execution_sha256.as_str())
        {
            return Err("EXECUTION_MISMATCH");
        }
        self.inbound_sequence += 1;
        Ok((body, value))
    }

    fn close(&mut self) {
        for fd in [self.read_fd, self.write_fd] {
            if fd >= 0 {
                // SAFETY: closes a descriptor this process owns.
                unsafe {
                    let _ = libc::close(fd);
                }
            }
        }
        self.read_fd = -1;
        self.write_fd = -1;
    }
}

#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
fn write_all_to_fd(fd: i32, bytes: &[u8]) -> Result<(), &'static str> {
    let mut written = 0usize;
    while written < bytes.len() {
        // SAFETY: writes from a local buffer to a descriptor this process owns.
        let count =
            unsafe { libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written) };
        if count <= 0 {
            return Err("CHILD_LIFECYCLE");
        }
        written += count as usize;
    }
    Ok(())
}

/// The live server child, shared between the spawner that creates it and the
/// channel that talks to it.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
type SharedServerChild = std::rc::Rc<std::cell::RefCell<Option<ServerChildPipe>>>;

/// Fork/exec the staged server child and complete §5's BIND transition.
///
/// The spawner owns the fork and the descriptors; the session owns the
/// decision that there is a grant to spawn against.  The bind frame carries
/// the grant and the Mac's signature over its exact bytes, because the child
/// verifies both against its own staged copy of the Mac key before it binds.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
struct StagedServerSpawner {
    bun_path: std::ffi::CString,
    role_root_fd: i32,
    /// The rig's own staging root, pinned at bootstrap.  The two staged TLS
    /// leaves the launch record binds by digest are read through it at every
    /// spawn, so the identity the child serves is the staged one and never a
    /// path this process resolved or a value it was handed.
    staging_root_fd: i32,
    staged_mac_public_base64: String,
    linux_clock_id: String,
    child: SharedServerChild,
}

/// The staged TLS leaves (`STAGED_SERVER_TLS_*_LEAF`, `cohort-protocol.ts`).
#[cfg(unix)]
const STAGED_SERVER_TLS_CERTIFICATE_LEAF: &str = "staged-server-tls.crt";
#[cfg(unix)]
const STAGED_SERVER_TLS_PRIVATE_KEY_LEAF: &str = "staged-server-tls.key";
/// The three names the child reads its TLS identity from
/// (`tools/compare/server.ts`, `FANOUT_COHORT_SERVER_ENV_NAMES`).
#[cfg(unix)]
const TLS_ENV_PREFIX: &str = "WS_WT_TLS_";

#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
impl StagedServerSpawner {
    /// The child's whole environment: the supervisor's three cohort
    /// observations, the staged TLS identity the launch record binds, and
    /// `allowedEnvironment` off that same record, whose digest the spawn
    /// request already bound.  Nothing from this process's own environment
    /// reaches the child, and a record that restated a supervisor-owned name
    /// -- a cohort observation or a TLS value -- is refused rather than
    /// obeyed: it would be choosing the key the child trusts or the identity
    /// it serves.
    fn child_environment(
        &self,
        launch_record: &[u8],
        receipt_validity_ms: u64,
    ) -> Result<Vec<std::ffi::CString>, secure_fs::cohort::CohortRefusal> {
        use secure_fs::cohort::CohortRefusal;
        use secure_fs::SecureFsSyscalls as _;

        let value: serde_json::Value =
            serde_json::from_slice(launch_record).map_err(|_| CohortRefusal::Malformed)?;
        let record = value.as_object().ok_or(CohortRefusal::Malformed)?;
        let text = |key: &'static str| -> Result<&str, CohortRefusal> {
            record
                .get(key)
                .ok_or(CohortRefusal::MissingField(key))?
                .as_str()
                .ok_or(CohortRefusal::SchemaInvalid)
        };
        let digest = |key: &'static str| -> Result<&str, CohortRefusal> {
            let value = text(key)?;
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err(CohortRefusal::SchemaInvalid);
            }
            Ok(value)
        };
        let tls_server_name = text("tlsServerName")?;
        if tls_server_name.is_empty() {
            return Err(CohortRefusal::SchemaInvalid);
        }
        let certificate_sha256 = digest("tlsCertificateSha256")?;
        let private_key_sha256 = digest("tlsPrivateKeySha256")?;

        // Both leaves through the pinned root: no-follow, regular, read-only,
        // re-stat'd after the read.  The digest the record states is the
        // binding; a leaf that hashes to anything else is another identity.
        let mut syscalls = secure_fs::LibcSyscalls::new();
        let mut staged_leaf = |leaf: &str, expected: &str, field: &'static str| {
            let pinned = secure_fs::supervisor::bootstrap::read_record_through_pinned_handle(
                syscalls.engine(),
                self.staging_root_fd,
                leaf,
                "TRUST_RECORD_HANDLE_INVALID",
            )
            .map_err(|_| CohortRefusal::NotReady("staged tls leaf"))?;
            if pinned.sha256 != expected {
                return Err(CohortRefusal::BindingMismatch(field));
            }
            String::from_utf8(pinned.bytes).map_err(|_| CohortRefusal::SchemaInvalid)
        };
        let certificate_pem = staged_leaf(
            STAGED_SERVER_TLS_CERTIFICATE_LEAF,
            certificate_sha256,
            "tlsCertificateSha256",
        )?;
        let private_key_pem = staged_leaf(
            STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
            private_key_sha256,
            "tlsPrivateKeySha256",
        )?;

        let mut out = vec![
            format!(
                "WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64={}",
                self.staged_mac_public_base64
            ),
            format!("WS_WT_COHORT_LINUX_CLOCK_ID={}", self.linux_clock_id),
            format!("WS_WT_COHORT_RECEIPT_VALIDITY_MS={receipt_validity_ms}"),
            format!("{TLS_ENV_PREFIX}CERT_CONTENT={certificate_pem}"),
            format!("{TLS_ENV_PREFIX}KEY_CONTENT={private_key_pem}"),
            format!("{TLS_ENV_PREFIX}SERVER_NAME={tls_server_name}"),
        ];
        if let Some(entries) = record
            .get("allowedEnvironment")
            .and_then(serde_json::Value::as_array)
        {
            for entry in entries {
                let name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(CohortRefusal::Malformed)?;
                let val = entry
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(CohortRefusal::Malformed)?;
                if name.starts_with("WS_WT_COHORT_") || name.starts_with(TLS_ENV_PREFIX) {
                    return Err(CohortRefusal::BindingMismatch("allowedEnvironment"));
                }
                out.push(format!("{name}={val}"));
            }
        }
        out.into_iter()
            .map(|entry| std::ffi::CString::new(entry).map_err(|_| CohortRefusal::Malformed))
            .collect()
    }

    fn fork_child(
        &self,
        request: &secure_fs::cohort::rig::SpawnServerRequest,
        environment: &[std::ffi::CString],
    ) -> Result<(i32, ServerChildPipe), &'static str> {
        let mut to_child = [0i32; 2];
        let mut from_child = [0i32; 2];
        // SAFETY: both calls write exactly two descriptors into local arrays.
        if unsafe { libc::pipe(to_child.as_mut_ptr()) } != 0
            || unsafe { libc::pipe(from_child.as_mut_ptr()) } != 0
        {
            return Err("PROCESS_RESOURCE_EXHAUSTED");
        }
        let mut argv: Vec<std::ffi::CString> = Vec::with_capacity(request.server_argv.len() + 3);
        argv.push(self.bun_path.clone());
        argv.push(std::ffi::CString::new("run").map_err(|_| "TRUST_PROTOCOL")?);
        for arg in &request.server_argv {
            argv.push(std::ffi::CString::new(arg.as_str()).map_err(|_| "TRUST_PROTOCOL")?);
        }
        // The port is the one the signed spawn request names, restated as the
        // flag the entrypoint parses. The record chose it; this only spells it.
        argv.push(
            std::ffi::CString::new(format!("--port={}", request.bind_port))
                .map_err(|_| "TRUST_PROTOCOL")?,
        );

        // SAFETY: fork with no allocation between fork and exec in the child.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err("PROCESS_RESOURCE_EXHAUSTED");
        }
        if pid == 0 {
            // Child. Everything below is async-signal-safe or exits.
            unsafe {
                // Its own process group, so the reaper can `killpg` exactly
                // this child and its descendants. `setpgid` rather than
                // `setsid` because the parent races it below with the same
                // call: whichever wins, the group id is the child's pid, and
                // the parent never observes a window where it is not.
                if libc::setpgid(0, 0) != 0 {
                    libc::_exit(120);
                }
                if libc::fchdir(self.role_root_fd) != 0 {
                    libc::_exit(121);
                }
                libc::close(to_child[1]);
                libc::close(from_child[0]);
                // The child inherits this supervisor's stdin/stdout, which on
                // the rig *are* the controller's frame channel. A `console.log`
                // in the entrypoint would land in the middle of a frame, so
                // both are replaced before exec. Stderr is left alone: the
                // child's diagnostics are the only thing a refused spawn has
                // to say.
                let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                if null < 0 {
                    libc::_exit(124);
                }
                if libc::dup2(null, 0) != 0 || libc::dup2(null, 1) != 1 {
                    libc::_exit(125);
                }
                if null > 2 {
                    libc::close(null);
                }
                if libc::dup2(to_child[0], 3) != 3 || libc::dup2(from_child[1], 4) != 4 {
                    libc::_exit(122);
                }
                if to_child[0] != 3 {
                    libc::close(to_child[0]);
                }
                if from_child[1] != 4 {
                    libc::close(from_child[1]);
                }
                // FD 3 and FD 4 must survive exec; nothing else the parent
                // held may.
                libc::fcntl(3, libc::F_SETFD, 0);
                libc::fcntl(4, libc::F_SETFD, 0);
                let mut argv_ptrs: Vec<*const libc::c_char> =
                    argv.iter().map(|arg| arg.as_ptr()).collect();
                argv_ptrs.push(std::ptr::null());
                let mut env_ptrs: Vec<*const libc::c_char> =
                    environment.iter().map(|entry| entry.as_ptr()).collect();
                env_ptrs.push(std::ptr::null());
                libc::execve(
                    self.bun_path.as_ptr(),
                    argv_ptrs.as_ptr().cast(),
                    env_ptrs.as_ptr().cast(),
                );
                libc::_exit(123);
            }
        }
        // Parent.
        // SAFETY: closes the two ends the child owns, and closes the
        // process-group race with the child's own `setpgid`.
        unsafe {
            let _ = libc::close(to_child[0]);
            let _ = libc::close(from_child[1]);
            let _ = libc::setpgid(pid, pid);
        }
        Ok((
            pid,
            ServerChildPipe {
                read_fd: from_child[0],
                write_fd: to_child[1],
                pending: Vec::new(),
                outbound_sequence: 0,
                inbound_sequence: 0,
                execution_sha256: request.execution_sha256.clone(),
            },
        ))
    }
}

#[cfg(unix)]
impl secure_fs::cohort::rig::ServerSpawner for StagedServerSpawner {
    fn spawn(
        &mut self,
        request: &secure_fs::cohort::rig::SpawnServerRequest,
    ) -> Result<secure_fs::cohort::rig::SpawnedServerChild, secure_fs::cohort::CohortRefusal> {
        use base64::Engine as _;
        use secure_fs::cohort::CohortRefusal;

        if self.child.borrow().is_some() {
            return Err(CohortRefusal::NotReady("one server child per cohort"));
        }
        // The environment is assembled -- and every staged TLS digest checked
        // -- before the fork, so a refused record refuses with its own code
        // and never as a child that failed to start.
        let environment =
            self.child_environment(&request.staged_launch_record, request.receipt_validity_ms)?;
        let (pid, mut pipe) = self
            .fork_child(request, &environment)
            .map_err(|_| CohortRefusal::ChildLifecycle("server child spawn"))?;
        // SAFETY: reads the group of a child this process just forked.
        let pgid = unsafe { libc::getpgid(pid) };
        if pgid != pid {
            // The child was put in its own session, so it leads its own group.
            // Anything else means the group this supervisor would reap is not
            // the one it created.
            pipe.close();
            return Err(CohortRefusal::ChildLifecycle("server child process group"));
        }
        let engine = base64::engine::general_purpose::STANDARD;
        let mut bind = serde_json::Map::new();
        bind.insert(
            "schema".to_owned(),
            serde_json::Value::from("server-bind-execution/v1"),
        );
        bind.insert(
            "executionSha256".to_owned(),
            serde_json::Value::from(request.execution_sha256.clone()),
        );
        bind.insert(
            "rigExecutionAcceptanceSha256".to_owned(),
            serde_json::Value::from(request.rig_execution_acceptance_sha256.clone()),
        );
        bind.insert(
            "cohortGrantBase64".to_owned(),
            serde_json::Value::from(engine.encode(&request.cohort_grant)),
        );
        bind.insert(
            "cohortGrantSignatureBase64".to_owned(),
            serde_json::Value::from(engine.encode(&request.cohort_grant_signature_record)),
        );
        let outcome = (|| -> Result<secure_fs::cohort::rig::SpawnedServerChild, &'static str> {
            pipe.send(bind)?;
            let (ready_bytes, ready) = pipe.receive("server-ready/v1")?;
            let map = ready.as_object().ok_or("FRAME_INVALID")?;
            let text = |key: &str| -> Result<String, &'static str> {
                map.get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .ok_or("FRAME_INVALID")
            };
            let number = |key: &str| -> Result<i64, &'static str> {
                map.get(key)
                    .and_then(serde_json::Value::as_i64)
                    .ok_or("FRAME_INVALID")
            };
            // The child states its pid and group; the supervisor forked them,
            // so a disagreement is the child describing some other process.
            if number("childPid")? != pid as i64 || number("childPgid")? != pgid as i64 {
                return Err("CHILD_LIFECYCLE");
            }
            if text("cohortGrantSha256")? != request.cohort_grant_sha256 {
                return Err("COHORT_MISMATCH");
            }
            let _ = text("listeningAddress")?;
            Ok(secure_fs::cohort::rig::SpawnedServerChild {
                pid,
                pgid,
                instance_nonce_sha256: text("childInstanceNonce")?,
                ready_frame_sha256: sha256_hex(&ready_bytes),
            })
        })();
        match outcome {
            Ok(child) => {
                *self.child.borrow_mut() = Some(pipe);
                Ok(child)
            }
            Err(_) => {
                pipe.close();
                Err(CohortRefusal::ChildLifecycle("server child bind"))
            }
        }
    }
}

/// The live server child's half of the §5 warmup and barrier transitions.
///
/// Only IN_REPETITION_WARMUP's first step is implemented: the drain, the
/// baseline and the barrier all report counters the fanout relay owns, and no
/// relay is wired into the server child yet.  Each of those refuses
/// `COHORT_NOT_READY` rather than answering with a record nobody measured —
/// the same discipline `AbsentServerChild` keeps, narrowed to the transitions
/// that are actually missing.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
struct LiveServerChild {
    child: SharedServerChild,
}

#[cfg(unix)]
impl secure_fs::cohort::rig::ServerChildChannel for LiveServerChild {
    fn warmup_start(
        &mut self,
        epoch_bytes: &[u8],
        epoch_signature_record: &[u8],
    ) -> Result<Vec<u8>, secure_fs::cohort::CohortRefusal> {
        use base64::Engine as _;
        use secure_fs::cohort::CohortRefusal;

        let mut borrowed = self.child.borrow_mut();
        let pipe = borrowed
            .as_mut()
            .ok_or(CohortRefusal::NotReady("server child control channel"))?;
        let engine = base64::engine::general_purpose::STANDARD;
        let mut start = serde_json::Map::new();
        start.insert(
            "schema".to_owned(),
            serde_json::Value::from("server-warmup-start/v1"),
        );
        start.insert(
            "executionSha256".to_owned(),
            serde_json::Value::from(pipe.execution_sha256.clone()),
        );
        start.insert(
            "cohortWarmupEpochBase64".to_owned(),
            serde_json::Value::from(engine.encode(epoch_bytes)),
        );
        // The Mac's own signature record, exactly as it arrived. The rig has
        // already verified it against the staged Mac key; forwarding the bytes
        // rather than a re-mint is what lets the child check the same
        // signature over the same epoch.
        start.insert(
            "cohortWarmupEpochSignatureBase64".to_owned(),
            serde_json::Value::from(engine.encode(epoch_signature_record)),
        );
        pipe.send(start)
            .map_err(|_| CohortRefusal::ChildLifecycle("server warmup start"))?;
        let (ready_bytes, _) = pipe
            .receive("server-warmup-ready/v1")
            .map_err(|_| CohortRefusal::ChildLifecycle("server warmup ready"))?;
        Ok(ready_bytes)
    }

    fn drain_warmup(
        &mut self,
        cohort_warmup_epoch_sha256: &str,
        manifest_bytes: &[u8],
    ) -> Result<Vec<u8>, secure_fs::cohort::CohortRefusal> {
        use secure_fs::cohort::CohortRefusal;
        let mut borrowed = self.child.borrow_mut();
        let pipe = borrowed
            .as_mut()
            .ok_or(CohortRefusal::NotReady("server child control channel"))?;
        let mut record = pipe.frame("server-warmup-drain-and-reset/v1");
        record.insert(
            "cohortWarmupEpochSha256".to_owned(),
            serde_json::Value::from(cohort_warmup_epoch_sha256),
        );
        // The manifest is carried by digest, not by value: the child checks the
        // drain against the manifest the rig already authenticated, and the
        // 64 KiB frame bound is not where a 256 KiB manifest belongs.
        record.insert(
            "roleWarmupCompletionManifestSha256".to_owned(),
            serde_json::Value::from(sha256_hex(manifest_bytes)),
        );
        pipe.send(record)
            .map_err(|_| CohortRefusal::ChildLifecycle("server warmup drain"))?;
        let (drained, _) = pipe
            .receive("server-warmup-drained/v1")
            .map_err(|_| CohortRefusal::ChildLifecycle("server warmup drained"))?;
        Ok(drained)
    }

    fn measure_start_baseline(
        &mut self,
        warmup_complete_sha256: &str,
    ) -> Result<secure_fs::cohort::rig::ChildBaseline, secure_fs::cohort::CohortRefusal> {
        use secure_fs::cohort::CohortRefusal;
        let mut borrowed = self.child.borrow_mut();
        let pipe = borrowed
            .as_mut()
            .ok_or(CohortRefusal::NotReady("server child control channel"))?;
        let mut record = pipe.frame("server-measure-start/v1");
        record.insert(
            "warmupCompleteSha256".to_owned(),
            serde_json::Value::from(warmup_complete_sha256),
        );
        pipe.send(record)
            .map_err(|_| CohortRefusal::ChildLifecycle("server measure start"))?;
        // The sequence the ack arrives on is the rig's own count, read before
        // `receive` advances it. §2.11 puts it in the signed receipt, so it
        // must never be a number the child stated.
        let response_sequence = pipe.inbound_sequence();
        let (_, value) = pipe
            .receive("server-measure-start-ack/v1")
            .map_err(|_| CohortRefusal::ChildLifecycle("server measure start ack"))?;
        let map = value
            .as_object()
            .ok_or(CohortRefusal::ChildLifecycle("server measure start ack"))?;
        // Every number a cohort record carries is a nonnegative integer
        // (`cohort::canonical_bytes` refuses the rest at encode time), and this
        // baseline is carried verbatim into `rig-measure-start-ack/v1`.
        // A fractional millisecond count is refused here rather than
        // discovered when the receipt fails to encode.
        let busy_ms = map
            .get("baselineBusyMs")
            .and_then(serde_json::Value::as_u64)
            .ok_or(CohortRefusal::SchemaInvalid)?;
        let at_linux_ns = map
            .get("baselineAtLinuxNs")
            .and_then(serde_json::Value::as_str)
            .and_then(|text| text.parse::<u64>().ok())
            .ok_or(CohortRefusal::SchemaInvalid)?;
        if map
            .get("linuxClockId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .is_empty()
        {
            return Err(CohortRefusal::SchemaInvalid);
        }
        Ok(secure_fs::cohort::rig::ChildBaseline {
            busy_ms,
            at_linux_ns,
            response_sequence,
        })
    }

    fn present_start_barrier(
        &mut self,
        barrier_bytes: &[u8],
        barrier_signature_record: &[u8],
    ) -> Result<Vec<u8>, secure_fs::cohort::CohortRefusal> {
        use base64::Engine as _;
        use secure_fs::cohort::CohortRefusal;
        let mut borrowed = self.child.borrow_mut();
        let pipe = borrowed
            .as_mut()
            .ok_or(CohortRefusal::NotReady("server child control channel"))?;
        let engine = base64::engine::general_purpose::STANDARD;
        let mut record = pipe.frame("server-present-start-barrier/v1");
        record.insert(
            "cohortStartBarrierBase64".to_owned(),
            serde_json::Value::from(engine.encode(barrier_bytes)),
        );
        record.insert(
            "cohortStartBarrierSignatureBase64".to_owned(),
            serde_json::Value::from(engine.encode(barrier_signature_record)),
        );
        pipe.send(record)
            .map_err(|_| CohortRefusal::ChildLifecycle("server present start barrier"))?;
        let (accepted, _) = pipe
            .receive("server-start-barrier-accepted/v1")
            .map_err(|_| CohortRefusal::ChildLifecycle("server start barrier accepted"))?;
        Ok(accepted)
    }

    fn stop_and_capture(
        &mut self,
        cohort_start_barrier_sha256: &str,
        drain_deadline_ms: u64,
    ) -> Result<secure_fs::cohort::rig::ChildCapture, secure_fs::cohort::CohortRefusal> {
        use secure_fs::cohort::CohortRefusal;
        let mut borrowed = self.child.borrow_mut();
        let pipe = borrowed
            .as_mut()
            .ok_or(CohortRefusal::NotReady("server child control channel"))?;
        let mut record = pipe.frame("server-stop-and-capture/v1");
        record.insert(
            "cohortStartBarrierSha256".to_owned(),
            serde_json::Value::from(cohort_start_barrier_sha256),
        );
        record.insert(
            "drainDeadlineMs".to_owned(),
            serde_json::Value::from(drain_deadline_ms),
        );
        let request_sequence = pipe.outbound_sequence();
        pipe.send(record)
            .map_err(|_| CohortRefusal::ChildLifecycle("server stop and capture"))?;
        let response_sequence = pipe.inbound_sequence();
        let (capture_ack, _) = pipe
            .receive("server-capture-ack/v1")
            .map_err(|_| CohortRefusal::ChildLifecycle("server capture ack"))?;
        Ok(secure_fs::cohort::rig::ChildCapture {
            capture_ack,
            request_sequence,
            response_sequence,
        })
    }

    fn teardown(&mut self) -> Result<Vec<u8>, secure_fs::cohort::CohortRefusal> {
        use secure_fs::cohort::CohortRefusal;
        let mut borrowed = self.child.borrow_mut();
        let pipe = borrowed
            .as_mut()
            .ok_or(CohortRefusal::NotReady("server child control channel"))?;
        let record = pipe.frame("server-teardown/v1");
        pipe.send(record)
            .map_err(|_| CohortRefusal::ChildLifecycle("server teardown"))?;
        let stopped = pipe
            .receive("server-stopped/v1")
            .map(|(bytes, _)| bytes)
            .map_err(|_| CohortRefusal::ChildLifecycle("server stopped"));
        // The control channel is closed whichever way the child answered: a
        // supervisor that kept an FD open onto a child it just told to stop
        // would be holding the pipe the reap has to see close.
        pipe.close();
        let stopped = stopped?;
        *borrowed = None;
        Ok(stopped)
    }
}

/// Build this execution's cohort runtime out of the staged inputs and install
/// it, once, before the resident loop reads its first frame.
///
/// Every input here is either a descriptor the launcher opened or a leaf under
/// a root the trust bootstrap already took ownership of.  Nothing arrives on a
/// frame: a controller that could name the signing key, the Mac key, or the
/// execution binding would be choosing what its own cohort is checked against.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
fn install_production_cohort_runtime(
    resident: &mut ResidentLoop,
    staging_root_fd: i32,
    descriptors: &CohortInstallDescriptors,
    bun_path: &std::ffi::OsStr,
) -> Result<(), &'static str> {
    use base64::Engine as _;
    use secure_fs::cohort::rig;
    use secure_fs::SecureFsSyscalls;

    let private_pkcs8_der = read_all_from_fd(descriptors.signing_key_fd, 4_096)?;
    let public_raw32 = secure_fs::cross_supervisor::public_raw32_from_pkcs8_der(&private_pkcs8_der)
        .map_err(|_| "TRUST_SIGNING_KEY_ARGUMENT_INVALID")?;
    // §2.13: no acceptance is read here. It arrives on
    // `rig-accept-cohort-request/v1`, once per execution, and is authenticated
    // against the key derived from the private half above — the same
    // derivation, at a later moment.

    // The Mac key is a leaf of the staging root this supervisor owns, read
    // through the same pinned handle every other trust record is.
    let mut syscalls = secure_fs::LibcSyscalls::new();
    let staged_mac = secure_fs::supervisor::bootstrap::read_record_through_pinned_handle(
        syscalls.engine(),
        staging_root_fd,
        secure_fs::cross_supervisor::MAC_PUBLIC_LEAF,
        "TRUST_RECORD_HANDLE_INVALID",
    )?;
    let staged_mac_public_raw32: [u8; 32] = staged_mac
        .bytes
        .as_slice()
        .try_into()
        .map_err(|_| "TRUST_RECORD_MALFORMED")?;

    let linux_clock_id = observe_clock_identity()?;
    // §5 RIG_EXECUTION_ACCEPTED states this process's own name and image on
    // every acceptance: the nonce is derived the way the Mac's is (something
    // that changes when the process does), the image digest is observed.
    let instance_nonce_sha256 =
        sha256_hex(format!("rig-supervisor/{}/{linux_clock_id}", std::process::id()).as_bytes());
    let executable_sha256 = observe_executable_sha256()?;
    let runtime = rig::RigCohortRuntime::new(
        private_pkcs8_der,
        public_raw32,
        staged_mac_public_raw32,
        &linux_clock_id,
        &instance_nonce_sha256,
        &executable_sha256,
    )
    .map_err(|refusal| refusal.code())?;

    let child: SharedServerChild = std::rc::Rc::new(std::cell::RefCell::new(None));
    let spawner = StagedServerSpawner {
        bun_path: std::ffi::CString::new(bun_path.as_encoded_bytes())
            .map_err(|_| "TRUST_PROTOCOL")?,
        role_root_fd: descriptors.role_root_fd,
        staging_root_fd,
        staged_mac_public_base64: base64::engine::general_purpose::STANDARD
            .encode(staged_mac_public_raw32),
        linux_clock_id,
        child: std::rc::Rc::clone(&child),
    };
    resident.install_cohort_runtime(CohortRuntime {
        runtime,
        spawner: Box::new(spawner),
        child: Box::new(LiveServerChild { child }),
    })
}

/// Build the campaign's Mac cohort runtime out of the two descriptors and
/// install it, once, before the resident loop reads its first frame.
///
/// The public half of the signing key is **derived** here rather than
/// supplied: `MacIdentity::new` runs `public_raw32_from_pkcs8_der` over the
/// bytes on the descriptor, so a launcher cannot hand this process a public
/// key that disagrees with the private one it signs under.  The instance nonce
/// and the clock identity are this process's own observations, the rule
/// `observe_clock_identity()` established for the rig.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
fn install_production_mac_cohort_runtime(
    resident: &mut ResidentLoop,
    descriptors: &MacCohortInstallDescriptors,
    receipt_validity_ms: u64,
    authority: &ExecutionAuthority,
) -> Result<(), &'static str> {
    use secure_fs::cohort::mac;

    let private_pkcs8_der = read_all_from_fd(descriptors.mac_signing_key_fd, 4_096)?;
    let staged_rig_public = read_all_from_fd(descriptors.staged_rig_public_key_fd, 4_096)?;
    let staged_rig_public_raw32: [u8; 32] = staged_rig_public
        .as_slice()
        .try_into()
        .map_err(|_| "TRUST_RECORD_MALFORMED")?;
    let mac_clock_id = observe_clock_identity()?;
    // The nonce names this process, so it is derived from something that
    // changes when the process does rather than from anything on a descriptor.
    let instance_nonce_sha256 =
        sha256_hex(format!("mac-supervisor/{}/{mac_clock_id}", std::process::id()).as_bytes());
    let mut runtime = mac::MacCohortRuntime::new(
        private_pkcs8_der,
        staged_rig_public_raw32,
        &instance_nonce_sha256,
        &mac_clock_id,
        receipt_validity_ms,
    )
    .map_err(|refusal| refusal.code())?;
    // C2: the validated authority's approval digests, and this process's own
    // executable digest — the two campaign-scoped inputs every Phase-A
    // receipt states and no frame may supply.
    runtime
        .set_campaign_authority(
            &authority.approved_plan_sha256,
            &authority.approval_record_sha256,
        )
        .map_err(|refusal| refusal.code())?;
    runtime
        .set_supervisor_executable_sha256(&observe_executable_sha256()?)
        .map_err(|refusal| refusal.code())?;
    resident.install_mac_cohort_runtime(runtime)
}

/// The digest of this process's own executable image, read through the
/// path the kernel reports for it.  An observation, like the clock identity:
/// nothing on a descriptor or a frame can name a different binary.
#[cfg(unix)]
#[cfg_attr(not(test), allow(dead_code))]
fn observe_executable_sha256() -> Result<String, &'static str> {
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;
    let path = std::env::current_exe().map_err(|_| "TRUST_PROTOCOL")?;
    // The kernel-reported image path may itself be a link the launcher
    // arranged (a `target/release` symlink farm is the common case), so it is
    // followed; what is hashed is still the file the descriptor names, and a
    // substitution after launch changes the digest rather than the path.
    let c_path =
        std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| "TRUST_PROTOCOL")?;
    // SAFETY: NUL-terminated path, frozen flags; the descriptor is owned by
    // the `File` below.
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err("TRUST_PROTOCOL");
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| "TRUST_PROTOCOL")?;
    Ok(sha256_hex(&bytes))
}

/// Open a launch-configured path for reading through one `O_NOFOLLOW|O_CLOEXEC`
/// descriptor.  Everything read afterwards names that descriptor's file: a
/// link planted at the leaf refuses, and no later path lookup can substitute.
#[cfg(unix)]
fn open_read_only_no_follow(path: &std::ffi::OsStr) -> Result<std::fs::File, String> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;
    let c_path =
        std::ffi::CString::new(path.as_bytes()).map_err(|_| "path contains NUL".to_string())?;
    // SAFETY: NUL-terminated path, frozen flags; the descriptor is owned by
    // the returned `File`.
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open {}: {}",
            path.to_string_lossy(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// What a Phase B cohort record has to be checked against.
///
/// The staged Mac public key and the detached signature are inputs rather than
/// fields read out of the record, for the same reason the measurement bracket
/// is: a record must never choose the key it is authenticated under.
/// `subscriber_count` comes from the signed cohort grant, never from the
/// observation whose arithmetic it bounds.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct CohortRecordContext<'a> {
    staged_mac_public_raw32: &'a [u8; 32],
    signature: &'a [u8; 64],
    subscriber_count: u64,
}

/// Recognise and validate one section 4 cohort record, and do nothing with it.
///
/// This is the whole of B1's supervisor surface, deliberately: the binary
/// gains the ability to *name* a Phase B record and refuse a malformed one
/// under the record's own code, and gains no ability to act on one.  Nothing
/// in `serve` routes here directly: the runtime path goes through
/// `cohort::rig::RigCohortSession`, and this stays the pure recogniser.
///
/// Returns the recognised schema on success so a caller can log which record
/// it validated without re-parsing the bytes.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
fn validate_cohort_record(
    schema: &str,
    bytes: &[u8],
    context: &CohortRecordContext<'_>,
) -> Result<&'static str, &'static str> {
    use secure_fs::cohort;
    match schema {
        "cohort-grant/v1" => cohort::CohortGrantV1::parse_signed(
            bytes,
            context.signature,
            context.staged_mac_public_raw32,
        )
        .map(|_| "cohort-grant/v1")
        .map_err(|refusal| refusal.code()),
        "cohort-start-barrier/v1" => cohort::CohortStartBarrierV1::parse_signed(
            bytes,
            context.signature,
            context.staged_mac_public_raw32,
        )
        .map(|_| "cohort-start-barrier/v1")
        .map_err(|refusal| refusal.code()),
        "linux-relay-observation/v1" => {
            cohort::LinuxRelayObservationV1::parse(bytes, context.subscriber_count)
                .map(|_| "linux-relay-observation/v1")
                .map_err(|refusal| refusal.code())
        }
        "ordered-partial-manifest/v1" => cohort::OrderedPartialManifestV1::parse(bytes)
            .map(|_| "ordered-partial-manifest/v1")
            .map_err(|refusal| refusal.code()),
        "token-bundle/v1" => cohort::parse_token_bundle(bytes)
            .map(|_| "token-bundle/v1")
            .map_err(|refusal| refusal.code()),
        // An unrecognised schema is a frame this supervisor does not speak,
        // which is the same answer the serve loop gives an unknown frame kind.
        _ => Err("TRUST_CHILD_FRAME_INVALID"),
    }
}

/// Apply one section 4 record to this supervisor's cohort ownership.
///
/// B1 gave the binary the ability to *name* a cohort record; B3 gives it the
/// ability to act on one, and only in the order `CohortOwner` permits: no
/// grant twice, no barrier before readiness, no second relay observation.
/// Validation is not repeated here — every arm routes into the owner, which
/// parses under the same codec and additionally checks the record against the
/// cohort this supervisor already accepted.
///
/// Records that are not lifecycle transitions (a partial manifest, a token
/// bundle) are validated and nothing more, because they authorise no state
/// change.  Pre-readiness replacement is deliberately *not* reachable from
/// here: it kills a live cohort, and a record arriving on a pipe must not be
/// the thing that decides to do that — the caller calls
/// `CohortOwner::replace_before_ready` with a reaper it owns.
///
/// `serve`'s cohort dispatch reaches the same transitions through
/// `cohort::rig::RigCohortSession`, which owns the receipts as well as the
/// order; this function remains the record-only entry for a caller that holds
/// a bare `CohortOwner`.
///
/// Returns the digest of the exact bytes acted on, so a caller can record
/// which record moved the cohort without re-hashing.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
fn apply_cohort_record(
    owner: &mut secure_fs::cohort::CohortOwner,
    schema: &str,
    bytes: &[u8],
    context: &CohortRecordContext<'_>,
) -> Result<String, &'static str> {
    match schema {
        "cohort-grant/v1" => owner
            .accept_grant(bytes, context.signature, context.staged_mac_public_raw32)
            .map_err(|refusal| refusal.code()),
        "cohort-start-barrier/v1" => owner
            .accept_start_barrier(bytes, context.signature, context.staged_mac_public_raw32)
            .map_err(|refusal| refusal.code()),
        "linux-relay-observation/v1" => owner
            .receipt_relay_observation(bytes)
            .map_err(|refusal| refusal.code()),
        _ => validate_cohort_record(schema, bytes, context)
            .map(|_| secure_fs::cohort::sha256_hex(bytes)),
    }
}

/// The production sink: the admitted series, written into the campaign root
/// this supervisor owns, under a name derived from the execution.
///
/// Exclusive creation, so a second write for one execution fails rather than
/// overwrites, and the descriptor is fsynced before the receipt goes back.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct CampaignRootSink {
    syscalls: secure_fs::LibcSyscalls,
    campaign_root_fd: i32,
}

/// The sink the resident loop commits through on this host.
///
/// The Mac (and the darwin local-acceptance rig) owns a campaign root and
/// writes admitted series into it.  The Linux rig owns no campaign root
/// (2026-08-24 amendment: "the only official campaign output root is the
/// pinned Mac campaign directory"; the rig emits observed records over the
/// control stream and the Mac controller creates the official copies), so a
/// series presented to it has nowhere official to go and is refused as a
/// protocol violation — before any receipt is written, since the receipt is
/// a statement that the series is written.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
enum ResidentSink {
    CampaignRoot(CampaignRootSink),
    NoOfficialRoot,
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
impl ResidentSink {
    fn for_bootstrap(summary: &secure_fs::supervisor::BootstrapSummary) -> Self {
        match summary.campaign_root_fd() {
            Some(campaign_root_fd) => Self::CampaignRoot(CampaignRootSink {
                syscalls: secure_fs::LibcSyscalls::new(),
                campaign_root_fd,
            }),
            None => Self::NoOfficialRoot,
        }
    }
}

#[cfg(not(windows))]
impl secure_fs::measurement::AdmittedSink for ResidentSink {
    fn commit(
        &mut self,
        receipt: &secure_fs::measurement::AdmissionReceipt,
        payload: &[u8],
    ) -> Result<(), &'static str> {
        match self {
            Self::CampaignRoot(sink) => sink.commit(receipt, payload),
            Self::NoOfficialRoot => Err("TRUST_PROTOCOL"),
        }
    }
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
impl secure_fs::measurement::AdmittedSink for CampaignRootSink {
    fn commit(
        &mut self,
        receipt: &secure_fs::measurement::AdmissionReceipt,
        payload: &[u8],
    ) -> Result<(), &'static str> {
        use secure_fs::SecureFsSyscalls;
        let component = format!(
            "execution-{:06}-{}.json",
            receipt.execution.execution_index, receipt.execution.transport
        );
        let engine = self.syscalls.engine();
        let created = engine
            .openat_create_new(
                self.campaign_root_fd,
                &component,
                secure_fs::measurement::EXCLUSIVE_CREATE_FLAGS,
                0o600,
            )
            .map_err(|_| "OUTPUT_FILE_CREATE_FAILED")?;
        let fd = created.fd;
        let mut written = 0usize;
        while written < payload.len() {
            match engine.write(fd, &payload[written..]) {
                Ok(0) => {
                    let _ = engine.close(fd);
                    return Err("OUTPUT_FILE_WRITE_FAILED");
                }
                Ok(count) => written += count,
                Err(_) => {
                    let _ = engine.close(fd);
                    return Err("OUTPUT_FILE_WRITE_FAILED");
                }
            }
        }
        let synced = engine.fsync(fd);
        let closed = engine.close(fd);
        if synced.is_err() || closed.is_err() {
            return Err("OUTPUT_FILE_WRITE_FAILED");
        }
        Ok(())
    }
}

/// The frame channel the resident loop runs over, if the controller handed
/// this supervisor one.
///
/// Optional, and deliberately so: the loop is what admits measurements, and a
/// supervisor invoked to do something else — validate a bootstrap, answer a
/// probe — should not sit waiting on a pipe nobody is writing to.  Absent
/// means "no loop", never "an unguarded loop".
#[cfg(not(windows))]
fn control_descriptors(args: &[String]) -> Option<(i32, i32)> {
    match (
        descriptor_option(args, "--control-in-fd"),
        descriptor_option(args, "--control-out-fd"),
    ) {
        (Ok(read_fd), Ok(write_fd)) if read_fd != write_fd => Some((read_fd, write_fd)),
        _ => None,
    }
}

/// The control channel, read and written through the sealed syscall engine
/// rather than through `std::fs`.
///
/// The boundary's rule is that native filesystem access happens in one place,
/// and a `File` wrapped round an inherited descriptor would be a second one.
/// The engine already owns bounded reads and partial-write handling; this is a
/// `Read`/`Write` shape over it so the frame codec can stay generic.
#[cfg(not(windows))]
struct ControlChannel {
    syscalls: secure_fs::LibcSyscalls,
    fd: i32,
}

#[cfg(not(windows))]
impl std::io::Read for ControlChannel {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        use secure_fs::engine::ReadOutcome;
        use secure_fs::SecureFsSyscalls;
        match self.syscalls.engine().read(self.fd, out.len()) {
            Ok(ReadOutcome::Data(data)) => {
                let count = data.len().min(out.len());
                out[..count].copy_from_slice(&data[..count]);
                Ok(count)
            }
            Ok(ReadOutcome::Eof) => Ok(0),
            // The engine reports a read that returned nothing without ending
            // the stream; treating it as a clean end would silently truncate a
            // session, so it is an error.
            Ok(ReadOutcome::ZeroProgress) | Err(_) => {
                Err(std::io::Error::other("TRUST_CHILD_FRAME_INVALID"))
            }
        }
    }
}

#[cfg(not(windows))]
impl std::io::Write for ControlChannel {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        use secure_fs::SecureFsSyscalls;
        self.syscalls
            .engine()
            .write(self.fd, bytes)
            .map_err(|_| std::io::Error::other("TRUST_CHILD_FRAME_INVALID"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn main() -> ExitCode {
    // Platform gate first: zero argument/environment/path/descriptor/loader/
    // spawn access on Windows.
    #[cfg(windows)]
    {
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(secure_fs::supervisor::platform_unsupported_stderr().as_bytes());
        return ExitCode::from(secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8);
    }

    #[cfg(not(windows))]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        // A2 protocol primitive: Ed25519 keygen is an offline subcommand and
        // must not enter the trust-bootstrap / control-channel resident path.
        if args.first().map(String::as_str) == Some("keygen-ed25519") {
            return match run_keygen_ed25519(&args[1..]) {
                Ok(()) => ExitCode::SUCCESS,
                Err(code) => {
                    let mut stderr = std::io::stderr().lock();
                    let _ = writeln!(stderr, "{code}");
                    ExitCode::from(2)
                }
            };
        }
        if args.first().map(String::as_str) == Some("destroy-signing-key") {
            return match run_destroy_signing_key(&args[1..]) {
                Ok(()) => ExitCode::SUCCESS,
                Err(code) => {
                    let mut stderr = std::io::stderr().lock();
                    let _ = writeln!(stderr, "{code}");
                    ExitCode::from(2)
                }
            };
        }
        if args.first().map(String::as_str) == Some("prove-signing-key-absent") {
            return match run_prove_signing_key_absent(&args[1..]) {
                Ok(()) => ExitCode::SUCCESS,
                Err(code) => {
                    let mut stderr = std::io::stderr().lock();
                    let _ = writeln!(stderr, "{code}");
                    ExitCode::from(2)
                }
            };
        }
        let bootstrapped = resolve_descriptors(&args)
            .and_then(|descriptors| secure_fs::supervisor::run_trust_bootstrap(&descriptors));
        match bootstrapped {
            Ok(summary) => {
                // Authority, both owned roots, the lock, the capability and
                // the manifest are validated, and the supervisor holds its
                // own handles to the campaign and staging roots.  The resident
                // phase loop attaches here: each execution opens an admission
                // bracket before its run-command frame is written and closes
                // it on the child's `artifact-payload` frame.
                //
                // The loop runs when the controller handed this supervisor a
                // frame channel to run it over.  Both descriptors or neither:
                // a supervisor with somewhere to read from and nowhere to
                // answer would admit series nobody could be told about, and a
                // supervisor with only a writer would answer questions nobody
                // asked.
                let control = control_descriptors(&args);
                let Some((control_in_fd, control_out_fd)) = control else {
                    return ExitCode::SUCCESS;
                };
                let campaign_id = summary.campaign_id().to_owned();
                let candidate = summary.candidate().to_owned();
                let mut sink = ResidentSink::for_bootstrap(&summary);
                let mut reader = ControlChannel {
                    syscalls: secure_fs::LibcSyscalls::new(),
                    fd: control_in_fd,
                };
                let mut writer = ControlChannel {
                    syscalls: secure_fs::LibcSyscalls::new(),
                    fd: control_out_fd,
                };
                let mut resident = ResidentLoop::new(&campaign_id, &candidate);
                // C2: every identity the execution draft must restate is read
                // through the validated bootstrap and never through the draft.
                let execution_authority = ExecutionAuthority {
                    authority_sha256: summary.authority().sha256.clone(),
                    campaign_lock_sha256: summary.campaign_lock_sha256().to_owned(),
                    staged_capability_sha256: summary.staged_capability_sha256().to_owned(),
                    source_archive_sha256: summary.source_archive_sha256().to_owned(),
                    approved_plan_sha256: summary.authority().approved_plan_sha256.clone(),
                    approval_record_sha256: summary.authority().approval_record_sha256.clone(),
                };
                resident.execution_authority = Some(execution_authority.clone());
                // Observe the supervisor's local Bun toolchain at startup,
                // before the resident loop admits any execution. The
                // observation is per-host; the controller assembles the
                // two-host set on the admission-receipt channel by reading
                // each supervisor's `toolchain_sha256` and rejecting the
                // run if either supervisor failed to produce one.
                //
                // The env var is required, not optional: a campaign that
                // did not set the path is one that did not intend to
                // publish a per-host toolchain observation, and the
                // supervisor must fail closed rather than silently
                // continue with `toolchain_sha256 = None` -- an empty
                // sha256 in `ComparisonSupervisorOutputV1.toolchainSha256`
                // would publish downstream and the artifact's toolchain
                // gate would then accept any toolchain against it, which
                // is the same self-attested promotion defect R1 exists
                // to remove.
                // Phase B: if the launcher handed this supervisor a cohort's
                // key material and execution binding, the runtime is installed
                // here -- before `serve` reads its first frame. A failure to
                // install is fatal rather than a fallback to `cohort: None`:
                // a launcher that asked for a cohort and got a supervisor that
                // refuses every cohort frame should be told at startup, not
                // six frames in.
                let cohort_descriptors = match cohort_install_descriptors(&args) {
                    Ok(descriptors) => descriptors,
                    Err(_) => {
                        let mut stderr = std::io::stderr().lock();
                        let _ = stderr.write_all(
                            secure_fs::supervisor::trust_boundary_unavailable_stderr().as_bytes(),
                        );
                        return ExitCode::from(
                            secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                        );
                    }
                };
                // §2.9(1): the Mac cohort runtime installs from its own two
                // descriptors and needs neither the Bun path nor the staging
                // root, so it is resolved before the rig's block rather than
                // inside it. Both or neither, and a failed install is fatal.
                let mac_cohort_descriptors = match mac_cohort_install_descriptors(&args) {
                    Ok(descriptors) => descriptors,
                    Err(_) => {
                        let mut stderr = std::io::stderr().lock();
                        let _ = stderr.write_all(
                            secure_fs::supervisor::trust_boundary_unavailable_stderr().as_bytes(),
                        );
                        return ExitCode::from(
                            secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                        );
                    }
                };
                if let Some(descriptors) = mac_cohort_descriptors.as_ref() {
                    // The validity window is a number every receipt this
                    // process signs states, so it is required rather than
                    // defaulted: a supervisor that invented one would be
                    // publishing an expiry nobody chose.
                    let validity = std::env::var("WS_WT_COHORT_RECEIPT_VALIDITY_MS")
                        .ok()
                        .and_then(|raw| raw.parse::<u64>().ok());
                    let Some(receipt_validity_ms) = validity else {
                        let mut stderr = std::io::stderr().lock();
                        let _ = stderr.write_all(
                            b"supervisor mac cohort runtime requires \
                             WS_WT_COHORT_RECEIPT_VALIDITY_MS\n",
                        );
                        return ExitCode::from(
                            secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                        );
                    };
                    if let Err(code) = install_production_mac_cohort_runtime(
                        &mut resident,
                        descriptors,
                        receipt_validity_ms,
                        &execution_authority,
                    ) {
                        let mut stderr = std::io::stderr().lock();
                        let _ = writeln!(
                            stderr,
                            "supervisor mac cohort runtime install failed: {code}"
                        );
                        return ExitCode::from(
                            secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                        );
                    }
                }
                match std::env::var_os("COMPARISON_SUPERVISOR_BUN_PATH") {
                    Some(bun_path) => {
                        if let Some(descriptors) = cohort_descriptors.as_ref() {
                            if let Err(code) = install_production_cohort_runtime(
                                &mut resident,
                                summary.staging_root_fd(),
                                descriptors,
                                bun_path.as_os_str(),
                            ) {
                                let mut stderr = std::io::stderr().lock();
                                let _ = writeln!(
                                    stderr,
                                    "supervisor cohort runtime install failed: {code}"
                                );
                                return ExitCode::from(
                                    secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                                );
                            }
                        }
                        let observed =
                            open_read_only_no_follow(bun_path.as_os_str()).and_then(|bun| {
                                resident.observe_local_toolchain(bun, &bun_path.to_string_lossy())
                            });
                        if let Err(err) = observed {
                            let mut stderr = std::io::stderr().lock();
                            let _ = stderr.write_all(
                                format!("supervisor toolchain observation failed: {err}\n")
                                    .as_bytes(),
                            );
                            return ExitCode::from(
                                secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                            );
                        }
                    }
                    None => {
                        let mut stderr = std::io::stderr().lock();
                        let _ = stderr.write_all(
                            b"supervisor toolchain observation required: set \
                             COMPARISON_SUPERVISOR_BUN_PATH to the Bun executable \
                             this supervisor will launch\n",
                        );
                        return ExitCode::from(
                            secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8,
                        );
                    }
                }
                match resident.serve(&mut reader, &mut writer, &mut sink) {
                    Ok(_summary) => ExitCode::SUCCESS,
                    Err(_) => {
                        let mut stderr = std::io::stderr().lock();
                        let _ = stderr.write_all(
                            secure_fs::supervisor::trust_boundary_unavailable_stderr().as_bytes(),
                        );
                        ExitCode::from(secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8)
                    }
                }
            }
            Err(_) => {
                let mut stderr = std::io::stderr().lock();
                let _ = stderr.write_all(
                    secure_fs::supervisor::trust_boundary_unavailable_stderr().as_bytes(),
                );
                ExitCode::from(secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8)
            }
        }
    }
}

#[cfg(all(test, not(windows)))]
mod resident_admission_tests {
    use super::*;
    use secure_fs::measurement::{
        admit_series, ExecutionKey, GrantRequest, MeasurementRefusal, WallBracket,
    };
    use serde_json::Value;

    fn execution(index: u64, transport: &str) -> ExecutionKey {
        ExecutionKey {
            campaign_id: "r1-phase2".to_string(),
            run_id: format!("run-cell-{index:03}"),
            execution_index: index,
            transport: transport.to_string(),
        }
    }

    fn request(index: u64, transport: &str, message_count: u64) -> GrantRequest {
        GrantRequest {
            candidate: "candidate-phase2".to_string(),
            execution: execution(index, transport),
            declared_message_count: message_count,
            declared_message_bytes: 1_024,
        }
    }

    /// The grant exactly as the child receives it: the bytes of the
    /// `run-command` payload, decoded and echoed back untouched.
    fn granted(admission: &mut ResidentLoop, request: &GrantRequest) -> Value {
        let payload = admission.open_execution(request).expect("grant is issued");
        serde_json::from_slice(&payload).expect("the run-command payload is a record")
    }

    /// A series shaped exactly as the driver's leg record is: `samples`,
    /// `roundTrips`, `provenance` and the adapter `ledger`, carrying the grant
    /// the child was handed for the execution it measured.
    fn series(
        grant: Option<&Value>,
        first_at_ms: f64,
        step_ms: f64,
        latency_ms: f64,
        count: usize,
    ) -> Vec<u8> {
        let mut samples = Vec::new();
        let mut trips = Vec::new();
        let mut sent = first_at_ms;
        let mut last = first_at_ms;
        for sequence in 1..=count {
            let received = sent + latency_ms;
            samples.push(serde_json::json!(latency_ms));
            trips.push(serde_json::json!({
                "sequence": sequence,
                "sentAtMs": sent,
                "receivedAtMs": received,
                "latencyMs": latency_ms,
            }));
            last = received;
            sent = received + step_ms;
        }
        let mut record = serde_json::json!({
            "samples": samples,
            "roundTrips": trips,
            "ledger": { "attempted": count, "delivered": count },
            "provenance": {
                "sampleCount": count,
                "firstSampleAtMs": first_at_ms,
                "lastSampleAtMs": last,
            },
        });
        if let Some(grant) = grant {
            record["grant"] = grant.clone();
        }
        let mut bytes = serde_json::to_vec(&record).expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    /// An honest leg for a grant, taken inside the interval the grant opened.
    fn honest_leg(grant: &Value, count: usize) -> Vec<u8> {
        let issued = grant["issuedAt"].as_f64().expect("issuedAt is a number");
        series(Some(grant), issued + 2.0, 0.2, 0.5, count)
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut header = serde_json::to_vec(&serde_json::json!({
            "kind": "artifact-payload",
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        secure_fs::supervisor::frame::encode_frame(
            &header,
            payload,
            secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES,
        )
        .expect("frame encodes")
    }

    /// An honest Mbps throughput leg: one window, bytes match the mean.
    fn honest_throughput_leg(grant: &Value, delivered_bytes: u64, span_ms: f64) -> Vec<u8> {
        let issued = grant["issuedAt"].as_f64().expect("issuedAt is a number");
        let first = issued + 2.0;
        let last = first + span_ms;
        let mbps = (delivered_bytes as f64 * 8.0) / (span_ms * 1000.0);
        let record = serde_json::json!({
            "sampleUnit": "Mbps",
            "samples": [mbps],
            "roundTrips": [],
            "ledger": { "attempted": 1600, "delivered": 1600 },
            "deliveredBytes": delivered_bytes,
            "provenance": {
                "sampleCount": 1,
                "firstSampleAtMs": first,
                "lastSampleAtMs": last,
            },
            "grant": grant,
        });
        let mut bytes = serde_json::to_vec(&record).expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn an_honest_mbps_throughput_leg_is_admitted() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "ws", 1600);
        let grant = granted(&mut admission, &spec);
        let payload = honest_throughput_leg(&grant, 1_000_000, 10.0);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let admitted = admission
            .accept_artifact_payload(&spec.execution, &framed(&payload))
            .expect("honest Mbps leg is admitted");
        assert_eq!(admitted.sample_count, 1);
        assert_eq!(admitted.delivered, 1600);
        let observed = admitted
            .observed_mbps
            .expect("Mbps legs report observed_mbps");
        // 1_000_000 bytes over 10 ms → 800 Mbps
        assert!((observed - 800.0).abs() < 0.01);
    }

    #[test]
    fn a_relabelled_ms_series_marked_mbps_is_refused() {
        use secure_fs::measurement::{admit_series, WallBracket};
        let bracket = WallBracket {
            grant_issued_at_ms: 1_000.0,
            frame_accepted_at_ms: 3_000.0,
        };
        // ms-shaped samples (~0.5) cannot match observedMbps from real bytes.
        let mut record = serde_json::json!({
            "sampleUnit": "Mbps",
            "samples": [0.5, 0.5, 0.5],
            "roundTrips": [],
            "ledger": { "delivered": 3 },
            "deliveredBytes": 104_857_600u64,
            "provenance": {
                "sampleCount": 3,
                "firstSampleAtMs": 1_100.0,
                "lastSampleAtMs": 2_100.0,
            },
        });
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.push(b'\n');
        assert_eq!(
            admit_series(&bytes, &bracket).map(|_| ()),
            Err(secure_fs::measurement::MeasurementRefusal::SeriesLedgerDiverges)
        );
        // Presence of roundTrips also refuses.
        record["roundTrips"] = serde_json::json!([{
            "sequence": 1,
            "sentAtMs": 1_100.0,
            "receivedAtMs": 1_100.5,
            "latencyMs": 0.5,
        }]);
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.push(b'\n');
        assert_eq!(
            admit_series(&bytes, &bracket).map(|_| ()),
            Err(secure_fs::measurement::MeasurementRefusal::SeriesLedgerDiverges)
        );
    }

    /// An honest count rate leg: one window, mean matches delivered/span.
    fn honest_rate_leg(grant: &Value, delivered: u64, span_ms: f64) -> Vec<u8> {
        let issued = grant["issuedAt"].as_f64().expect("issuedAt is a number");
        let first = issued + 2.0;
        let last = first + span_ms;
        let events_per_second = (delivered as f64) * 1000.0 / span_ms;
        let record = serde_json::json!({
            "sampleUnit": "count",
            "samples": [events_per_second],
            "roundTrips": [],
            "ledger": { "attempted": delivered, "delivered": delivered },
            "provenance": {
                "sampleCount": 1,
                "firstSampleAtMs": first,
                "lastSampleAtMs": last,
            },
            "grant": grant,
        });
        let mut bytes = serde_json::to_vec(&record).expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn an_honest_count_rate_leg_is_admitted() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "ws", 5_000);
        let grant = granted(&mut admission, &spec);
        // Short span so the series fits the supervisor bracket after a brief sleep.
        let payload = honest_rate_leg(&grant, 50, 10.0);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let admitted = admission
            .accept_artifact_payload(&spec.execution, &framed(&payload))
            .expect("honest count rate leg is admitted");
        assert_eq!(admitted.sample_count, 1);
        assert_eq!(admitted.delivered, 50);
        // 50 events over 10 ms → 5_000 events/s; latency_sum carries the sample sum.
        assert!((admitted.latency_sum_ms - 5_000.0).abs() < 0.01);
    }

    #[test]
    fn a_relabelled_ms_series_marked_count_is_refused() {
        use secure_fs::measurement::{admit_series, WallBracket};
        let bracket = WallBracket {
            grant_issued_at_ms: 1_000.0,
            frame_accepted_at_ms: 3_000.0,
        };
        // ms-shaped samples (~0.5) cannot match observedRate from delivered.
        let mut record = serde_json::json!({
            "sampleUnit": "count",
            "samples": [0.5, 0.5, 0.5],
            "roundTrips": [],
            "ledger": { "delivered": 5_000 },
            "provenance": {
                "sampleCount": 3,
                "firstSampleAtMs": 1_100.0,
                "lastSampleAtMs": 2_100.0,
            },
        });
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.push(b'\n');
        assert_eq!(
            admit_series(&bytes, &bracket).map(|_| ()),
            Err(secure_fs::measurement::MeasurementRefusal::SeriesLedgerDiverges)
        );
        // Presence of roundTrips also refuses.
        record["roundTrips"] = serde_json::json!([{
            "sequence": 1,
            "sentAtMs": 1_100.0,
            "receivedAtMs": 1_100.5,
            "latencyMs": 0.5,
        }]);
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.push(b'\n');
        assert_eq!(
            admit_series(&bytes, &bracket).map(|_| ()),
            Err(secure_fs::measurement::MeasurementRefusal::SeriesLedgerDiverges)
        );
    }

    #[test]
    fn an_honest_bytes_series_is_admitted() {
        use secure_fs::measurement::{admit_series, WallBracket};
        let bracket = WallBracket {
            grant_issued_at_ms: 1_000.0,
            frame_accepted_at_ms: 3_000.0,
        };
        let record = serde_json::json!({
            "sampleUnit": "bytes",
            "samples": [131_072.0],
            "roundTrips": [],
            "ledger": { "delivered": 1 },
            "provenance": {
                "sampleCount": 1,
                "firstSampleAtMs": 1_100.0,
                "lastSampleAtMs": 1_100.0,
            },
        });
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.push(b'\n');
        let admitted = admit_series(&bytes, &bracket).expect("honest bytes leg");
        assert_eq!(admitted.sample_count, 1);
        assert_eq!(admitted.delivered, 1);
        assert!((admitted.latency_sum_ms - 131_072.0).abs() < 0.01);
    }

    #[test]
    fn a_bytes_series_without_deliveries_is_refused() {
        use secure_fs::measurement::{admit_series, WallBracket};
        let bracket = WallBracket {
            grant_issued_at_ms: 1_000.0,
            frame_accepted_at_ms: 3_000.0,
        };
        let record = serde_json::json!({
            "sampleUnit": "bytes",
            "samples": [65_536.0],
            "roundTrips": [],
            "ledger": { "delivered": 0 },
            "provenance": {
                "sampleCount": 1,
                "firstSampleAtMs": 1_100.0,
                "lastSampleAtMs": 1_100.0,
            },
        });
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.push(b'\n');
        assert_eq!(
            admit_series(&bytes, &bracket).map(|_| ()),
            Err(secure_fs::measurement::MeasurementRefusal::SeriesLedgerDiverges)
        );
    }

    /// The bracket is the supervisor's, so an honest leg taken inside it is
    /// admitted through the same path the resident loop will use.
    #[test]
    fn an_honest_leg_inside_the_bracket_is_admitted() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let payload = honest_leg(&grant, 6);
        // The leg has to be over before the payload frame arrives, so the
        // bracket only closes after the interval the series claims.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let admitted = admission
            .accept_artifact_payload(&spec.execution, &framed(&payload))
            .expect("honest leg is admitted");
        assert_eq!(admitted.sample_count, 6);
        assert_eq!(admitted.delivered, 6);
        assert!(admitted.latency_sum_ms <= admitted.span_ms);
    }

    /// The reviewer's forgery in the shape that defeated both in-process
    /// guards: a stepping clock, a thousand samples, 28.6 ms apiece.  Nothing
    /// about it is malformed and its own ledger agrees with it; what it cannot
    /// do is fit inside an interval the supervisor observed.
    #[test]
    fn a_stepping_clock_series_is_refused_on_the_bracket() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "wt", 4_096);
        let grant = granted(&mut admission, &spec);
        let payload = series(Some(&grant), 1_000.0, 0.0, 28.6, 1_000);
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_OUTSIDE_GRANT_WINDOW"),
        );
    }

    /// The same forgery re-based onto the supervisor's own clock still cannot
    /// be admitted: 1,000 round trips of 28.6 ms need 28.6 seconds, and the
    /// bracket around a leg that took milliseconds does not hold them.
    #[test]
    fn a_rebased_stepping_clock_still_overruns_the_bracket() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "wt", 4_096);
        let grant = granted(&mut admission, &spec);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = series(Some(&grant), issued + 1.0, 0.0, 28.6, 1_000);
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_OUTSIDE_GRANT_WINDOW"),
        );
    }

    /// M2 on its own: a window the bracket accepts, beside a ledger that
    /// recorded different traffic.
    #[test]
    fn a_series_the_ledger_contradicts_is_refused() {
        let now = secure_fs::measurement::now_epoch_millis();
        let bracket = WallBracket {
            grant_issued_at_ms: now - 1_000.0,
            frame_accepted_at_ms: now + 1_000.0,
        };
        let honest = series(None, now, 0.2, 0.5, 6);
        assert!(admit_series(&honest, &bracket).is_ok());
        let text = String::from_utf8(honest).expect("utf8");
        let padded = text.replace("\"delivered\":6", "\"delivered\":1800");
        assert_eq!(
            admit_series(padded.as_bytes(), &bracket).map(|_| ()),
            Err(MeasurementRefusal::SeriesLedgerDiverges),
        );
    }

    /// A frame that is not an `artifact-payload` is not a measurement, however
    /// well-formed the series inside it is.
    #[test]
    fn a_non_artifact_payload_frame_is_never_admitted() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let payload = honest_leg(&grant, 3);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut header = serde_json::to_vec(&serde_json::json!({
            "kind": "server-telemetry",
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        let frame = secure_fs::supervisor::frame::encode_frame(
            &header,
            &payload,
            secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES,
        )
        .expect("frame encodes");
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &frame)
                .map(|_| ()),
            Err("TRUST_CHILD_FRAME_INVALID"),
        );
    }

    // -----------------------------------------------------------------------
    // The grant
    // -----------------------------------------------------------------------

    /// A payload that never claims to have been authorised.  This is the
    /// phase-1 series verbatim — it passes M1 and M2 — and it is refused
    /// anyway, which is the whole of what the grant adds.
    #[test]
    fn a_payload_carrying_no_grant_is_refused() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = series(None, issued + 2.0, 0.2, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_GRANT_ABSENT"),
        );
    }

    /// One execution, one presentation.  The second attempt has nothing
    /// outstanding to present, because the first spent it.
    #[test]
    fn an_execution_gets_exactly_one_presentation() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let payload = framed(&honest_leg(&grant, 6));
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(admission
            .accept_artifact_payload(&spec.execution, &payload)
            .is_ok());
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &payload)
                .map(|_| ()),
            Err("MEASUREMENT_GRANT_ABSENT"),
        );
    }

    /// A grant already spent on one execution, presented for the next.  The
    /// series inside it is a real one that really was admitted; what it cannot
    /// be is admitted twice.
    #[test]
    fn a_replayed_grant_is_refused() {
        let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
        let first = request(1, "ws", 64);
        let second = request(2, "ws", 64);
        let grant = granted(&mut admission, &first);
        let _ = granted(&mut admission, &second);
        let payload = framed(&honest_leg(&grant, 6));
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(admission
            .accept_artifact_payload(&first.execution, &payload)
            .is_ok());
        assert_eq!(
            admission
                .accept_artifact_payload(&second.execution, &payload)
                .map(|_| ()),
            Err("MEASUREMENT_GRANT_ABSENT"),
        );
    }

    /// A grant that has never been spent, presented under an execution it was
    /// not issued for.  Distinct from replay in diagnosis and identical in
    /// outcome: the execution in front of the supervisor has no grant.
    #[test]
    fn a_grant_issued_for_another_execution_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let first = request(1, "ws", 64);
        let second = request(2, "ws", 64);
        let issued = registry.issue(&first).expect("first grant");
        let _ = registry.issue(&second).expect("second grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let payload = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        let refusal = registry
            .admit_payload(&second.execution, &payload, accepted_at_ms)
            .expect_err("a grant for another execution is refused");
        assert_eq!(refusal, MeasurementRefusal::GrantBoundToAnotherExecution);
        assert_eq!(refusal.code(), "MEASUREMENT_GRANT_ABSENT");
    }

    /// A grant whose execution is right and whose record is not.  The
    /// supervisor issued no such thing, so this execution is presenting no
    /// grant rather than presenting somebody else's.
    #[test]
    fn a_grant_the_supervisor_did_not_issue_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 64);
        let issued = registry.issue(&spec).expect("grant");
        let mut echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        echoed["declaredMessageCount"] = serde_json::json!(1_000_000);
        let payload = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, accepted_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::GrantAbsent),
        );
    }

    /// The grant declares how many messages the execution was authorised to
    /// send, so a series longer than that is reporting traffic nobody asked
    /// for — even though it is internally consistent and inside the bracket.
    #[test]
    fn a_series_longer_than_the_grant_authorised_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 4);
        let issued = registry.issue(&spec).expect("grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let payload = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, accepted_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::SeriesLedgerDiverges),
        );
        assert!(registry
            .admit_payload(&request(2, "ws", 4).execution, &payload, accepted_at_ms)
            .is_err());
    }

    /// The failure mode the phase exists to close: one leg that genuinely ran,
    /// spent across a campaign.
    ///
    /// M1 cannot see this.  Every one of the 105 presentations carries a real
    /// series, inside a real bracket, with a ledger that agrees with it — the
    /// leg happened.  What makes 104 of them false is not anything about the
    /// numbers; it is that they are the same numbers, and the campaign is
    /// counting them as 105 measurements.  The grant is the only thing in the
    /// design that asks that question.
    #[test]
    fn one_honest_leg_cannot_answer_for_a_hundred_and_five_cells() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let specs: Vec<GrantRequest> = (1..=105).map(|index| request(index, "wt", 64)).collect();
        let mut echoed_first: Option<Value> = None;
        for spec in &specs {
            let issued = registry.issue(spec).expect("every execution is granted");
            if echoed_first.is_none() {
                echoed_first = Some(
                    serde_json::from_slice(&issued.run_command_payload().expect("payload"))
                        .expect("json"),
                );
            }
        }
        assert_eq!(registry.outstanding_count(), 105);

        let leg = honest_leg(echoed_first.as_ref().expect("first grant"), 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        let admitted = registry
            .admit_payload(&specs[0].execution, &leg, accepted_at_ms)
            .expect("the leg that really ran is admitted, once");
        assert_eq!(admitted.sample_count, 6);

        let mut refusals = Vec::new();
        for spec in &specs[1..] {
            let refusal = registry
                .admit_payload(&spec.execution, &leg, accepted_at_ms)
                .expect_err("a spent leg answers for no further cell");
            assert_eq!(refusal.code(), "MEASUREMENT_GRANT_ABSENT");
            refusals.push(refusal);
        }
        assert_eq!(refusals.len(), 104);
        assert!(refusals
            .iter()
            .all(|refusal| *refusal == MeasurementRefusal::GrantReplayed));
        assert_eq!(registry.outstanding_count(), 0);
    }

    /// A grant is unpredictable and belongs to one execution, so two of them
    /// are never interchangeable.
    #[test]
    fn each_execution_gets_its_own_unrepeatable_grant() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let first = registry.issue(&request(1, "ws", 64)).expect("first");
        let second = registry.issue(&request(2, "ws", 64)).expect("second");
        assert_ne!(first.nonce_sha256, second.nonce_sha256);
        assert_eq!(first.nonce_sha256.len(), 64);
        assert!(first.not_after_ms > first.issued_at_ms);
        // An execution the supervisor has already authorised is not
        // authorised again.
        assert_eq!(
            registry.issue(&request(1, "ws", 64)).map(|_| ()),
            Err(MeasurementRefusal::GrantReplayed),
        );
    }

    /// The record the child echoes is the record the supervisor wrote, byte
    /// for byte, and it fits the frozen `run-command` bound.
    #[test]
    fn the_grant_record_round_trips_through_its_canonical_bytes() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let grant = registry.issue(&request(7, "wt", 512)).expect("grant");
        let bytes = grant.run_command_payload().expect("payload");
        assert!(bytes.len() as u64 <= secure_fs::measurement::RUN_COMMAND_MAX_BYTES);
        assert_eq!(bytes.last(), Some(&b'\n'));
        let text = String::from_utf8(bytes.clone()).expect("utf8");
        // Keys in ASCII order, so both languages encode the same bytes.
        let mut keys: Vec<&str> = Vec::new();
        for key in [
            "campaignId",
            "candidate",
            "declaredMessageBytes",
            "declaredMessageCount",
            "executionIndex",
            "issuedAt",
            "nonceSha256",
            "notAfter",
            "runId",
            "schema",
            "transport",
        ] {
            assert!(text.contains(&format!("\"{key}\":")), "missing {key}");
            keys.push(key);
        }
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted);
        let mut offset = 0usize;
        for key in &keys {
            let at = text.find(&format!("\"{key}\":")).expect("key present");
            assert!(at >= offset, "{key} is out of canonical order");
            offset = at;
        }
    }

    /// A grant is admissible only inside its own lifetime, whatever the
    /// bracket would have said.
    #[test]
    fn a_grant_presented_after_it_expires_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 64);
        let issued = registry.issue(&spec).expect("grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let payload = honest_leg(&echoed, 6);
        let expired_at_ms = issued.not_after_ms as f64 + 1.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, expired_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::OutsideGrantWindow),
        );
    }

    /// One execution gets one presentation, and a refusal is a presentation.
    ///
    /// The size check used to sit ahead of the spend, so an oversize payload
    /// was refused with the grant still outstanding: unlimited free attempts
    /// against one bracket, each of them cheaper for the forger than an
    /// honest leg, and an honest presentation admitted after five refusals.
    #[test]
    fn a_refused_payload_spends_the_executions_one_presentation() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 64);
        let issued = registry.issue(&spec).expect("grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let honest = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        let oversize = vec![b'x'; secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES as usize + 1];
        assert_eq!(registry.outstanding_count(), 1);
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &oversize, accepted_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::SeriesMalformed),
        );
        assert_eq!(registry.outstanding_count(), 0);
        // The attempt was spent, so the leg behind it — honest, and admitted
        // on its own — is presenting a grant this registry has already spent.
        // Both variants publish `MEASUREMENT_GRANT_ABSENT`; which one it is is
        // the supervisor's own diagnosis, and the replay is the true one.
        let refusal = registry
            .admit_payload(&spec.execution, &honest, accepted_at_ms)
            .map(|_| ());
        assert_eq!(refusal, Err(MeasurementRefusal::GrantReplayed));
        assert_eq!(refusal.unwrap_err().code(), "MEASUREMENT_GRANT_ABSENT",);
    }

    /// A frame that never became a series is still this execution's one
    /// presentation.
    ///
    /// The decode, the header parse and the kind check all returned ahead of
    /// the spend, and each of them is reachable by a child that sends
    /// nonsense — which is the cheapest attempt of all.
    #[test]
    fn an_undecodable_frame_spends_the_executions_one_presentation() {
        for nonsense in [
            b"not a frame at all".to_vec(),
            framed_as("telemetry", b"{}\n"),
        ] {
            let mut admission = ResidentLoop::new("r1-phase2", "candidate-phase2");
            let spec = request(1, "ws", 64);
            let grant = granted(&mut admission, &spec);
            let honest = framed(&honest_leg(&grant, 6));
            assert_eq!(
                admission
                    .accept_artifact_payload(&spec.execution, &nonsense)
                    .map(|_| ()),
                Err("TRUST_CHILD_FRAME_INVALID"),
            );
            assert_eq!(
                admission
                    .accept_artifact_payload(&spec.execution, &honest)
                    .map(|_| ()),
                Err("MEASUREMENT_GRANT_ABSENT"),
            );
        }
    }

    /// A frame of the given kind, so a child that may emit one kind cannot
    /// have another admitted as a measurement.
    fn framed_as(kind: &str, payload: &[u8]) -> Vec<u8> {
        let mut header = serde_json::to_vec(&serde_json::json!({
            "kind": kind,
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        secure_fs::supervisor::frame::encode_frame(
            &header,
            payload,
            secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES,
        )
        .expect("frame encodes")
    }

    /// An honest leg with every reported latency shifted by `shave_ms`, the
    /// timestamps left exactly as the recorder took them.
    ///
    /// This is the whole per-sample forgery: the stamps are real, the numbers
    /// the campaign ranks on are not, and only the arithmetic slack stands
    /// between them.
    fn leg_with_shaved_latencies(grant: &Value, count: usize, shave_ms: f64) -> Vec<u8> {
        let issued = grant["issuedAt"].as_f64().expect("issuedAt is a number");
        let mut samples = Vec::new();
        let mut trips = Vec::new();
        let mut sent = issued + 2.0;
        let mut last = sent;
        for sequence in 1..=count {
            let received = sent + 0.5;
            let reported = 0.5 - shave_ms;
            samples.push(serde_json::json!(reported));
            trips.push(serde_json::json!({
                "sequence": sequence,
                "sentAtMs": sent,
                "receivedAtMs": received,
                "latencyMs": reported,
            }));
            last = received;
            sent = received + 0.2;
        }
        let mut record = serde_json::json!({
            "grant": grant.clone(),
            "samples": samples,
            "roundTrips": trips,
            "ledger": { "attempted": count, "delivered": count },
            "provenance": {
                "sampleCount": count,
                "firstSampleAtMs": issued + 2.0,
                "lastSampleAtMs": last,
            },
        });
        record["grant"] = grant.clone();
        let mut bytes = serde_json::to_vec(&record).expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    /// The arithmetic slack is a two-sided per-sample channel, so its width is
    /// a gate in its own right and is pinned here.
    ///
    /// At the 4,096-ulp tolerance this replaced, the band was 1.63 ms: every
    /// shave below admitted, including ones larger than the latency being
    /// reported and large enough to invert it. The band is now microseconds,
    /// and a rewrite of twenty of them is refused.
    #[test]
    fn a_latency_rewritten_beside_intact_stamps_is_refused_at_microseconds() {
        let honest = |shave_ms: f64| -> Result<(), MeasurementRefusal> {
            let mut registry = secure_fs::measurement::GrantRegistry::new();
            let spec = request(1, "ws", 64);
            let issued = registry.issue(&spec).expect("grant");
            let echoed: Value =
                serde_json::from_slice(&issued.run_command_payload().expect("payload"))
                    .expect("json");
            let payload = leg_with_shaved_latencies(&echoed, 12, shave_ms);
            let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
            registry
                .admit_payload(&spec.execution, &payload, accepted_at_ms)
                .map(|_| ())
        };
        // Untouched, so the only residual is the one representing the stamps.
        assert_eq!(honest(0.0), Ok(()));
        // Ten microseconds -- 0.8% of a typical local latency -- is refused in
        // both directions, so the admitted band is microseconds wide. The
        // 4,096-ulp constant admitted a hundred and sixty times this.
        assert_eq!(honest(0.010), Err(MeasurementRefusal::SeriesLedgerDiverges));
        assert_eq!(
            honest(-0.010),
            Err(MeasurementRefusal::SeriesLedgerDiverges),
        );
        // The prover's shave, which the 4,096-ulp band admitted.
        assert_eq!(honest(0.4), Err(MeasurementRefusal::SeriesLedgerDiverges));
    }

    /// The authorised count bounds the work, which means it is asked before
    /// the work is done.
    ///
    /// Asked afterwards, as it was, a series a thousand times over its cap was
    /// fully parsed and fully joined before its length was objected to -- and
    /// the join scanned a `Vec` for each sequence, so the cost was quadratic
    /// in exactly the number the grant existed to bound. At the payload cap
    /// that was 1.12 s per execution against 107 ms now, and the refusal named
    /// the bracket rather than the length.
    ///
    /// The pin is the ordering, not the timing: these round trips are not
    /// objects, so a run that reached them would refuse them as malformed.
    #[test]
    fn a_series_over_its_authorised_count_is_refused_before_it_is_read() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 4);
        let issued = registry.issue(&spec).expect("grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let mut record = serde_json::json!({
            "grant": echoed,
            "samples": [0.5, 0.5, 0.5, 0.5, 0.5],
            "roundTrips": ["not a round trip", "nor is this"],
            "ledger": { "attempted": 5, "delivered": 5 },
            "provenance": {
                "sampleCount": 5,
                "firstSampleAtMs": 1.0,
                "lastSampleAtMs": 2.0,
            },
        });
        record["grant"] =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let mut payload = serde_json::to_vec(&record).expect("series encodes");
        payload.push(b'\n');
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, accepted_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::SeriesLedgerDiverges),
        );
    }

    /// The record-recognition surface B1 introduced: a section 4 record is
    /// recognised and validated, and nothing is done with it.  The
    /// unknown-schema arm is the point — this validator names records and
    /// refuses malformed ones under their own codes, and does not itself move
    /// a cohort.  The binary's *runtime* cohort protocol is the `serve` cohort
    /// dispatch (`cohort_dispatch_tests`), which routes the five controller ->
    /// rig request kinds into `cohort::rig::RigCohortSession`.
    #[test]
    fn cohort_records_are_recognised_and_validated_without_being_acted_on() {
        use secure_fs::cohort;
        use secure_fs::cross_supervisor::{
            generate_ed25519_keypair, public_key_sha256, sign_bytes,
        };

        let keys = generate_ed25519_keypair();
        let manifest = serde_json::json!({
            "schema": "ordered-partial-manifest/v1",
            "executionSha256": cohort::sha256_hex(b"execution"),
            "cohortGrantSha256": cohort::sha256_hex(b"grant"),
            "cohortStartBarrierSha256": cohort::sha256_hex(b"barrier"),
            "publisherPartialCount": 1,
            "workerPartialCount": 8,
            "totalPartialBytes": 0,
            "entries": [],
            "orderedDigestSetSha256": cohort::sha256_hex(b"digest-set"),
        });
        let bytes = cohort::canonical_bytes(&manifest).expect("canonical bytes");
        let signature = sign_bytes(&keys.private_pkcs8_der, &bytes).expect("sign");
        let context = CohortRecordContext {
            staged_mac_public_raw32: &keys.public_raw32,
            signature: &signature,
            subscriber_count: 100,
        };

        // Recognised, and refused on its own terms: nine entries were declared
        // and none were carried.
        assert_eq!(
            validate_cohort_record("ordered-partial-manifest/v1", &bytes, &context),
            Err("TRUST_PROTOCOL"),
        );
        // The public key digest the record must name is the staged one.
        assert_eq!(public_key_sha256(&keys.public_raw32).len(), 64);
        // A schema this supervisor does not speak is answered as an invalid
        // frame, exactly as the serve loop answers an unknown frame kind.
        assert_eq!(
            validate_cohort_record("fanout-wire/v1", &bytes, &context),
            Err("TRUST_CHILD_FRAME_INVALID"),
        );
    }

    /// A canonical `cohort-grant/v1`, small enough to sign in a unit test.
    ///
    /// The commitment root is a bare digest on purpose: `CohortGrantV1` is a
    /// codec over a signed record, and whether that root is reachable from any
    /// particular token set is what admission proves, not what parsing does.
    fn unit_grant_value(key_sha256: &str) -> serde_json::Value {
        use secure_fs::cohort::{sha256_hex, SUBSCRIBER_SHARD_MODULUS};
        let digest = |tag: &str| sha256_hex(tag.as_bytes());
        let shards = (0..SUBSCRIBER_SHARD_MODULUS)
            .map(|worker_index| {
                serde_json::json!({
                    "schema": "subscriber-shard/v1",
                    "childId": format!("worker-{worker_index}"),
                    "workerIndex": worker_index,
                    "modulus": SUBSCRIBER_SHARD_MODULUS,
                    "residue": worker_index,
                    "firstSubscriberIndex": 0,
                    "lastSubscriberIndexExclusive": SUBSCRIBER_SHARD_MODULUS,
                    "subscriberCount": 1,
                    "orderedSubscriberIdsSha256": digest(&format!("shard-{worker_index}")),
                    "firstTokenCommitmentIndex": worker_index + 1,
                    // One member per shard: the residue window is `[first, first + 1)`.
                    "lastTokenCommitmentIndexExclusive": worker_index + 2,
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "schema": "cohort-grant/v1",
            "execution": { "schema": "cross-supervisor-execution/v1", "executionIndex": 1 },
            "executionSha256": digest("execution"),
            "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "cohortId": "cohort-ticker-bin-ws",
            "cohortAttempt": 1,
            "scenarioHash": digest("scenario"),
            "rolePlanHash": digest("role-plan"),
            "workloadRolePlanInputSha256": digest("workload-role-plan-input"),
            "transport": "ws",
            "publisherCount": 1,
            "subscriberCount": SUBSCRIBER_SHARD_MODULUS,
            "workerCount": SUBSCRIBER_SHARD_MODULUS,
            "expectedProcessCount": SUBSCRIBER_SHARD_MODULUS + 1,
            "expectedSessionCount": SUBSCRIBER_SHARD_MODULUS + 1,
            "publishers": [{
                "schema": "publisher-role-grant/v1",
                "childId": "publisher-000000",
                "publisherId": "publisher-000000",
                "tokenCommitmentIndex": 0,
                "tokenSha256": digest("publisher-token"),
            }],
            "subscriberShards": shards,
            "tokenCommitmentLeafManifestSha256": digest("leaf-manifest"),
            "roleTokenCommitmentRootSha256": digest("commitment-root"),
            "roleTokenCommitmentCount": SUBSCRIBER_SHARD_MODULUS + 1,
            "connectionRatePerSecond": 500,
            "maxConnectionsInFlight": 200,
            "readinessDeadlineMs": 30000,
            "inRepetitionWarmupMs": 5000,
            "sampleWindowMs": 1000,
            "measuredDurationMs": 10000,
            "drainDeadlineMs": 10000,
            "messageBytes": 100,
            "expectedOfferedIngress": 100,
            "expectedExpandedDeliveries": 800,
            "macSupervisorInstanceNonce": digest("mac-instance-1"),
            "signingPublicKeySha256": key_sha256,
            "receiptSequence": 0,
            "issuedAtMs": 1_760_000_000_000u64,
            "notAfterMs": 1_760_000_600_000u64,
        })
    }

    /// B3's supervisor surface: the binary now *acts* on a cohort record, and
    /// only in the order the cohort's own lifetime allows.  `serve` still does
    /// not route here — the ordering is what this proves, not a live path.
    #[test]
    fn cohort_records_move_the_cohort_only_in_lifecycle_order() {
        use secure_fs::cohort::{self, CohortOwner, CohortPhase};
        use secure_fs::cross_supervisor::{
            generate_ed25519_keypair, public_key_sha256, sign_bytes,
        };

        let keys = generate_ed25519_keypair();
        let key_sha256 = public_key_sha256(&keys.public_raw32);
        let grant_bytes =
            cohort::canonical_bytes(&unit_grant_value(&key_sha256)).expect("canonical bytes");
        let signature = sign_bytes(&keys.private_pkcs8_der, &grant_bytes).expect("sign");
        let context = CohortRecordContext {
            staged_mac_public_raw32: &keys.public_raw32,
            signature: &signature,
            subscriber_count: 8,
        };

        let mut owner = CohortOwner::new();

        // A barrier or an observation reaching a cohort that has no grant is
        // refused on the phase, and moves nothing.
        for schema in ["cohort-start-barrier/v1", "linux-relay-observation/v1"] {
            assert_eq!(
                apply_cohort_record(&mut owner, schema, &grant_bytes, &context),
                Err("COHORT_NOT_READY"),
                "{schema} before a grant",
            );
            assert_eq!(owner.phase(), CohortPhase::AwaitingGrant);
        }

        // The grant is applied, and reports the digest of the exact bytes.
        assert_eq!(
            apply_cohort_record(&mut owner, "cohort-grant/v1", &grant_bytes, &context),
            Ok(cohort::sha256_hex(&grant_bytes)),
        );
        assert_eq!(owner.phase(), CohortPhase::GrantAccepted);

        // A second grant is a different cohort arriving mid-flight, not a
        // replacement: replacement is not reachable from a record dispatcher.
        assert_eq!(
            apply_cohort_record(&mut owner, "cohort-grant/v1", &grant_bytes, &context),
            Err("COHORT_NOT_READY"),
        );

        // A record that authorises no transition is validated and nothing
        // more: the refusal is the record's own, and the phase is untouched.
        let manifest = serde_json::json!({
            "schema": "ordered-partial-manifest/v1",
            "executionSha256": cohort::sha256_hex(b"execution"),
            "cohortGrantSha256": cohort::sha256_hex(b"grant"),
            "cohortStartBarrierSha256": cohort::sha256_hex(b"barrier"),
            "publisherPartialCount": 1,
            "workerPartialCount": 8,
            "totalPartialBytes": 0,
            "entries": [],
            "orderedDigestSetSha256": cohort::sha256_hex(b"digest-set"),
        });
        let manifest_bytes = cohort::canonical_bytes(&manifest).expect("canonical bytes");
        assert_eq!(
            apply_cohort_record(
                &mut owner,
                "ordered-partial-manifest/v1",
                &manifest_bytes,
                &context
            ),
            Err("TRUST_PROTOCOL"),
        );
        assert_eq!(
            apply_cohort_record(&mut owner, "fanout-wire/v1", &manifest_bytes, &context),
            Err("TRUST_CHILD_FRAME_INVALID"),
        );
        assert_eq!(owner.phase(), CohortPhase::GrantAccepted);
        assert!(owner.owned_groups().is_empty());
    }
}

/// The resident loop's frame transport: the carriage, not the rules.
///
/// Everything in `resident_admission_tests` above proves what the supervisor
/// admits.  These prove that a series reaches it at all, that the answer goes
/// back, and — the property the whole design turns on — that the write happens
/// for an admitted series and for nothing else.
#[cfg(all(test, not(windows)))]
mod resident_loop_tests {
    use super::*;
    use secure_fs::measurement::{self as m, AdmissionReceipt, AdmittedSink};
    use serde_json::Value;

    /// A sink that records what it was asked to write, which is the only way
    /// to assert that nothing was.
    #[derive(Default)]
    struct RecordingSink {
        committed: Vec<(u64, Vec<u8>)>,
    }

    impl AdmittedSink for RecordingSink {
        fn commit(
            &mut self,
            receipt: &AdmissionReceipt,
            payload: &[u8],
        ) -> Result<(), &'static str> {
            self.committed
                .push((receipt.execution.execution_index, payload.to_vec()));
            Ok(())
        }
    }

    fn open_request(run_id: &str, transport: &str, count: u64) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "declaredMessageBytes": 1_024,
            "declaredMessageCount": count,
            "runId": run_id,
            "transport": transport,
        }))
        .expect("request encodes");
        bytes.push(b'\n');
        bytes
    }

    fn framed(kind: &str, payload: &[u8]) -> Vec<u8> {
        let mut header = serde_json::to_vec(&serde_json::json!({
            "kind": kind,
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        secure_fs::supervisor::frame::encode_frame(&header, payload, m::ARTIFACT_PAYLOAD_MAX_BYTES)
            .expect("frame encodes")
    }

    /// Every frame the supervisor wrote, in order, as `(kind, payload)`.
    fn answers(written: &[u8]) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        let mut rest = written;
        while !rest.is_empty() {
            let (frame, consumed) =
                secure_fs::supervisor::frame::decode_frame(rest, m::ARTIFACT_PAYLOAD_MAX_BYTES)
                    .expect("the supervisor writes decodable frames");
            let header: Value = serde_json::from_slice(&frame.header).expect("header is json");
            let payload: Value = serde_json::from_slice(&frame.payload).expect("payload is json");
            out.push((header["kind"].as_str().expect("kind").to_owned(), payload));
            rest = &rest[consumed..];
        }
        out
    }

    /// A series shaped as the driver's leg record is, carrying the grant the
    /// loop handed back for the execution it opened.
    fn leg(grant: &Value, first_at_ms: f64, latency_ms: f64, count: usize) -> Vec<u8> {
        let mut samples = Vec::new();
        let mut trips = Vec::new();
        let mut sent = first_at_ms;
        let mut last = first_at_ms;
        for sequence in 1..=count {
            let received = sent + latency_ms;
            samples.push(serde_json::json!(latency_ms));
            trips.push(serde_json::json!({
                "sequence": sequence,
                "sentAtMs": sent,
                "receivedAtMs": received,
                "latencyMs": latency_ms,
            }));
            last = received;
            sent = received + 0.2;
        }
        let record = serde_json::json!({
            "grant": grant,
            "samples": samples,
            "roundTrips": trips,
            "ledger": { "attempted": count, "delivered": count },
            "provenance": {
                "sampleCount": count,
                "firstSampleAtMs": first_at_ms,
                "lastSampleAtMs": last,
            },
        });
        let mut bytes = serde_json::to_vec(&record).expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    /// Open one execution against a running loop and return the grant the
    /// child would have been handed.
    fn open_one(resident: &mut ResidentLoop, run_id: &str, transport: &str, count: u64) -> Value {
        let payload = resident
            .open_next_execution(run_id, transport, count, 1_024)
            .expect("the loop opens an execution");
        serde_json::from_slice(&payload).expect("the run-command payload is a record")
    }

    #[test]
    fn accepted_measurement_survives_consuming_the_open_grant() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let grant = open_one(&mut resident, "retained", "ws", 64);
        let issued = grant["issuedAt"].as_f64().unwrap();
        let payload = leg(&grant, issued + 2.0, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let (receipt, _) = resident
            .present_artifact_payload(&framed("artifact-payload", &payload))
            .unwrap();
        assert!(resident.open.is_none());
        let accepted = resident
            .accepted
            .as_ref()
            .expect("immutable accepted facts");
        assert_eq!(
            accepted.receipt.canonical_bytes(),
            receipt.canonical_bytes()
        );
        assert_eq!(accepted.payload, payload);
        assert_eq!(
            serde_json::from_slice::<Value>(&accepted.grant).unwrap(),
            grant
        );
        assert!(resident
            .present_artifact_payload(&framed("artifact-payload", &payload))
            .is_err());
        assert_eq!(
            resident
                .accepted
                .as_ref()
                .unwrap()
                .receipt
                .canonical_bytes(),
            receipt.canonical_bytes()
        );
        open_one(&mut resident, "next", "wt", 64);
        assert!(
            resident.accepted.is_none(),
            "next execution cannot inherit admitted evidence"
        );
        assert_eq!(resident.open.as_ref().unwrap().key.execution_index, 2);
    }

    #[test]
    fn execution_draft_must_match_every_bootstrap_identity() {
        let authority = ExecutionAuthority {
            authority_sha256: sha256_hex(b"authority"),
            campaign_lock_sha256: sha256_hex(b"lock"),
            staged_capability_sha256: sha256_hex(b"capability"),
            source_archive_sha256: sha256_hex(b"source"),
            approved_plan_sha256: sha256_hex(b"plan"),
            approval_record_sha256: sha256_hex(b"approval"),
        };
        let draft = serde_json::json!({
            "authoritySha256": authority.authority_sha256,
            "campaignLockSha256": authority.campaign_lock_sha256,
            "stagedCapabilitySha256": authority.staged_capability_sha256,
            "sourceArchiveSha256": authority.source_archive_sha256,
            "approvedPlanSha256": authority.approved_plan_sha256,
            "approvalRecordSha256": authority.approval_record_sha256,
            "campaignId": "campaign", "candidate": "candidate",
        });
        assert!(authority.validate(&draft, "campaign", "candidate").is_ok());
        for field in draft.as_object().unwrap().keys() {
            let mut forged = draft.clone();
            forged[field] = serde_json::json!("another");
            assert_eq!(
                authority.validate(&forged, "campaign", "candidate"),
                Err("CROSS_SUPERVISOR_MISMATCH"),
                "{field}"
            );
        }
    }

    #[test]
    fn an_honest_leg_carried_over_the_loops_frames_is_admitted_and_written() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        // Opened first, so the grant in the payload is one this loop minted
        // and the bracket's lower edge is already stamped.
        let grant = open_one(&mut resident, "run-cell-001", "ws", 64);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = leg(&grant, issued + 2.0, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));

        let session = framed("artifact-payload", &payload);
        let summary = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("the session ends cleanly");

        assert_eq!(summary.admitted, 1);
        assert_eq!(summary.refused, 0);
        // Written, and written with the bytes the supervisor admitted rather
        // than with anything the controller assembled afterwards.
        assert_eq!(sink.committed.len(), 1);
        assert_eq!(sink.committed[0].0, 1);
        assert_eq!(sink.committed[0].1, payload);

        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "admission-receipt");
        let receipt = &answered[0].1;
        assert_eq!(receipt["schema"], "measurement-admission/v1");
        assert_eq!(receipt["campaignId"], "r1-phase3");
        assert_eq!(receipt["runId"], "run-cell-001");
        assert_eq!(receipt["executionIndex"], 1);
        assert_eq!(receipt["transport"], "ws");
        assert_eq!(receipt["sampleCount"], 6);
        assert_eq!(receipt["delivered"], 6);
        assert_eq!(
            receipt["payloadSha256"].as_str().expect("payload digest"),
            m::sha256_hex_of(&payload)
        );
        assert!(
            (receipt["latencySumMs"].as_f64().expect("sum") - 3.0).abs() < 1e-9,
            "the receipt reports the supervisor's own sum, not the child's"
        );
    }

    /// The audit's forgery, carried over the loop's own frames: a stepping
    /// clock claiming a fifty-seven-second window inside a bracket a few
    /// milliseconds wide.  Refused, and — the part that matters — the sink is
    /// never called, so there is nothing on disk to publish.
    #[test]
    fn the_stepping_clock_forgery_is_refused_and_nothing_is_written() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        let grant = open_one(&mut resident, "run-cell-001", "wt", 1_000);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        // 1,000 samples at 3.2 ms on a stepping clock: the series the audit
        // published, verbatim in shape.
        let payload = leg(&grant, issued + 1.0, 3.2, 1_000);

        let session = framed("artifact-payload", &payload);
        let summary = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("a refused execution does not end the session");

        assert_eq!(summary.admitted, 0);
        assert_eq!(summary.refused, 1);
        assert!(sink.committed.is_empty(), "a refused series is unwritable");
        let answered = answers(&written);
        assert_eq!(answered[0].0, "admission-refusal");
        assert_eq!(answered[0].1["code"], "MEASUREMENT_OUTSIDE_GRANT_WINDOW");
    }

    /// One execution, one presentation — over the frames this time.  The
    /// second `artifact-payload` finds no execution open, which is the same
    /// answer as an unsolicited one and a late one.
    #[test]
    fn a_second_presentation_finds_no_execution_open() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        let grant = open_one(&mut resident, "run-cell-001", "ws", 64);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = leg(&grant, issued + 2.0, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));

        let mut session = framed("artifact-payload", &payload);
        session.extend_from_slice(&framed("artifact-payload", &payload));
        let summary = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("the session survives the refusal");

        assert_eq!((summary.admitted, summary.refused), (1, 1));
        assert_eq!(sink.committed.len(), 1, "the honest leg is written once");
        let answered = answers(&written);
        assert_eq!(answered[0].0, "admission-receipt");
        assert_eq!(answered[1].0, "admission-refusal");
        assert_eq!(answered[1].1["code"], "MEASUREMENT_GRANT_ABSENT");
    }

    /// The controller drives the whole exchange: it asks for an execution, the
    /// supervisor answers with the grant, and the index in that grant is the
    /// supervisor's own counter rather than anything the request named.
    #[test]
    fn the_loop_assigns_the_execution_index_itself() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        let mut session = framed("open-execution", &open_request("run-a", "ws", 64));
        session.extend_from_slice(&framed(
            "open-execution",
            // The request names no execution index and could not: the field
            // does not exist in the request record, and a strict parse of a
            // record carrying one would refuse it.
            &open_request("run-b", "wt", 64),
        ));
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("both executions open");

        let answered = answers(&written);
        assert_eq!(answered.len(), 2);
        assert_eq!(answered[0].0, "run-command");
        assert_eq!(answered[0].1["executionIndex"], 1);
        assert_eq!(answered[0].1["campaignId"], "r1-phase3");
        assert_eq!(answered[1].1["executionIndex"], 2);
        assert_eq!(answered[1].1["runId"], "run-b");
        assert!(sink.committed.is_empty());
    }

    /// Opening the next execution abandons the one before it, so the
    /// abandoned execution's grant is spent and its leg can never be
    /// presented afterwards.
    #[test]
    fn an_abandoned_execution_cannot_present_later() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        let abandoned = open_one(&mut resident, "run-cell-001", "ws", 64);
        let issued = abandoned["issuedAt"].as_f64().expect("issuedAt");
        let payload = leg(&abandoned, issued + 2.0, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _next = open_one(&mut resident, "run-cell-002", "ws", 64);

        let session = framed("artifact-payload", &payload);
        let summary = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("the session survives");
        assert_eq!((summary.admitted, summary.refused), (0, 1));
        assert!(sink.committed.is_empty());
        assert_eq!(
            answers(&written)[0].1["code"],
            "MEASUREMENT_GRANT_ABSENT",
            "the abandoned grant was spent when the next execution opened"
        );
    }

    /// A frame the codec cannot decode is not a refusal of a series — it is a
    /// peer that is not speaking the protocol, so no later byte can be trusted
    /// to be a frame boundary and the session ends.
    #[test]
    fn a_truncated_frame_ends_the_session_and_writes_nothing() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        let grant = open_one(&mut resident, "run-cell-001", "ws", 64);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let full = framed("artifact-payload", &leg(&grant, issued + 2.0, 0.5, 6));
        let truncated = &full[..full.len() - 8];

        assert_eq!(
            resident.serve(&mut &truncated[..], &mut written, &mut sink),
            Err("TRUST_CHILD_FRAME_INVALID")
        );
        assert!(sink.committed.is_empty());
        assert_eq!(answers(&written)[0].1["code"], "TRUST_CHILD_FRAME_INVALID");
    }

    /// A frame whose header names a kind this loop does not serve is refused
    /// on the header, before its payload is looked at as a series at all.
    #[test]
    fn a_frame_of_another_kind_is_never_admitted() {
        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();
        let mut written = Vec::new();

        let grant = open_one(&mut resident, "run-cell-001", "ws", 64);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let session = framed("server-telemetry", &leg(&grant, issued + 2.0, 0.5, 6));

        assert_eq!(
            resident.serve(&mut session.as_slice(), &mut written, &mut sink),
            Err("TRUST_CHILD_FRAME_INVALID")
        );
        assert!(sink.committed.is_empty());
    }

    /// The transport over real descriptors rather than over slices: the
    /// supervisor reads its frames from one pipe and answers on another, which
    /// is exactly how `main` runs it.
    #[test]
    fn the_loop_carries_its_frames_over_real_descriptors() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixStream;

        let mut resident = ResidentLoop::new("r1-phase3", "candidate-phase3");
        let mut sink = RecordingSink::default();

        let grant = open_one(&mut resident, "run-cell-001", "ws", 64);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = leg(&grant, issued + 2.0, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));

        let (mut controller_in, mut supervisor_in) = UnixStream::pair().expect("pipe pair");
        let (mut supervisor_out, mut controller_out) = UnixStream::pair().expect("pipe pair");
        let frame = framed("artifact-payload", &payload);
        let writer = std::thread::spawn(move || {
            controller_in.write_all(&frame).expect("controller writes");
            // Half-close, so the supervisor sees the clean end of a session
            // rather than blocking on a peer that has nothing more to say.
            controller_in
                .shutdown(std::net::Shutdown::Write)
                .expect("half close");
            let mut back = Vec::new();
            controller_out
                .read_to_end(&mut back)
                .expect("controller reads");
            back
        });

        let summary = resident
            .serve(&mut supervisor_in, &mut supervisor_out, &mut sink)
            .expect("the session ends cleanly");
        drop(supervisor_out);
        let back = writer.join().expect("controller thread");

        assert_eq!((summary.admitted, summary.refused), (1, 0));
        assert_eq!(sink.committed.len(), 1);
        let answered = answers(&back);
        assert_eq!(answered[0].0, "admission-receipt");
        assert_eq!(
            answered[0].1["payloadSha256"].as_str().expect("digest"),
            m::sha256_hex_of(&payload)
        );
    }
}

/// B3.5: the resident loop speaks the §5 controller <-> rig cohort protocol.
///
/// `rig_cohort_runtime.rs` proves the transitions; these prove they are
/// reachable — that a cohort request arriving as a frame is routed to its
/// transition, that the ack goes back as the frame kind the §3.3 registry
/// names, and that a supervisor holding no cohort refuses every one of them
/// without ending the session or touching the measured path.
#[cfg(all(test, not(windows)))]
mod cohort_dispatch_tests {
    use super::*;
    use secure_fs::cohort::rig::{
        AbsentServerChild, RigCohortRuntime, ServerSpawner, SpawnServerRequest, SpawnedServerChild,
        COHORT_REQUEST_KINDS,
    };
    use secure_fs::cohort::{
        canonical_bytes, sha256_hex, shard_commitment_window_end, CohortRefusal,
        SUBSCRIBER_SHARD_MODULUS,
    };
    use secure_fs::cross_supervisor::{generate_ed25519_keypair, public_key_sha256, sign_bytes};
    use secure_fs::measurement::{self as m, AdmissionReceipt, AdmittedSink};
    use serde_json::{json, Value};

    #[derive(Default)]
    struct NullSink;

    impl AdmittedSink for NullSink {
        fn commit(
            &mut self,
            _receipt: &AdmissionReceipt,
            _payload: &[u8],
        ) -> Result<(), &'static str> {
            Ok(())
        }
    }

    struct RefusingSpawner;

    impl ServerSpawner for RefusingSpawner {
        fn spawn(
            &mut self,
            _request: &SpawnServerRequest,
        ) -> Result<SpawnedServerChild, CohortRefusal> {
            Err(CohortRefusal::NotReady("no launcher"))
        }
    }

    fn digest(tag: &str) -> String {
        sha256_hex(tag.as_bytes())
    }

    fn framed(kind: &str, payload: &[u8]) -> Vec<u8> {
        let mut header = serde_json::to_vec(&json!({
            "kind": kind,
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        secure_fs::supervisor::frame::encode_frame(&header, payload, m::ARTIFACT_PAYLOAD_MAX_BYTES)
            .expect("frame encodes")
    }

    fn answers(written: &[u8]) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        let mut rest = written;
        while !rest.is_empty() {
            let (frame, consumed) =
                secure_fs::supervisor::frame::decode_frame(rest, m::ARTIFACT_PAYLOAD_MAX_BYTES)
                    .expect("the supervisor writes decodable frames");
            let header: Value = serde_json::from_slice(&frame.header).expect("header is json");
            let payload: Value = serde_json::from_slice(&frame.payload).expect("payload is json");
            out.push((header["kind"].as_str().expect("kind").to_owned(), payload));
            rest = &rest[consumed..];
        }
        out
    }

    /// The minimal signed cohort grant these tests hand the loop: one
    /// publisher, eight shards, and the one commitment root the grant names.
    fn grant_value(key_sha256: &str, root_sha256: &str, publisher_token: &str) -> Value {
        let mut shards = Vec::new();
        for worker_index in 0..SUBSCRIBER_SHARD_MODULUS {
            shards.push(json!({
                "schema": "subscriber-shard/v1",
                "childId": format!("worker-{worker_index}"),
                "workerIndex": worker_index,
                "modulus": SUBSCRIBER_SHARD_MODULUS,
                "residue": worker_index,
                "firstSubscriberIndex": 0,
                "lastSubscriberIndexExclusive": SUBSCRIBER_SHARD_MODULUS,
                "subscriberCount": 1,
                "orderedSubscriberIdsSha256": digest(&format!("shard-{worker_index}")),
                "firstTokenCommitmentIndex": worker_index + 1,
                // One member per shard: the residue window is `[first, first + 1)`.
                "lastTokenCommitmentIndexExclusive": worker_index + 2,
            }));
        }
        json!({
            "schema": "cohort-grant/v1",
            "execution": { "schema": "cross-supervisor-execution/v1", "executionIndex": 1 },
            "executionSha256": digest("execution"),
            "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "cohortId": "cohort-ticker-b35-dispatch",
            "cohortAttempt": 1,
            "scenarioHash": digest("scenario"),
            "rolePlanHash": digest("role-plan"),
            "workloadRolePlanInputSha256": digest("workload-role-plan-input"),
            "transport": "ws",
            "publisherCount": 1,
            "subscriberCount": SUBSCRIBER_SHARD_MODULUS,
            "workerCount": SUBSCRIBER_SHARD_MODULUS,
            "expectedProcessCount": SUBSCRIBER_SHARD_MODULUS + 1,
            "expectedSessionCount": SUBSCRIBER_SHARD_MODULUS + 1,
            "publishers": [{
                "schema": "publisher-role-grant/v1",
                "childId": "publisher-000000",
                "publisherId": "publisher-000000",
                "tokenCommitmentIndex": 0,
                "tokenSha256": publisher_token,
            }],
            "subscriberShards": shards,
            "tokenCommitmentLeafManifestSha256": digest("leaf-manifest"),
            "roleTokenCommitmentRootSha256": root_sha256,
            "roleTokenCommitmentCount": SUBSCRIBER_SHARD_MODULUS + 1,
            "connectionRatePerSecond": 500,
            "maxConnectionsInFlight": 200,
            "readinessDeadlineMs": 30000,
            "inRepetitionWarmupMs": 5000,
            "sampleWindowMs": 1000,
            "measuredDurationMs": 10000,
            "drainDeadlineMs": 10000,
            "messageBytes": 100,
            "expectedOfferedIngress": 100,
            "expectedExpandedDeliveries": 800,
            "macSupervisorInstanceNonce": digest("mac-instance-1"),
            "signingPublicKeySha256": key_sha256,
            "receiptSequence": 0,
            "issuedAtMs": 1_760_000_000_000u64,
            "notAfterMs": 1_760_000_600_000u64,
        })
    }

    fn base64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// This rig's own `rig-execution-acceptance/v1` for one execution, and
    /// the `rig-receipt-signature/v1` record covering it.
    ///
    /// §2.13 moved the pair off two startup descriptors and onto
    /// `rig-accept-cohort-request/v1`, so the fixture mints one per execution
    /// rather than one per process.
    fn rig_acceptance(
        rig_keys: &secure_fs::cross_supervisor::Ed25519KeyPair,
        execution_tag: &str,
    ) -> (Vec<u8>, Vec<u8>) {
        let key_sha256 = public_key_sha256(&rig_keys.public_raw32);
        let acceptance = canonical_bytes(&json!({
            "schema": "rig-execution-acceptance/v1",
            "executionSha256": digest(execution_tag),
            "measurementGrantSha256": digest("measurement-grant"),
            "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
            "macReceiptSignatureSha256": digest("mac-receipt-signature"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "rigExecutionIndex": 1,
            "rigSupervisorInstanceNonce": digest("rig-instance"),
            "rigSupervisorExecutableSha256": digest("rig-executable"),
            "replayLedgerLeafSha256": digest("replay-leaf"),
            "signingPublicKeySha256": key_sha256,
            "receiptSequence": 1,
            "acceptedAtMs": 1_760_000_000_000u64,
            "issuedAtMs": 1_760_000_000_000u64,
            "notAfterMs": 1_760_000_600_000u64,
        }))
        .expect("canonical acceptance");
        let raw = sign_bytes(&rig_keys.private_pkcs8_der, &acceptance).expect("sign");
        let signature_record = canonical_bytes(&json!({
            "schema": "rig-receipt-signature/v1",
            "algorithm": "Ed25519",
            "signedSchema": "rig-execution-acceptance/v1",
            "signedBytesSha256": sha256_hex(&acceptance),
            "signingPublicKeySha256": key_sha256,
            "signatureBase64": base64(&raw),
        }))
        .expect("canonical signature record");
        (acceptance, signature_record)
    }

    /// A loop holding a live campaign-scoped cohort runtime, and the accept
    /// request one execution's grant and acceptance are carried in.
    fn loop_with_cohort() -> (ResidentLoop, Vec<u8>) {
        let mac = generate_ed25519_keypair();
        let rig_keys = generate_ed25519_keypair();
        let runtime = RigCohortRuntime::new(
            rig_keys.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            mac.public_raw32,
            &digest("linux-clock"),
            &digest("rig-instance"),
            &digest("rig-executable"),
        )
        .expect("a shaped campaign runtime");
        let mut resident = ResidentLoop::new("r1-b35", "candidate-b35");
        resident
            .install_cohort_runtime(CohortRuntime {
                runtime,
                spawner: Box::new(RefusingSpawner),
                child: Box::new(AbsentServerChild),
            })
            .expect("one cohort per session");

        // The commitment root the grant names is the one the cohort's own
        // leaf set reaches; the loop never sees the leaves, only the root.
        let mut leaves = vec![secure_fs::cohort::TokenCommitmentLeafV1 {
            child_id: "publisher-000000".to_owned(),
            cohort_id: "cohort-ticker-b35-dispatch".to_owned(),
            role: "publisher".to_owned(),
            role_id: "publisher-000000".to_owned(),
            token_sha256: digest("token/publisher-000000"),
            worker_index: None,
        }];
        for index in 0..SUBSCRIBER_SHARD_MODULUS {
            leaves.push(secure_fs::cohort::TokenCommitmentLeafV1 {
                child_id: format!("worker-{index}"),
                cohort_id: "cohort-ticker-b35-dispatch".to_owned(),
                role: "subscriber".to_owned(),
                role_id: format!("subscriber-{index:06}"),
                token_sha256: digest(&format!("token/subscriber-{index:06}")),
                worker_index: Some(index as i64),
            });
        }
        let nodes = secure_fs::cohort::ordered_leaf_nodes(&mut leaves).expect("leaves");
        let root = secure_fs::cohort::merkle_root(&nodes).expect("root");
        let root_hex: String = root.iter().map(|byte| format!("{byte:02x}")).collect();
        let publisher_token = leaves
            .iter()
            .find(|leaf| leaf.role == "publisher")
            .expect("publisher leaf")
            .token_sha256
            .clone();

        let grant = grant_value(
            &public_key_sha256(&mac.public_raw32),
            &root_hex,
            &publisher_token,
        );
        let grant_bytes = canonical_bytes(&grant).expect("canonical grant");
        let raw = sign_bytes(&mac.private_pkcs8_der, &grant_bytes).expect("sign");
        let signature_record = canonical_bytes(&json!({
            "schema": "mac-receipt-signature/v1",
            "algorithm": "Ed25519",
            "signedSchema": "cohort-grant/v1",
            "signedBytesSha256": sha256_hex(&grant_bytes),
            "signingPublicKeySha256": public_key_sha256(&mac.public_raw32),
            "signatureBase64": base64(&raw),
        }))
        .expect("canonical signature record");
        let (acceptance, acceptance_signature) = rig_acceptance(&rig_keys, "execution");
        let request = canonical_bytes(&json!({
            "schema": "rig-accept-cohort-request/v1",
            "requestSeq": 1,
            "executionSha256": digest("execution"),
            "cohortGrantBase64": base64(&grant_bytes),
            "cohortGrantSignatureBase64": base64(&signature_record),
            "rigExecutionAcceptanceBase64": base64(&acceptance),
            "rigExecutionAcceptanceSignatureBase64": base64(&acceptance_signature),
        }))
        .expect("canonical request");
        (resident, request)
    }

    /// The transition actually runs over the loop's own frames, and the
    /// answer comes back under the ack kind the §3.3 registry names.
    #[test]
    fn a_cohort_request_frame_is_routed_to_its_transition_and_acked() {
        let (mut resident, request) = loop_with_cohort();
        let mut written = Vec::new();
        let mut sink = NullSink;
        let session = framed("rig-accept-cohort-request", &request);
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("the session ends cleanly");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "rig-cohort-accepted-ack");
        assert_eq!(answered[0].1["schema"], "rig-cohort-accepted-ack/v1");
        assert_eq!(answered[0].1["ackRequestSeq"], 1);
        assert!(answered[0].1["rigCohortAcceptanceSignatureBase64"].is_string());
    }

    /// §2.7: a refused cohort transition answers `remote-supervisor-refusal/v1`
    /// and **ends the arm**.
    ///
    /// Not `measurement-refusal/v1`: plan 531 says "The refusal kind is
    /// `remote-supervisor-refusal`. No alias kind is accepted." And
    /// `terminal: true` is not decoration — one remote channel carries one
    /// open execution, so exactly one refusal reaches the controller however
    /// many requests were queued behind it.
    #[test]
    fn a_refused_cohort_transition_is_a_terminal_remote_supervisor_refusal() {
        for kind in COHORT_REQUEST_KINDS {
            let mut resident = ResidentLoop::new("r1-b35", "candidate-b35");
            let mut written = Vec::new();
            let mut sink = NullSink;
            let payload = canonical_bytes(&json!({
                "schema": format!("{kind}/v1"),
                "requestSeq": 4,
                "executionSha256": digest("execution"),
            }))
            .expect("canonical request");
            // Two frames go in; the terminal refusal means only the first is
            // ever read.
            let mut session = framed(kind, &payload);
            session.extend_from_slice(&framed(kind, &payload));
            let code = resident
                .serve(&mut session.as_slice(), &mut written, &mut sink)
                .expect_err("a refused cohort transition ends the arm");
            assert_eq!(code, "COHORT_NOT_READY");
            let answered = answers(&written);
            assert_eq!(answered.len(), 1, "{kind}: exactly one refusal");
            assert_eq!(answered[0].0, "remote-supervisor-refusal");
            let refusal = &answered[0].1;
            assert_eq!(refusal["schema"], "remote-supervisor-refusal/v1");
            assert_eq!(refusal["responseSeq"], 0);
            assert_eq!(refusal["ackRequestSeq"], 4);
            // No session exists, so there is no *bound* execution: the frame's
            // own digest is not echoed back as though this rig had accepted it.
            assert!(refusal["executionSha256"].is_null());
            assert_eq!(refusal["code"], "COHORT_NOT_READY");
            assert_eq!(refusal["campaignStatus"], "FAIL");
            assert_eq!(refusal["terminal"], true);
        }
    }

    /// A refusal states what it read.  A cohort payload with no `requestSeq`
    /// is a malformed frame and takes the malformed-frame path rather than
    /// being answered with an `ackRequestSeq` this supervisor invented.
    #[test]
    fn a_cohort_payload_with_no_request_seq_is_a_malformed_frame_not_a_refusal() {
        let mut resident = ResidentLoop::new("r1-b35", "candidate-b35");
        let mut written = Vec::new();
        let mut sink = NullSink;
        let session = framed("rig-accept-cohort-request", b"{}\n");
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("a payload with no requestSeq ends the session");
        assert_eq!(code, "TRUST_CHILD_FRAME_INVALID");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, m::ADMISSION_REFUSAL_KIND);
    }

    /// The trust-bootstrap argv carries the campaign root on the Mac pair and
    /// omits it on the Linux rig's single root; the entrypoint resolves both
    /// shapes and leaves the platform decision to `bootstrap::root_descriptors`.
    #[test]
    fn the_campaign_root_descriptor_is_optional_in_the_argv_and_distinct_when_present() {
        let owned =
            |args: &[&str]| -> Vec<String> { args.iter().map(|arg| (*arg).to_string()).collect() };
        let pair = resolve_descriptors(&owned(&[
            "--authority-fd",
            "3",
            "--authority-digest-fd",
            "4",
            "--campaign-root-fd",
            "5",
            "--staging-root-fd",
            "6",
        ]))
        .expect("the Mac pair resolves");
        assert_eq!(pair.campaign_root_fd, Some(5));
        assert_eq!(pair.staging_root_fd, 6);
        let single = resolve_descriptors(&owned(&[
            "--authority-fd",
            "3",
            "--authority-digest-fd",
            "4",
            "--staging-root-fd",
            "6",
        ]))
        .expect("the single root resolves");
        assert_eq!(single.campaign_root_fd, None);
        assert_eq!(single.staging_root_fd, 6);
        // Present but aliased onto another descriptor, or present without a
        // number: refused as before.
        for args in [
            &[
                "--authority-fd",
                "3",
                "--authority-digest-fd",
                "4",
                "--campaign-root-fd",
                "6",
                "--staging-root-fd",
                "6",
            ][..],
            &[
                "--authority-fd",
                "3",
                "--authority-digest-fd",
                "4",
                "--staging-root-fd",
                "6",
                "--campaign-root-fd",
            ][..],
        ] {
            assert_eq!(
                resolve_descriptors(&owned(args)).expect_err("refused"),
                "TRUST_DESCRIPTOR_ARGUMENT_INVALID"
            );
        }
        // The staging root is never optional.
        assert_eq!(
            resolve_descriptors(&owned(&[
                "--authority-fd",
                "3",
                "--authority-digest-fd",
                "4",
                "--campaign-root-fd",
                "5",
            ]))
            .expect_err("no staging root"),
            "TRUST_DESCRIPTOR_ARGUMENT_INVALID"
        );
    }

    /// §2.9(1): the Mac cohort install takes **two** campaign-scoped
    /// descriptors, all-or-none, and all distinct.
    ///
    /// The pairing is the property. A supervisor holding the Mac signing key
    /// but not the staged rig public key could sign a barrier over a rig
    /// record it never authenticated — which is the one thing §2.9 exists to
    /// make impossible — so half a set is refused rather than degraded.
    #[test]
    fn the_mac_cohort_install_descriptors_are_all_or_none_and_all_distinct() {
        let owned =
            |args: &[&str]| -> Vec<String> { args.iter().map(|arg| (*arg).to_string()).collect() };
        // Absent entirely: not a cohort supervisor, and not an error.
        assert!(
            mac_cohort_install_descriptors(&owned(&["--authority-fd", "3"]))
                .expect("absent is not an error")
                .is_none()
        );

        let all = owned(&[
            "--authority-fd",
            "3",
            "--cohort-mac-signing-key-fd",
            "7",
            "--cohort-staged-rig-public-key-fd",
            "8",
        ]);
        let resolved = mac_cohort_install_descriptors(&all)
            .expect("a complete set resolves")
            .expect("a complete set is present");
        assert_eq!(resolved.mac_signing_key_fd, 7);
        assert_eq!(resolved.staged_rig_public_key_fd, 8);

        // Either one alone is refused, in both orders, so the rule is the
        // pairing and not the presence of a particular name.
        for name in [
            "--cohort-mac-signing-key-fd",
            "--cohort-staged-rig-public-key-fd",
        ] {
            let partial = owned(&["--authority-fd", "3", name, "7"]);
            assert_eq!(
                mac_cohort_install_descriptors(&partial).expect_err("one is not two"),
                "TRUST_DESCRIPTOR_ARGUMENT_INVALID",
            );
        }

        // Two names on one descriptor number: the process would read the key
        // twice and the rig public key never.
        let aliased = owned(&[
            "--cohort-mac-signing-key-fd",
            "7",
            "--cohort-staged-rig-public-key-fd",
            "7",
        ]);
        assert_eq!(
            mac_cohort_install_descriptors(&aliased).expect_err("distinct numbers"),
            "TRUST_DESCRIPTOR_ARGUMENT_INVALID",
        );

        // The Mac set and the rig set are independent: a rig supervisor's
        // arguments resolve to no Mac cohort, and the reverse.
        let rig_only = owned(&["--cohort-signing-key-fd", "7", "--cohort-role-root-fd", "8"]);
        assert!(mac_cohort_install_descriptors(&rig_only)
            .expect("rig arguments are not a Mac cohort")
            .is_none());
        assert!(cohort_install_descriptors(&all)
            .expect("mac arguments are not a rig cohort")
            .is_none());
    }

    /// Every controller -> Mac request kind the registry names is answered by
    /// this binary's dispatch, and by no other arm of it.
    ///
    /// The rig list spent a round in schema spelling, so nothing the
    /// controller could encode ever reached its dispatch. This asserts the two
    /// kind sets are disjoint and that the Mac arm is reachable.
    #[test]
    fn the_mac_and_rig_dispatch_kind_sets_are_disjoint() {
        use secure_fs::cohort::{mac, rig};
        for kind in mac::MAC_REQUEST_KINDS {
            assert!(mac::ack_kind_for(kind).is_some(), "{kind}");
            assert!(
                rig::ack_kind_for(kind).is_none(),
                "{kind} reaches both dispatches",
            );
        }
        for kind in rig::COHORT_REQUEST_KINDS {
            assert!(
                mac::ack_kind_for(kind).is_none(),
                "{kind} reaches both dispatches",
            );
        }
    }

    /// §2.13: one campaign-scoped rig process serves four executions, each
    /// with its own binding, because the acceptance travels on the frame.
    ///
    /// Before this change `install_production_cohort_runtime` read one
    /// acceptance at process start, so executions 2, 3 and 4 refused on
    /// `executionSha256` and two sealed arms of §3.2 were unreachable.
    #[test]
    fn one_rig_process_serves_four_executions_with_distinct_bindings() {
        let mac = generate_ed25519_keypair();
        let rig_keys = generate_ed25519_keypair();
        let mut runtime = RigCohortRuntime::new(
            rig_keys.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            mac.public_raw32,
            &digest("linux-clock"),
            &digest("rig-instance"),
            &digest("rig-executable"),
        )
        .expect("a shaped campaign runtime");

        let mut accepted = Vec::new();
        for execution in 0..4usize {
            let tag = format!("execution-{execution}");
            let (acceptance, acceptance_signature) = rig_acceptance(&rig_keys, &tag);
            let request = accept_request_for(&mac, &acceptance, &acceptance_signature, &tag);
            let ack = runtime
                .accept_cohort(&request, 1_760_000_100_000)
                .unwrap_or_else(|refusal| panic!("execution {execution}: {}", refusal.code()));
            let value: Value = serde_json::from_slice(&ack).expect("json ack");
            assert_eq!(value["executionSha256"], digest(&tag));
            // Every session is its own answer stream: a shared counter would
            // make execution 2's first ack read as execution 1's second.
            assert_eq!(value["responseSeq"], 0);
            accepted.push(
                value["cohortGrantSha256"]
                    .as_str()
                    .expect("grant")
                    .to_owned(),
            );
        }
        assert_eq!(runtime.session_count(), 4);
        // Four distinct executions, four distinct grants.
        let mut sorted = accepted.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 4);
    }

    /// An acceptance minted for another execution is refused at the transition
    /// that reads it, not carried into a session bound to something else.
    #[test]
    fn an_acceptance_for_another_execution_is_refused_at_accept_cohort() {
        let mac = generate_ed25519_keypair();
        let rig_keys = generate_ed25519_keypair();
        let mut runtime = RigCohortRuntime::new(
            rig_keys.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            mac.public_raw32,
            &digest("linux-clock"),
            &digest("rig-instance"),
            &digest("rig-executable"),
        )
        .expect("a shaped campaign runtime");
        // The acceptance names execution A; the frame and its grant name B.
        let (acceptance, acceptance_signature) = rig_acceptance(&rig_keys, "execution-A");
        let request = accept_request_for(&mac, &acceptance, &acceptance_signature, "execution-B");
        let refusal = runtime
            .accept_cohort(&request, 1_760_000_100_000)
            .expect_err("an acceptance for another execution binds nothing");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
        assert_eq!(runtime.session_count(), 0);

        // And the frame's own `executionSha256` is checked against the binding
        // the acceptance established, not merely against the grant. Here the
        // acceptance and the grant agree on execution A and only the frame
        // says C, which is the shape a router that trusted the frame's key
        // would let through.
        let honest = accept_request_for(&mac, &acceptance, &acceptance_signature, "execution-A");
        let mut edited: Value = serde_json::from_slice(&honest).expect("json request");
        edited["executionSha256"] = Value::from(digest("execution-C"));
        let refusal = runtime
            .accept_cohort(
                &canonical_bytes(&edited).expect("canonical"),
                1_760_000_100_000,
            )
            .expect_err("a frame naming another execution binds nothing");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
        assert_eq!(runtime.session_count(), 0);
    }

    /// One `rig-accept-cohort-request/v1` for the named execution, carrying a
    /// Mac-signed grant for that same execution and the rig acceptance handed
    /// in.
    fn accept_request_for(
        mac: &secure_fs::cross_supervisor::Ed25519KeyPair,
        acceptance: &[u8],
        acceptance_signature: &[u8],
        execution_tag: &str,
    ) -> Vec<u8> {
        accept_request_bound(
            mac,
            acceptance,
            acceptance_signature,
            &digest(execution_tag),
            &digest("mac-execution-grant-receipt"),
        )
    }

    /// An accept-cohort request whose Mac-signed grant names exactly the
    /// execution and Mac receipt digests handed in — the shape a grant minted
    /// for an execution this rig accepted over the wire has.
    fn accept_request_bound(
        mac: &secure_fs::cross_supervisor::Ed25519KeyPair,
        acceptance: &[u8],
        acceptance_signature: &[u8],
        execution_sha256: &str,
        receipt_sha256: &str,
    ) -> Vec<u8> {
        let execution_tag = execution_sha256;
        let mut leaves = vec![secure_fs::cohort::TokenCommitmentLeafV1 {
            child_id: "publisher-000000".to_owned(),
            cohort_id: "cohort-ticker-b35-dispatch".to_owned(),
            role: "publisher".to_owned(),
            role_id: "publisher-000000".to_owned(),
            token_sha256: digest(&format!("token/{execution_tag}/publisher")),
            worker_index: None,
        }];
        for index in 0..SUBSCRIBER_SHARD_MODULUS {
            leaves.push(secure_fs::cohort::TokenCommitmentLeafV1 {
                child_id: format!("worker-{index}"),
                cohort_id: "cohort-ticker-b35-dispatch".to_owned(),
                role: "subscriber".to_owned(),
                role_id: format!("subscriber-{index:06}"),
                token_sha256: digest(&format!("token/{execution_tag}/subscriber-{index:06}")),
                worker_index: Some(index as i64),
            });
        }
        let nodes = secure_fs::cohort::ordered_leaf_nodes(&mut leaves).expect("leaves");
        let root = secure_fs::cohort::merkle_root(&nodes).expect("root");
        let root_hex: String = root.iter().map(|byte| format!("{byte:02x}")).collect();
        let publisher_token = leaves
            .iter()
            .find(|leaf| leaf.role == "publisher")
            .expect("publisher leaf")
            .token_sha256
            .clone();
        let mut grant = grant_value(
            &public_key_sha256(&mac.public_raw32),
            &root_hex,
            &publisher_token,
        );
        grant["executionSha256"] = Value::from(execution_sha256.to_owned());
        grant["macExecutionGrantReceiptSha256"] = Value::from(receipt_sha256.to_owned());
        let grant_bytes = canonical_bytes(&grant).expect("canonical grant");
        let raw = sign_bytes(&mac.private_pkcs8_der, &grant_bytes).expect("sign");
        let signature_record = canonical_bytes(&json!({
            "schema": "mac-receipt-signature/v1",
            "algorithm": "Ed25519",
            "signedSchema": "cohort-grant/v1",
            "signedBytesSha256": sha256_hex(&grant_bytes),
            "signingPublicKeySha256": public_key_sha256(&mac.public_raw32),
            "signatureBase64": base64(&raw),
        }))
        .expect("canonical signature record");
        canonical_bytes(&json!({
            "schema": "rig-accept-cohort-request/v1",
            "requestSeq": 1,
            "executionSha256": execution_sha256,
            "cohortGrantBase64": base64(&grant_bytes),
            "cohortGrantSignatureBase64": base64(&signature_record),
            "rigExecutionAcceptanceBase64": base64(acceptance),
            "rigExecutionAcceptanceSignatureBase64": base64(acceptance_signature),
        }))
        .expect("canonical request")
    }

    /// The rig runtime the Mac-side harness pairs with: staged Mac key = the
    /// harness Mac, and this rig's own key = the key the Mac runtime staged.
    fn rig_runtime_for(
        mac: &secure_fs::cross_supervisor::Ed25519KeyPair,
        rig_keys: &secure_fs::cross_supervisor::Ed25519KeyPair,
    ) -> RigCohortRuntime {
        RigCohortRuntime::new(
            rig_keys.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            mac.public_raw32,
            &digest("linux-clock"),
            &digest("rig-instance"),
            &digest("rig-executable"),
        )
        .expect("a shaped campaign runtime")
    }

    /// The Mac's half of §5 RIG_EXECUTION_ACCEPTED, minted by the real Mac
    /// dispatcher: the grant, the receipt and the Mac signature record.
    fn opened_on_the_mac() -> (
        ResidentLoop,
        secure_fs::cross_supervisor::Ed25519KeyPair,
        secure_fs::cross_supervisor::Ed25519KeyPair,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        String,
    ) {
        let (mut resident, mac, rig_keys) = loop_with_mac_runtime();
        let mut sink = NullSink;
        let mut written = Vec::new();
        let session = open_execution_frame(0, &honest_draft());
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("opened");
        let answered = answers(&written);
        let ack = &answered[0].1;
        let execution_sha256 = ack["executionSha256"]
            .as_str()
            .expect("execution")
            .to_owned();
        let grant = unbase64(ack["measurementGrantBase64"].as_str().expect("grant"));
        let receipt = unbase64(
            ack["macExecutionGrantReceiptBase64"]
                .as_str()
                .expect("receipt"),
        );
        let signature = unbase64(
            ack["macExecutionGrantSignatureBase64"]
                .as_str()
                .expect("signature"),
        );
        (
            resident,
            mac,
            rig_keys,
            grant,
            receipt,
            signature,
            execution_sha256,
        )
    }

    fn accept_execution_request(
        seq: u64,
        grant: &[u8],
        receipt: &[u8],
        signature: &[u8],
    ) -> Vec<u8> {
        canonical_bytes(&json!({
            "schema": "rig-accept-execution-request/v1",
            "requestSeq": seq,
            "measurementGrantBase64": base64(grant),
            "macExecutionGrantReceiptBase64": base64(receipt),
            "macExecutionGrantSignatureBase64": base64(signature),
        }))
        .expect("canonical request")
    }

    /// §5 RIG_EXECUTION_ACCEPTED over the real frames: the Mac opens the
    /// execution, the rig authenticates the Mac receipt under the staged key
    /// and answers with its own signed acceptance, and the acceptance is the
    /// one the cohort accept must then carry.
    #[test]
    fn the_rig_accepts_the_execution_the_mac_opened_and_binds_the_cohort_to_it() {
        let (mut resident, mac, rig_keys, grant, receipt, signature, execution_sha256) =
            opened_on_the_mac();
        resident
            .install_cohort_runtime(CohortRuntime {
                runtime: rig_runtime_for(&mac, &rig_keys),
                spawner: Box::new(RefusingSpawner),
                child: Box::new(AbsentServerChild),
            })
            .expect("one cohort per session");
        let mut sink = NullSink;

        // Frame: RIG_EXECUTION_ACCEPTED.
        let mut written = Vec::new();
        let request = accept_execution_request(0, &grant, &receipt, &signature);
        let session = framed("rig-accept-execution-request", &request);
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("accepted");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "rig-execution-accepted-ack");
        let ack = &answered[0].1;
        assert_eq!(ack["schema"], "rig-execution-accepted-ack/v1");
        assert_eq!(ack["responseSeq"], 0);
        assert_eq!(ack["ackRequestSeq"], 0);
        assert_eq!(ack["executionSha256"], execution_sha256);
        let acceptance = unbase64(
            ack["rigExecutionAcceptanceBase64"]
                .as_str()
                .expect("acceptance"),
        );
        let acceptance_signature = unbase64(
            ack["rigExecutionAcceptanceSignatureBase64"]
                .as_str()
                .expect("acceptance signature"),
        );
        // The acceptance verifies under the staged rig key through the same
        // parser the cohort transition and the Mac use.
        let inputs = secure_fs::cohort::rig::read_rig_execution_acceptance(
            &acceptance,
            &acceptance_signature,
            &rig_keys.public_raw32,
        )
        .expect("the rig's own acceptance verifies");
        assert_eq!(inputs.binding.execution_sha256, execution_sha256);
        assert_eq!(inputs.binding.measurement_grant_sha256, sha256_hex(&grant));
        assert_eq!(
            inputs.binding.mac_execution_grant_receipt_sha256,
            sha256_hex(&receipt)
        );
        assert_eq!(inputs.rig_execution_index, 1);
        assert_eq!(inputs.instance_nonce_sha256, digest("rig-instance"));
        let record: Value = serde_json::from_slice(&acceptance).expect("json");
        assert_eq!(record["macReceiptSignatureSha256"], sha256_hex(&signature));
        assert_eq!(
            record["rigSupervisorExecutableSha256"],
            digest("rig-executable")
        );
        assert_eq!(record["approvedPlanSha256"], digest("approved-plan"));
        assert_eq!(record["receiptSequence"], 1);
        let receipt_value: Value = serde_json::from_slice(&receipt).expect("receipt json");
        assert_eq!(record["notAfterMs"], receipt_value["notAfterMs"]);
        let leaf = record["replayLedgerLeafSha256"]
            .as_str()
            .expect("leaf")
            .to_owned();
        assert_eq!(
            resident
                .cohort
                .as_ref()
                .expect("rig runtime")
                .runtime
                .replay_leaf_sha256(),
            leaf,
            "the signed leaf is the chain head after this acceptance"
        );

        // Frame: COHORT_GRANTED carrying exactly that acceptance.  The
        // channel consumed responseSeq 0 above, so the session answers 1.
        let mut written = Vec::new();
        let request = accept_request_bound(
            &mac,
            &acceptance,
            &acceptance_signature,
            &execution_sha256,
            &sha256_hex(&receipt),
        );
        let session = framed("rig-accept-cohort-request", &request);
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("cohort accepted");
        let answered = answers(&written);
        assert_eq!(answered[0].0, "rig-cohort-accepted-ack");
        assert_eq!(answered[0].1["responseSeq"], 1);
        assert_eq!(answered[0].1["executionSha256"], execution_sha256);
    }

    /// The four ways the frame can lie, each refused before any acceptance is
    /// minted: a signature that does not verify, a receipt under another key,
    /// a grant that is not the one the receipt names, and the same execution
    /// presented twice.  The honest frame beside them is the test above.
    #[test]
    fn a_forged_substituted_or_replayed_execution_receipt_mints_no_acceptance() {
        let (_resident, mac, rig_keys, grant, receipt, signature, _execution) = opened_on_the_mac();
        let now = 1_760_000_100_000u64;

        // Tampered signature bytes.
        let mut runtime = rig_runtime_for(&mac, &rig_keys);
        let mut forged: Value = serde_json::from_slice(&signature).expect("signature json");
        let mut raw = unbase64(forged["signatureBase64"].as_str().expect("raw"));
        raw[0] ^= 0x01;
        forged["signatureBase64"] = Value::from(base64(&raw));
        let forged = canonical_bytes(&forged).expect("forged");
        let refusal = runtime
            .accept_execution(&accept_execution_request(0, &grant, &receipt, &forged), now)
            .expect_err("a forged signature mints nothing");
        assert_eq!(refusal.code(), "MAC_GRANT_SIGNATURE_INVALID");
        assert!(runtime.accepted_execution(&sha256_hex(&receipt)).is_none());

        // A receipt signed by a key that is not the staged Mac key.
        let other_mac = generate_ed25519_keypair();
        let mut runtime = RigCohortRuntime::new(
            rig_keys.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            other_mac.public_raw32,
            &digest("linux-clock"),
            &digest("rig-instance"),
            &digest("rig-executable"),
        )
        .expect("runtime staged with another Mac key");
        let refusal = runtime
            .accept_execution(
                &accept_execution_request(0, &grant, &receipt, &signature),
                now,
            )
            .expect_err("another key is not the staged key");
        assert_eq!(refusal.code(), "MAC_GRANT_SIGNATURE_INVALID");

        // A grant that is not the one the authenticated receipt names.
        let mut runtime = rig_runtime_for(&mac, &rig_keys);
        let mut other_grant = grant.clone();
        other_grant.push(b' ');
        let refusal = runtime
            .accept_execution(
                &accept_execution_request(0, &other_grant, &receipt, &signature),
                now,
            )
            .expect_err("the grant must be the receipt's");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");

        // An expired receipt.
        let receipt_value: Value = serde_json::from_slice(&receipt).expect("receipt json");
        let not_after = receipt_value["notAfterMs"].as_u64().expect("notAfterMs");
        let refusal = runtime
            .accept_execution(
                &accept_execution_request(0, &grant, &receipt, &signature),
                not_after + 1,
            )
            .expect_err("an expired receipt cannot be bound");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");

        // The honest frame, then the same execution again.
        runtime
            .accept_execution(
                &accept_execution_request(0, &grant, &receipt, &signature),
                now,
            )
            .expect("the honest frame is accepted");
        let refusal = runtime
            .accept_execution(
                &accept_execution_request(1, &grant, &receipt, &signature),
                now,
            )
            .expect_err("one acceptance per execution");
        assert_eq!(refusal.code(), "COHORT_PROTOCOL");
        assert_eq!(runtime.session_count(), 0);
    }

    /// Once this process has accepted an execution, the cohort accept must
    /// carry that acceptance: a second record that verifies under this rig's
    /// key but was not minted here is a substitution.
    #[test]
    fn a_cohort_accept_that_swaps_the_minted_acceptance_is_refused() {
        let (_resident, mac, rig_keys, grant, receipt, signature, execution_sha256) =
            opened_on_the_mac();
        let now = 1_760_000_100_000u64;
        let mut runtime = rig_runtime_for(&mac, &rig_keys);
        runtime
            .accept_execution(
                &accept_execution_request(0, &grant, &receipt, &signature),
                now,
            )
            .expect("accepted");
        let minted = runtime
            .accepted_execution(&execution_sha256)
            .expect("retained")
            .clone();
        // Same execution digest, same key, different record.
        let mut lookalike: Value = serde_json::from_slice(&minted.acceptance_bytes).expect("json");
        lookalike["rigExecutionIndex"] = Value::from(7);
        let lookalike_bytes = canonical_bytes(&lookalike).expect("bytes");
        let raw = sign_bytes(&rig_keys.private_pkcs8_der, &lookalike_bytes).expect("sign");
        let lookalike_signature = canonical_bytes(&json!({
            "schema": "rig-receipt-signature/v1",
            "algorithm": "Ed25519",
            "signedSchema": "rig-execution-acceptance/v1",
            "signedBytesSha256": sha256_hex(&lookalike_bytes),
            "signingPublicKeySha256": public_key_sha256(&rig_keys.public_raw32),
            "signatureBase64": base64(&raw),
        }))
        .expect("carrier");
        let refusal = runtime
            .accept_cohort(
                &accept_request_bound(
                    &mac,
                    &lookalike_bytes,
                    &lookalike_signature,
                    &execution_sha256,
                    &sha256_hex(&receipt),
                ),
                now,
            )
            .expect_err("a lookalike is not the minted acceptance");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
        // The minted one binds.
        runtime
            .accept_cohort(
                &accept_request_bound(
                    &mac,
                    &minted.acceptance_bytes,
                    &minted.signature_record,
                    &execution_sha256,
                    &sha256_hex(&receipt),
                ),
                now,
            )
            .expect("the minted acceptance binds the cohort");
        assert_eq!(runtime.session_count(), 1);
    }

    /// The four cohort-install descriptors are all-or-none, and each must be
    /// its own number.
    ///
    /// A supervisor holding a signing key but no execution binding could sign
    /// receipts for an execution nobody accepted; one holding a binding but no
    /// key could accept a cohort it cannot sign for. Both are worse than the
    /// `None` case, which is a supervisor that refuses every cohort frame with
    /// a closed code -- the state
    /// `a_supervisor_with_no_cohort_refuses_every_cohort_request_without_ending_the_session`
    /// pins.
    #[test]
    fn the_cohort_install_descriptors_are_all_or_none_and_all_distinct() {
        let owned =
            |args: &[&str]| -> Vec<String> { args.iter().map(|arg| (*arg).to_string()).collect() };
        assert!(cohort_install_descriptors(&owned(&["--authority-fd", "3"]))
            .expect("no cohort options is a supervisor with no cohort")
            .is_none());

        let all = owned(&[
            "--cohort-signing-key-fd",
            "7",
            "--cohort-role-root-fd",
            "10",
        ]);
        let resolved = cohort_install_descriptors(&all)
            .expect("two descriptors resolve")
            .expect("some");
        assert_eq!(resolved.signing_key_fd, 7);
        assert_eq!(resolved.role_root_fd, 10);

        // An option this function does not own leaves the pair alone. This is
        // `descriptor_option`'s general name-scan property, not a tolerance for
        // any particular caller: §2.13's `--cohort-execution-acceptance-fd`
        // pair was the last launcher passing one, and the wave-3.5 gate removed
        // it from `tools/compare/fanout-supervisor-integration.test.ts`, so the
        // case is pinned once with a name that is not a live regression risk.
        let mut with_unowned = all.clone();
        with_unowned.push("--not-a-descriptor-this-binary-owns".to_string());
        with_unowned.push("8".to_string());
        let resolved = cohort_install_descriptors(&with_unowned)
            .expect("an unknown option is not a descriptor")
            .expect("some");
        assert_eq!(resolved.signing_key_fd, 7);
        assert_eq!(resolved.role_root_fd, 10);

        // Either of the two alone is a launcher that asked for half a cohort.
        for drop in 0..2usize {
            let mut partial = all.clone();
            partial.drain(drop * 2..drop * 2 + 2);
            assert_eq!(
                cohort_install_descriptors(&partial).expect_err("one is not two"),
                "TRUST_DESCRIPTOR_ARGUMENT_INVALID"
            );
        }

        // One descriptor standing in for two is an aliasing this supervisor
        // must not resolve by preferring one of them.
        let mut aliased = all.clone();
        aliased[3] = "7".to_string();
        assert_eq!(
            cohort_install_descriptors(&aliased).expect_err("distinct numbers"),
            "TRUST_DESCRIPTOR_ARGUMENT_INVALID"
        );
    }

    /// Two frames the *TypeScript* controller encoder actually produced,
    /// captured byte for byte from `encodeRegisteredRemotePayload`.
    ///
    /// This is the reverse half of the cross-language conformance pair. The
    /// forward half lives in `tools/compare/fanout-production-e2e.test.ts`,
    /// which drives these same payloads at the built binary; this half proves
    /// the Rust dispatch matches the bytes without a live process, so a
    /// regression in the header spelling is a compile-and-run failure here
    /// rather than a 15-minute e2e.
    ///
    /// The test that closes the pair is
    /// `the_frames_the_rust_dispatch_pins_are_the_ones_this_encoder_produces`
    /// in `tools/compare/fanout-production-e2e.test.ts`: it re-encodes both
    /// payloads from `COHORT_REQUESTS` and asserts these exact hex strings
    /// against its own `RUST_PINNED_FRAME_HEX`, so neither side can move
    /// alone. It runs no process and builds nothing, so it is a cheap check
    /// rather than one that only fires under the e2e gate. The accept frame is
    /// §2.13's six-key form on both sides; the pair had silently diverged when
    /// this half was widened and the TypeScript half was left at four keys,
    /// which is the failure this comment exists to prevent.
    const TS_ACCEPT_COHORT_FRAME_HEX: &str = "0000004f7b226b696e64223a227269672d6163636570742d636f686f72742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001227b22636f686f72744772616e74426173653634223a226533303d222c22636f686f72744772616e745369676e6174757265426173653634223a226533303d222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a312c22726967457865637574696f6e416363657074616e6365426173653634223a226533303d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a226533303d222c22736368656d61223a227269672d6163636570742d636f686f72742d726571756573742f7631227d0a086cfd430284b746eb187ca91b232fca30fa21a947677f7d228ec9e27e859efa";
    const TS_MEASURE_START_FRAME_HEX: &str = "0000004f7b226b696e64223a227269672d6d6561737572652d73746172742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001a27b22636f686f72744772616e74536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a352c227269675761726d7570447261696e656452656365697074536861323536223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464222c22736368656d61223a227269672d6d6561737572652d73746172742d726571756573742f7631222c227761726d7570436f6d706c657465536861323536223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363227d0ad8587aab427325779bc31a24fe67c03d90e48bafa9b3d2c36a63776802506729";

    fn hex_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
            .collect()
    }

    /// §3.3 is one sentence — "`header.kind` is exactly the payload `schema`
    /// with the terminal `/v1` removed" — and both halves of every cohort
    /// pair have to obey it. This is the property that was violated: the
    /// registry was written in schema spelling, so nothing the controller
    /// could encode ever reached the dispatch.
    #[test]
    fn every_cohort_frame_kind_is_its_schema_without_the_version_suffix() {
        use secure_fs::cohort::rig;
        for kind in rig::COHORT_REQUEST_KINDS {
            assert!(
                !kind.ends_with("/v1"),
                "{kind} is spelled as a schema, not a header kind",
            );
            let schema = format!("{kind}/v1");
            assert_eq!(rig::header_kind_for_schema(&schema), Some(*kind));
            let ack = rig::ack_kind_for(kind).expect("every request kind has an ack kind");
            assert!(
                !ack.ends_with("/v1"),
                "{ack} is spelled as a schema, not a header kind",
            );
        }
        assert_eq!(rig::ack_kind_for("rig-accept-cohort-request/v1"), None);
    }

    /// The controller's own bytes reach the transition they name.
    #[test]
    fn a_typescript_encoded_cohort_frame_is_matched_and_not_terminated() {
        let (mut resident, _request) = loop_with_cohort();
        let mut written = Vec::new();
        let mut sink = NullSink;
        let session = hex_bytes(TS_ACCEPT_COHORT_FRAME_HEX);
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("the fixture's records are placeholders, so the transition refuses");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        // The grant and the acceptance in the fixture are both `{}`, so the
        // transition refuses on the record. What matters here is *which*
        // refusal: a matched frame that failed its record, not a frame kind
        // the rig could not name. §2.7 makes that refusal terminal.
        assert_eq!(answered[0].0, "remote-supervisor-refusal");
        assert_ne!(code, "TRUST_CHILD_FRAME_INVALID");
        assert_ne!(answered[0].1["code"], "TRUST_CHILD_FRAME_INVALID");
        assert_eq!(answered[0].1["terminal"], true);
        assert_eq!(answered[0].1["ackRequestSeq"], 1);
    }

    /// The baseline frame the §3.3 registry has always carried, and which had
    /// no dispatch arm at all before B3.5.
    #[test]
    fn a_typescript_encoded_measure_start_frame_reaches_its_transition() {
        let (mut resident, _request) = loop_with_cohort();
        let mut written = Vec::new();
        let mut sink = NullSink;
        let session = hex_bytes(TS_MEASURE_START_FRAME_HEX);
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("§2.7: a refused cohort transition is terminal");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "remote-supervisor-refusal");
        // No cohort was accepted for the execution this frame names, so there
        // is no session to route it to.
        assert_eq!(code, "COHORT_NOT_READY");
        assert_eq!(answered[0].1["code"], "COHORT_NOT_READY");
        assert_eq!(answered[0].1["ackRequestSeq"], 5);
    }

    /// The dispatch is a closed set: a kind outside it is still the peer not
    /// speaking the protocol, and still ends the stream.
    #[test]
    fn an_unregistered_cohort_looking_kind_still_ends_the_session() {
        let (mut resident, _request) = loop_with_cohort();
        let mut written = Vec::new();
        let mut sink = NullSink;
        let session = framed("rig-accept-cohort-ack/v1", b"{}\n");
        assert_eq!(
            resident.serve(&mut session.as_slice(), &mut written, &mut sink),
            Err("TRUST_CHILD_FRAME_INVALID"),
        );
    }

    /// A replayed accept is refused by the session and reported as a refusal
    /// frame, and the cohort it already accepted is not disturbed.
    #[test]
    fn a_replayed_cohort_request_frame_is_refused_on_the_wire() {
        let (mut resident, request) = loop_with_cohort();
        let mut written = Vec::new();
        let mut sink = NullSink;
        let mut session = framed("rig-accept-cohort-request", &request);
        session.extend_from_slice(&framed("rig-accept-cohort-request", &request));
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("§2.7: the replay ends the arm");
        let answered = answers(&written);
        assert_eq!(answered.len(), 2);
        assert_eq!(answered[0].0, "rig-cohort-accepted-ack");
        // A second acceptance for an execution this runtime already holds is a
        // duplicate, and §2.7 makes it terminal.
        assert_eq!(code, "COHORT_PROTOCOL");
        assert_eq!(answered[1].0, "remote-supervisor-refusal");
        assert_eq!(answered[1].1["code"], "COHORT_PROTOCOL");
        // The session exists now, so the refusal names the bound execution.
        assert!(answered[1].1["executionSha256"].is_string());
        assert_eq!(answered[1].1["responseSeq"], 1);
    }
    // --- Phase A and the cohort open, over the real dispatcher (C2) ---------

    /// The identities the bootstrap would have validated, installed on the
    /// loop the way `main` installs them.
    fn test_authority() -> ExecutionAuthority {
        ExecutionAuthority {
            authority_sha256: digest("authority"),
            campaign_lock_sha256: digest("campaign-lock"),
            staged_capability_sha256: digest("staged-capability"),
            source_archive_sha256: digest("source-archive"),
            approved_plan_sha256: digest("approved-plan"),
            approval_record_sha256: digest("approval-record"),
        }
    }

    /// A loop holding a Mac cohort runtime installed as
    /// `install_production_mac_cohort_runtime` installs it: authority digests
    /// and executable digest set, nothing else.
    fn loop_with_mac_runtime() -> (
        ResidentLoop,
        secure_fs::cross_supervisor::Ed25519KeyPair,
        secure_fs::cross_supervisor::Ed25519KeyPair,
    ) {
        let mac = generate_ed25519_keypair();
        let rig_keys = generate_ed25519_keypair();
        let mut runtime = secure_fs::cohort::mac::MacCohortRuntime::new(
            mac.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            &digest("mac-instance"),
            &digest("mac-clock"),
            3_600_000,
        )
        .expect("runtime");
        let authority = test_authority();
        runtime
            .set_campaign_authority(
                &authority.approved_plan_sha256,
                &authority.approval_record_sha256,
            )
            .expect("authority");
        runtime
            .set_supervisor_executable_sha256(&digest("mac-executable"))
            .expect("executable");
        let mut resident = ResidentLoop::new("r1-c2", "candidate-c2");
        resident.execution_authority = Some(authority);
        resident
            .install_mac_cohort_runtime(runtime)
            .expect("one Mac runtime");
        (resident, mac, rig_keys)
    }

    fn chat_1k_plan() -> Vec<u8> {
        canonical_bytes(&json!({
            "schema": "canonical-workload-role-plan-input/v1",
            "scenarioPreimage": {
                "schema": "canonical-scenario-preimage/v1",
                "cellId": "chat-fanout/subscribers-1000",
                "scenarioId": "chat-fanout",
                "parameters": { "direction": "mac-to-linux" },
            },
            "scenarioHash": digest("scenario"),
            "rolePlanPreimage": {
                "schema": "canonical-role-plan-preimage/v1",
                "publisherCount": 10,
                "subscriberWorkerCount": 8,
                "subscriberCount": 1000,
            },
            "rolePlanHash": digest("role-plan"),
        }))
        .expect("plan")
    }

    fn honest_draft() -> Value {
        let now = m::now_epoch_millis().floor() as u64;
        json!({
            "schema": "cross-supervisor-execution-draft/v1",
            "authoritySha256": digest("authority"),
            "campaignLockSha256": digest("campaign-lock"),
            "stagedCapabilitySha256": digest("staged-capability"),
            "sourceArchiveSha256": digest("source-archive"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "candidate": "candidate-c2",
            "campaignId": "r1-c2",
            "runId": "run-c2-1",
            "executionPurpose": "canonical",
            "cellId": "chat-fanout/subscribers-1000",
            "scenarioHash": digest("scenario"),
            "rolePlanHash": digest("role-plan"),
            "workloadRolePlanInputSha256": sha256_hex(&chat_1k_plan()),
            "stagedServerLaunchRecordSha256": digest("server-launch"),
            "armKind": "primary",
            "transport": "ws",
            "repetitionKind": "measured",
            "repetitionIndex": 0,
            "repetitionTotal": 1,
            "grantDeclaration": "fanout-expanded-deliveries",
            "declaredMessageCount": 300_000,
            "declaredMessageBytes": 128,
            "requestedNotAfterMs": now + 3 * 3_600_000,
        })
    }

    fn open_execution_frame(seq: u64, draft: &Value) -> Vec<u8> {
        let draft_bytes = canonical_bytes(draft).expect("draft");
        let payload = canonical_bytes(&json!({
            "schema": "mac-open-execution-request/v1",
            "requestSeq": seq,
            "executionDraftSha256": sha256_hex(&draft_bytes),
            "executionDraftBase64": base64(&draft_bytes),
        }))
        .expect("payload");
        framed("mac-open-execution-request", &payload)
    }

    /// A series shaped as the driver's leg record is, carrying the grant the
    /// loop handed back in the opened ack.
    fn admitted_leg(grant: &Value, count: usize) -> Vec<u8> {
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let first = issued + 2.0;
        let mut samples = Vec::new();
        let mut trips = Vec::new();
        let mut sent = first;
        let mut last = first;
        for sequence in 1..=count {
            let received = sent + 0.5;
            samples.push(json!(0.5));
            trips.push(json!({
                "sequence": sequence,
                "sentAtMs": sent,
                "receivedAtMs": received,
                "latencyMs": 0.5,
            }));
            last = received;
            sent = received + 0.2;
        }
        let record = json!({
            "grant": grant,
            "samples": samples,
            "roundTrips": trips,
            "ledger": { "attempted": count, "delivered": count },
            "provenance": { "sampleCount": count, "firstSampleAtMs": first, "lastSampleAtMs": last },
        });
        let mut bytes = serde_json::to_vec(&record).expect("series");
        bytes.push(b'\n');
        bytes
    }

    fn rig_signed(
        rig_keys: &secure_fs::cross_supervisor::Ed25519KeyPair,
        schema: &str,
        record: &Value,
    ) -> (Vec<u8>, Vec<u8>) {
        let bytes = canonical_bytes(record).expect("record");
        let raw = sign_bytes(&rig_keys.private_pkcs8_der, &bytes).expect("sign");
        let carrier = canonical_bytes(&json!({
            "schema": "rig-receipt-signature/v1",
            "algorithm": "Ed25519",
            "signedSchema": schema,
            "signedBytesSha256": sha256_hex(&bytes),
            "signingPublicKeySha256": public_key_sha256(&rig_keys.public_raw32),
            "signatureBase64": base64(&raw),
        }))
        .expect("carrier");
        (bytes, carrier)
    }

    fn unbase64(text: &str) -> Vec<u8> {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(text.as_bytes())
            .expect("base64")
    }

    /// Phase A over the real frames: `mac-open-execution-request/v1` opens the
    /// execution through the loop's own grant, the child's `artifact-payload`
    /// is admitted and its facts retained, and the observation frame for an
    /// execution with no cohort mints `mac-measurement-admission/v1` with the
    /// admitted series' digest and null cohort digests.
    #[test]
    fn the_dispatcher_opens_an_execution_admits_its_series_and_mints_the_admission() {
        let (mut resident, mac, rig_keys) = loop_with_mac_runtime();
        let mut sink = NullSink;

        // Frame 1: the open.
        let mut written = Vec::new();
        let session = open_execution_frame(0, &honest_draft());
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("opened");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "mac-execution-opened-ack");
        let ack = &answered[0].1;
        assert_eq!(ack["schema"], "mac-execution-opened-ack/v1");
        assert_eq!(ack["ackRequestSeq"], 0);
        let execution_sha256 = ack["executionSha256"]
            .as_str()
            .expect("execution")
            .to_owned();
        let grant_bytes = unbase64(ack["measurementGrantBase64"].as_str().expect("grant"));
        let grant: Value = serde_json::from_slice(&grant_bytes).expect("grant json");
        assert_eq!(grant["schema"], "measurement-grant/v1");
        assert_eq!(grant["runId"], "run-c2-1");
        assert_eq!(grant["executionIndex"], 1);
        let receipt_bytes = unbase64(
            ack["macExecutionGrantReceiptBase64"]
                .as_str()
                .expect("receipt"),
        );
        let receipt: Value = serde_json::from_slice(&receipt_bytes).expect("receipt json");
        assert_eq!(
            receipt["macSupervisorExecutableSha256"],
            digest("mac-executable")
        );
        assert_eq!(receipt["approvedPlanSha256"], digest("approved-plan"));
        assert_eq!(receipt["execution"]["executionIndex"], 1);
        let open = resident.open.as_ref().expect("the execution is open");
        assert_eq!(open.key.execution_index, 1);
        assert_eq!(
            open.grant, grant_bytes,
            "the grant on the ack is the loop's own"
        );
        assert_eq!(
            open.cross_execution_sha256.as_deref(),
            Some(execution_sha256.as_str())
        );
        assert_eq!(resident.grants.outstanding_count(), 1);

        // Frame 2: the child's series, admitted under that grant and retained.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let payload = admitted_leg(&grant, 6);
        let mut written = Vec::new();
        let session = framed("artifact-payload", &payload);
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("admitted");
        let answered = answers(&written);
        assert_eq!(answered[0].0, "admission-receipt");
        assert_eq!(answered[0].1["executionIndex"], 1);
        let retained = resident
            .mac_cohort
            .as_ref()
            .expect("runtime")
            .execution(&execution_sha256)
            .expect("retained");
        let admitted = retained
            .admitted
            .as_ref()
            .expect("C2: the admitted facts are transferred");
        assert_eq!(admitted.payload_sha256, m::sha256_hex_of(&payload));
        assert_eq!(admitted.receipt.series.sample_count, 6);
        assert!(resident.open.is_none());
        assert_eq!(
            resident
                .accepted
                .as_ref()
                .expect("accepted")
                .cross_execution_sha256
                .as_deref(),
            Some(execution_sha256.as_str()),
            "the accepted facts name the execution they were transferred to",
        );

        // Frame 3: the observation for an execution with no cohort.  The
        // three rig records are the production rig's exact key sets
        // (`cohort::rig_record_keys`): the Mac exact-keys every one it admits.
        let rig_key_sha256 = public_key_sha256(&rig_keys.public_raw32);
        let now_ms = m::now_epoch_millis() as u64;
        let acceptance = rig_signed(
            &rig_keys,
            "rig-execution-acceptance/v1",
            &json!({
                "schema": "rig-execution-acceptance/v1",
                "executionSha256": execution_sha256,
                "measurementGrantSha256": sha256_hex(&grant_bytes),
                "macExecutionGrantReceiptSha256": sha256_hex(&receipt_bytes),
                "macReceiptSignatureSha256": digest("mac-receipt-signature"),
                "approvedPlanSha256": digest("approved-plan"),
                "approvalRecordSha256": digest("approval-record"),
                "rigExecutionIndex": 1,
                "rigSupervisorInstanceNonce": digest("rig-instance"),
                "rigSupervisorExecutableSha256": digest("rig-executable"),
                "replayLedgerLeafSha256": digest("replay-leaf"),
                "signingPublicKeySha256": rig_key_sha256,
                "receiptSequence": 1,
                "acceptedAtMs": now_ms,
                "issuedAtMs": now_ms,
                "notAfterMs": now_ms + 3_600_000,
            }),
        );
        let measure_start = rig_signed(
            &rig_keys,
            "rig-measure-start-ack/v1",
            &json!({
                "schema": "rig-measure-start-ack/v1",
                "executionSha256": execution_sha256,
                "measurementGrantSha256": sha256_hex(&grant_bytes),
                "macExecutionGrantReceiptSha256": sha256_hex(&receipt_bytes),
                "rigExecutionAcceptanceSha256": sha256_hex(&acceptance.0),
                "approvedPlanSha256": digest("approved-plan"),
                "approvalRecordSha256": digest("approval-record"),
                "childResponseSequence": 3,
                "baselineBusyMs": 0,
                "baselineAtLinuxNs": "7000000000000",
                "linuxClockId": "clock-monotonic-boot-b",
                "warmupCompletionAuthoritySha256": digest("warmup-completion-authority"),
                "rigWarmupDrainedReceiptSha256": digest("rig-warmup-drained-receipt"),
                "signingPublicKeySha256": rig_key_sha256,
                "rigSupervisorInstanceNonce": digest("rig-instance"),
                "receiptSequence": 2,
                "issuedAtMs": now_ms,
                "notAfterMs": now_ms + 3_600_000,
            }),
        );
        let snapshot_frame = b"{\"schema\":\"server-snapshot/v1\"}\n";
        let snapshot = rig_signed(
            &rig_keys,
            "rig-server-snapshot-receipt/v1",
            &json!({
                "schema": "rig-server-snapshot-receipt/v1",
                "executionSha256": execution_sha256,
                "measurementGrantSha256": sha256_hex(&grant_bytes),
                "macExecutionGrantReceiptSha256": sha256_hex(&receipt_bytes),
                "rigExecutionAcceptanceSha256": sha256_hex(&acceptance.0),
                "cohortGrantSha256": digest("cohort-grant"),
                "cohortStartBarrierSha256": digest("cohort-start-barrier"),
                "roleTokenCommitmentRootSha256": digest("role-token-commitment-root"),
                "approvedPlanSha256": digest("approved-plan"),
                "approvalRecordSha256": digest("approval-record"),
                "rigExecutionIndex": 1,
                "rigSupervisorInstanceNonce": digest("rig-instance"),
                "snapshotFrameSha256": sha256_hex(snapshot_frame),
                "snapshotFrameSize": snapshot_frame.len(),
                "childPid": 4242,
                "childPgid": 4242,
                "childInstanceNonce": digest("server-instance"),
                "serverEntrypointSha256": digest("server-entrypoint"),
                "bunSha256": digest("bun"),
                "addonSha256": digest("addon"),
                "childResponseSequence": 5,
                "captureRequestSequence": 4,
                "signingPublicKeySha256": rig_key_sha256,
                "receiptSequence": 3,
                "frameReceivedAtRigNs": "7000000000000",
                "issuedAtMs": now_ms,
                "notAfterMs": now_ms + 3_600_000,
            }),
        );
        let observation = canonical_bytes(&json!({
            "schema": "mac-present-rig-observation-request/v1",
            "requestSeq": 1,
            "executionSha256": execution_sha256,
            "rigExecutionAcceptanceBase64": base64(&acceptance.0),
            "rigExecutionAcceptanceSignatureBase64": base64(&acceptance.1),
            "rigMeasureStartAckBase64": base64(&measure_start.0),
            "rigMeasureStartAckSignatureBase64": base64(&measure_start.1),
            "rigBarrierAcceptanceBase64": Value::Null,
            "rigBarrierAcceptanceSignatureBase64": Value::Null,
            "serverWarmupDrainedBase64": Value::Null,
            "serverStartBarrierAcceptedBase64": Value::Null,
            "snapshotFrameBase64": base64(snapshot_frame),
            "rigServerSnapshotReceiptBase64": base64(&snapshot.0),
            "rigServerSnapshotReceiptSignatureBase64": base64(&snapshot.1),
            "linuxRelayObservationBase64": Value::Null,
            "rigRelayObservationReceiptBase64": Value::Null,
            "rigRelayObservationReceiptSignatureBase64": Value::Null,
            "orderedPartialManifestBase64": Value::Null,
            "observedProcessProofBase64": Value::Null,
            "cohortRateSeriesBase64": Value::Null,
            "cohortLedgerBase64": Value::Null,
            "cohortCapacityBase64": Value::Null,
        }))
        .expect("observation");
        let mut written = Vec::new();
        let session = framed("mac-present-rig-observation-request", &observation);
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("admission");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "mac-measurement-admission-issued-ack");
        let ack = &answered[0].1;
        assert_eq!(ack["ackRequestSeq"], 1);
        assert!(ack["cohortAdmissionReceiptBase64"].is_null());
        let admission_bytes = unbase64(
            ack["macMeasurementAdmissionReceiptBase64"]
                .as_str()
                .expect("admission"),
        );
        let admission: Value = serde_json::from_slice(&admission_bytes).expect("admission json");
        assert_eq!(admission["schema"], "mac-measurement-admission/v1");
        assert_eq!(
            admission["admittedClientSeriesSha256"],
            m::sha256_hex_of(&payload)
        );
        assert_eq!(
            admission["measurementGrantSha256"],
            sha256_hex(&grant_bytes)
        );
        assert_eq!(admission["sampleCount"], 6);
        assert!(admission["cohortGrantSha256"].is_null());
        let carrier: Value = serde_json::from_slice(&unbase64(
            ack["macMeasurementAdmissionSignatureBase64"]
                .as_str()
                .expect("sig"),
        ))
        .expect("carrier");
        assert_eq!(
            carrier["signingPublicKeySha256"],
            public_key_sha256(&mac.public_raw32)
        );
        let raw: [u8; 64] = unbase64(carrier["signatureBase64"].as_str().expect("raw"))
            .as_slice()
            .try_into()
            .expect("64");
        secure_fs::cross_supervisor::verify_bytes(&mac.public_raw32, &admission_bytes, &raw)
            .expect("the Mac signed it");
        assert_eq!(
            resident
                .mac_cohort
                .as_ref()
                .expect("runtime")
                .execution_count(),
            0,
            "terminal for an ordinary execution"
        );
    }

    /// The cohort open over the real frames: after Phase A, the
    /// `mac-open-cohort-request/v1` with C1's manifest and topology reaches the
    /// runtime and the ack carries a `cohort-grant/v1` the rig's parser accepts
    /// under the Mac's key — with the execution the loop opened nested inside.
    #[test]
    fn the_dispatcher_routes_the_cohort_open_and_returns_a_signed_grant() {
        let (mut resident, mac, _rig_keys) = loop_with_mac_runtime();
        let mut sink = NullSink;
        let mut written = Vec::new();
        let session = open_execution_frame(0, &honest_draft());
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("opened");
        let ack = answers(&written).remove(0).1;
        let execution_sha256 = ack["executionSha256"]
            .as_str()
            .expect("execution")
            .to_owned();
        let grant: Value = serde_json::from_slice(&unbase64(
            ack["measurementGrantBase64"].as_str().expect("grant"),
        ))
        .expect("grant");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut written = Vec::new();
        let session = framed("artifact-payload", &admitted_leg(&grant, 6));
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("admitted");

        // C1's three presented records for chat-1k, from the leaves.
        let cohort_id = format!("cohort-{}", &execution_sha256[..16]);
        let mut leaves = Vec::new();
        for index in 0..10u64 {
            let id = format!("publisher-{index:06}");
            leaves.push(json!({
                "schema": "token-commitment-leaf/v1",
                "childId": format!("publisher-child-{index}"),
                "cohortId": cohort_id,
                "role": "publisher",
                "roleId": id,
                "tokenSha256": digest(&format!("{cohort_id}:{id}")),
                "workerIndex": Value::Null,
            }));
        }
        for index in 0..1000u64 {
            let id = format!("subscriber-{index:06}");
            leaves.push(json!({
                "schema": "token-commitment-leaf/v1",
                "childId": format!("subscriber-worker-{}", index % 8),
                "cohortId": cohort_id,
                "role": "subscriber",
                "roleId": id,
                "tokenSha256": digest(&format!("{cohort_id}:{id}")),
                "workerIndex": index % 8,
            }));
        }
        let mut parsed: Vec<secure_fs::cohort::TokenCommitmentLeafV1> = leaves
            .iter()
            .map(|leaf| secure_fs::cohort::TokenCommitmentLeafV1::parse(leaf).expect("leaf"))
            .collect();
        let nodes = secure_fs::cohort::ordered_leaf_nodes(&mut parsed).expect("nodes");
        let root = secure_fs::cohort::merkle_root(&nodes).expect("root");
        let root_hex: String = root.iter().map(|byte| format!("{byte:02x}")).collect();
        let manifest = canonical_bytes(&json!({
            "schema": "token-commitment-leaf-manifest/v1",
            "executionSha256": execution_sha256,
            "cohortId": cohort_id,
            "leafCount": leaves.len(),
            "roleTokenCommitmentRootSha256": root_hex,
            "leaves": leaves,
        }))
        .expect("manifest");
        let publishers: Vec<Value> = leaves
            .iter()
            .take(10)
            .enumerate()
            .map(|(index, leaf)| {
                json!({
                    "schema": "publisher-role-grant/v1",
                    "childId": leaf["childId"],
                    "publisherId": leaf["roleId"],
                    "tokenCommitmentIndex": index,
                    "tokenSha256": leaf["tokenSha256"],
                })
            })
            .collect();
        let shards: Vec<Value> = (0..8u64)
            .map(|worker| {
                let members: Vec<(usize, &Value)> = leaves
                    .iter()
                    .enumerate()
                    .filter(|(_, leaf)| leaf["workerIndex"] == json!(worker))
                    .collect();
                let ids: Vec<Value> = members.iter().map(|(_, leaf)| leaf["roleId"].clone()).collect();
                json!({
                    "schema": "subscriber-shard/v1",
                    "childId": members[0].1["childId"],
                    "workerIndex": worker,
                    "modulus": 8,
                    "residue": worker,
                    "firstSubscriberIndex": 0,
                    "lastSubscriberIndexExclusive": 1000,
                    "subscriberCount": members.len(),
                    "orderedSubscriberIdsSha256": sha256_hex(&canonical_bytes(&json!(ids)).expect("ids")),
                    "firstTokenCommitmentIndex": members[0].0,
                    "lastTokenCommitmentIndexExclusive": shard_commitment_window_end(
                        members[0].0 as u64,
                        members.len() as u64,
                    )
                    .expect("window"),
                })
            })
            .collect();
        let plan = chat_1k_plan();
        let open = canonical_bytes(&json!({
            "schema": "mac-open-cohort-request/v1",
            "requestSeq": 1,
            "executionSha256": execution_sha256,
            "scenarioHash": digest("scenario"),
            "rolePlanHash": digest("role-plan"),
            "workloadRolePlanInputBase64": base64(&plan),
            "workloadRolePlanInputSha256": sha256_hex(&plan),
            "workloadRolePlanInputSize": plan.len(),
            "tokenCommitmentLeafManifestBase64": base64(&manifest),
            "tokenCommitmentLeafManifestSha256": sha256_hex(&manifest),
            "publishersBase64": base64(&canonical_bytes(&json!(publishers)).expect("publishers")),
            "subscriberShardsBase64": base64(&canonical_bytes(&json!(shards)).expect("shards")),
        }))
        .expect("open");
        let mut written = Vec::new();
        let session = framed("mac-open-cohort-request", &open);
        resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect("cohort opened");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "mac-cohort-opened-ack");
        let ack = &answered[0].1;
        assert_eq!(ack["ackRequestSeq"], 1);
        let grant_bytes = unbase64(ack["cohortGrantBase64"].as_str().expect("grant"));
        let carrier: Value = serde_json::from_slice(&unbase64(
            ack["cohortGrantSignatureBase64"].as_str().expect("sig"),
        ))
        .expect("carrier");
        let raw: [u8; 64] = unbase64(carrier["signatureBase64"].as_str().expect("raw"))
            .as_slice()
            .try_into()
            .expect("64");
        let grant =
            secure_fs::cohort::CohortGrantV1::parse_signed(&grant_bytes, &raw, &mac.public_raw32)
                .expect("the rig's parser accepts the grant the dispatcher returned");
        assert_eq!(grant.execution_sha256, execution_sha256);
        assert_eq!(grant.cohort_id, cohort_id);
        assert_eq!(grant.role_token_commitment_root_sha256, root_hex);
        assert_eq!(grant.publishers.len(), 10);
        assert_eq!(grant.subscriber_shards.len(), 8);
        let grant_value: Value = serde_json::from_slice(&grant_bytes).expect("grant json");
        assert_eq!(grant_value["execution"]["runId"], "run-c2-1");
        assert_eq!(grant_value["execution"]["executionIndex"], 1);
        assert_eq!(
            resident
                .mac_cohort
                .as_ref()
                .expect("runtime")
                .session_count(),
            1
        );
    }

    /// A draft whose identities are not the bootstrap's is refused on the
    /// wire as a terminal `remote-supervisor-refusal/v1`, no grant stays
    /// issued, and nothing is retained.
    #[test]
    fn an_open_execution_whose_draft_names_another_authority_is_refused_terminally() {
        let (mut resident, _mac, _rig_keys) = loop_with_mac_runtime();
        let mut sink = NullSink;
        let mut draft = honest_draft();
        draft["authoritySha256"] = json!(digest("another authority"));
        let mut written = Vec::new();
        let session = open_execution_frame(0, &draft);
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("refused");
        assert_eq!(code, "CROSS_SUPERVISOR_MISMATCH");
        let answered = answers(&written);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].0, "remote-supervisor-refusal");
        assert_eq!(answered[0].1["code"], "CROSS_SUPERVISOR_MISMATCH");
        assert_eq!(answered[0].1["terminal"], true);
        assert_eq!(answered[0].1["ackRequestSeq"], 0);
        assert!(resident.open.is_none());
        assert_eq!(resident.grants.outstanding_count(), 0);
        assert_eq!(
            resident
                .mac_cohort
                .as_ref()
                .expect("runtime")
                .execution_count(),
            0
        );

        // And a draft the authority accepts but the Mac runtime will not sign
        // for abandons the grant it was issued: the declaration is refused by
        // the runtime, not the loop.
        let (mut resident, _mac, _rig_keys) = loop_with_mac_runtime();
        let mut draft = honest_draft();
        draft["declaredMessageCount"] = json!(300);
        let mut written = Vec::new();
        let session = open_execution_frame(0, &draft);
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("refused");
        assert_eq!(code, "CROSS_SUPERVISOR_MISMATCH");
        assert!(resident.open.is_none());
        assert_eq!(
            resident.grants.outstanding_count(),
            0,
            "the refused open abandoned its grant"
        );
    }

    /// A loop with no Mac runtime answers the Phase-A open with a closed code,
    /// terminally.
    #[test]
    fn an_open_execution_without_a_mac_runtime_is_refused() {
        let mut resident = ResidentLoop::new("r1-c2", "candidate-c2");
        resident.execution_authority = Some(test_authority());
        let mut sink = NullSink;
        let mut written = Vec::new();
        let session = open_execution_frame(0, &honest_draft());
        let code = resident
            .serve(&mut session.as_slice(), &mut written, &mut sink)
            .expect_err("refused");
        assert_eq!(code, "COHORT_NOT_READY");
        assert_eq!(answers(&written)[0].0, "remote-supervisor-refusal");
    }
}

/// The staged TLS identity reaches the server child only through the launch
/// record's digests and the rig's pinned staging root (amendment C4: "Staging
/// binds real launch argv, local/remote binaries/addon/Bun, TLS and immutable
/// roots").  These tests drive `child_environment` against a real directory:
/// the honest record yields the three `WS_WT_TLS_*` entries with the exact
/// staged bytes; a leaf whose digest is not the record's, a record that
/// restates a TLS or cohort name, and a record without the digests are each
/// refused before any fork, by their own code.
#[cfg(all(test, unix))]
mod staged_server_spawner_tests {
    use super::*;
    use secure_fs::cohort::CohortRefusal;
    use std::sync::atomic::{AtomicU64, Ordering};

    const CERT: &str = "-----BEGIN CERTIFICATE-----\nc3RhZ2VkLWNlcnQ=\n-----END CERTIFICATE-----\n";
    const KEY: &str = "-----BEGIN PRIVATE KEY-----\nc3RhZ2VkLWtleQ==\n-----END PRIVATE KEY-----\n";

    /// The test's own directory and leaves, made through the same libc calls
    /// the sealed engine wraps (this binary carries no path-level `std::fs`).
    struct StagingRoot {
        dir: String,
        fd: i32,
    }

    fn c(path: &str) -> std::ffi::CString {
        std::ffi::CString::new(path).expect("path")
    }

    impl StagingRoot {
        fn new(cert: &str, key: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let dir = format!(
                "{}/wtb-staged-tls-{}-{}",
                std::env::temp_dir().display(),
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            );
            // SAFETY: creates a directory this test owns, then opens it.
            let fd = unsafe {
                assert_eq!(libc::mkdir(c(&dir).as_ptr(), 0o700), 0, "mkdir");
                libc::open(c(&dir).as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY)
            };
            assert!(fd >= 0, "open staging root");
            let root = Self { dir, fd };
            root.write_leaf(STAGED_SERVER_TLS_CERTIFICATE_LEAF, cert.as_bytes());
            root.write_leaf(STAGED_SERVER_TLS_PRIVATE_KEY_LEAF, key.as_bytes());
            root
        }

        fn leaf(&self, name: &str) -> String {
            format!("{}/{name}", self.dir)
        }

        fn write_leaf(&self, name: &str, bytes: &[u8]) {
            let path = c(&self.leaf(name));
            // SAFETY: writes a whole small buffer into a file this test owns.
            unsafe {
                let fd = libc::open(
                    path.as_ptr(),
                    libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
                    0o600,
                );
                assert!(fd >= 0, "create leaf");
                let written = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
                assert_eq!(written, bytes.len() as isize, "write leaf");
                libc::close(fd);
            }
        }

        fn unlink_leaf(&self, name: &str) {
            // SAFETY: unlinks a leaf this test wrote.
            unsafe { assert_eq!(libc::unlink(c(&self.leaf(name)).as_ptr()), 0) };
        }
    }

    impl Drop for StagingRoot {
        fn drop(&mut self) {
            // SAFETY: closes and removes what this test created; a missing
            // leaf is fine, the directory must be empty by then.
            unsafe {
                libc::close(self.fd);
                for leaf in [
                    STAGED_SERVER_TLS_CERTIFICATE_LEAF,
                    STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
                ] {
                    libc::unlink(c(&self.leaf(leaf)).as_ptr());
                }
                libc::rmdir(c(&self.dir).as_ptr());
            }
        }
    }

    fn spawner(staging_root_fd: i32) -> StagedServerSpawner {
        StagedServerSpawner {
            bun_path: std::ffi::CString::new("/usr/bin/false").expect("bun path"),
            role_root_fd: -1,
            staging_root_fd,
            staged_mac_public_base64: "AAAA".to_owned(),
            linux_clock_id: "c".repeat(64),
            child: std::rc::Rc::new(std::cell::RefCell::new(None)),
        }
    }

    fn launch_record(cert: &str, key: &str, environment: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema": "staged-server-launch-record/v1",
            "stageReceiptSha256": "0".repeat(64),
            "serverEntrypointSha256": "2".repeat(64),
            "bunSha256": "3".repeat(64),
            "addonSha256": "4".repeat(64),
            "bindAddress": "10.99.0.2",
            "bindPort": 4433,
            "advertisedHost": "10.99.0.2",
            "tlsServerName": "wt-compare.local",
            "tlsCertificateSha256": secure_fs::sha256_hex(cert.as_bytes()),
            "tlsPrivateKeySha256": secure_fs::sha256_hex(key.as_bytes()),
            "transport": "wt",
            "argv": ["server.ts", "--transport=wt", "--mode=fanout-cohort"],
            "allowedEnvironment": environment,
        }))
        .expect("record")
    }

    fn entries(environment: &[std::ffi::CString]) -> Vec<String> {
        environment
            .iter()
            .map(|entry| entry.to_str().expect("utf8").to_owned())
            .collect()
    }

    #[test]
    fn the_honest_record_hands_the_child_the_staged_identity_and_nothing_else() {
        let root = StagingRoot::new(CERT, KEY);
        let record = launch_record(
            CERT,
            KEY,
            serde_json::json!([{"name": "PATH", "value": "/usr/bin:/bin"}]),
        );
        let environment = spawner(root.fd)
            .child_environment(&record, 600_000)
            .expect("honest");
        assert_eq!(
            entries(&environment),
            vec![
                "WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64=AAAA".to_owned(),
                format!("WS_WT_COHORT_LINUX_CLOCK_ID={}", "c".repeat(64)),
                "WS_WT_COHORT_RECEIPT_VALIDITY_MS=600000".to_owned(),
                format!("WS_WT_TLS_CERT_CONTENT={CERT}"),
                format!("WS_WT_TLS_KEY_CONTENT={KEY}"),
                "WS_WT_TLS_SERVER_NAME=wt-compare.local".to_owned(),
                "PATH=/usr/bin:/bin".to_owned(),
            ]
        );
    }

    #[test]
    fn a_staged_leaf_whose_digest_is_not_the_records_is_refused_by_field() {
        let other_key = "-----BEGIN PRIVATE KEY-----\nb3RoZXI=\n-----END PRIVATE KEY-----\n";
        let root = StagingRoot::new(CERT, other_key);
        let record = launch_record(CERT, KEY, serde_json::json!([]));
        assert_eq!(
            spawner(root.fd).child_environment(&record, 600_000).err(),
            Some(CohortRefusal::BindingMismatch("tlsPrivateKeySha256"))
        );
        let other_cert = "-----BEGIN CERTIFICATE-----\nb3RoZXI=\n-----END CERTIFICATE-----\n";
        let root2 = StagingRoot::new(other_cert, KEY);
        assert_eq!(
            spawner(root2.fd).child_environment(&record, 600_000).err(),
            Some(CohortRefusal::BindingMismatch("tlsCertificateSha256"))
        );
    }

    #[test]
    fn a_record_that_restates_a_supervisor_owned_name_is_refused() {
        let root = StagingRoot::new(CERT, KEY);
        for name in [
            "WS_WT_TLS_CERT_CONTENT",
            "WS_WT_TLS_SERVER_NAME",
            "WS_WT_COHORT_LINUX_CLOCK_ID",
        ] {
            let record =
                launch_record(CERT, KEY, serde_json::json!([{"name": name, "value": "x"}]));
            assert_eq!(
                spawner(root.fd).child_environment(&record, 600_000).err(),
                Some(CohortRefusal::BindingMismatch("allowedEnvironment")),
                "{name}"
            );
        }
    }

    #[test]
    fn a_record_without_the_tls_digests_or_a_missing_leaf_is_refused_before_any_fork() {
        let root = StagingRoot::new(CERT, KEY);
        let mut value: serde_json::Value =
            serde_json::from_slice(&launch_record(CERT, KEY, serde_json::json!([]))).expect("json");
        value
            .as_object_mut()
            .expect("map")
            .remove("tlsPrivateKeySha256");
        let record = serde_json::to_vec(&value).expect("record");
        assert_eq!(
            spawner(root.fd).child_environment(&record, 600_000).err(),
            Some(CohortRefusal::MissingField("tlsPrivateKeySha256"))
        );
        root.unlink_leaf(STAGED_SERVER_TLS_PRIVATE_KEY_LEAF);
        let record = launch_record(CERT, KEY, serde_json::json!([]));
        assert_eq!(
            spawner(root.fd).child_environment(&record, 600_000).err(),
            Some(CohortRefusal::NotReady("staged tls leaf"))
        );
    }
}
