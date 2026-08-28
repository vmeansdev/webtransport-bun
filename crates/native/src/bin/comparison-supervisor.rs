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
fn resolve_descriptors(
    args: &[String],
) -> Result<secure_fs::supervisor::ResidentDescriptors, &'static str> {
    let descriptors = secure_fs::supervisor::ResidentDescriptors {
        authority_fd: descriptor_option(args, "--authority-fd")?,
        authority_digest_fd: descriptor_option(args, "--authority-digest-fd")?,
        campaign_root_fd: descriptor_option(args, "--campaign-root-fd")?,
        staging_root_fd: descriptor_option(args, "--staging-root-fd")?,
    };
    let numbers = [
        descriptors.authority_fd,
        descriptors.authority_digest_fd,
        descriptors.campaign_root_fd,
        descriptors.staging_root_fd,
    ];
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
    frames: secure_fs::supervisor::frame::SessionFrameBudget,
    admitted: u64,
    refused: u64,
    /// The sha256 of the supervisor's local Bun toolchain observation,
    /// computed at startup. The controller assembles the two-host join
    /// by reading this value from each supervisor; the per-host
    /// observation itself is what `observe_bun_toolchain` reads off the
    /// Bun executable (version, revision, digest, platform token).
    toolchain_sha256: Option<String>,
}

/// An execution the supervisor has opened and not yet closed.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct OpenExecution {
    key: secure_fs::measurement::ExecutionKey,
    grant_sha256: String,
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
            frames: secure_fs::supervisor::frame::SessionFrameBudget::new(),
            admitted: 0,
            refused: 0,
            toolchain_sha256: None,
        }
    }

    /// Observe the supervisor's local Bun toolchain and store the sha256
    /// of its canonical bytes. The Bun executable path comes from the
    /// staged archive the trust bootstrap already verified; reading it
    /// again here is the supervisor's own measurement, not an echo of
    /// anything the child said.
    fn observe_local_toolchain(&mut self, bun_path: &std::path::Path) -> Result<(), String> {
        use secure_fs::supervisor::records::{observe_bun_toolchain, ObservedToolchainHostFacts};
        let facts: ObservedToolchainHostFacts = observe_bun_toolchain(bun_path)?;
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
                _ => return self.terminate(writer, "TRUST_CHILD_FRAME_INVALID"),
            }
        }
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

    /// End the session on a protocol violation, having said why.
    fn terminate<W: std::io::Write>(
        &mut self,
        writer: &mut W,
        code: &'static str,
    ) -> Result<LoopSummary, &'static str> {
        if let Some(open) = self.open.take() {
            self.grants.abandon(&open.key);
        }
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
                let mut sink = CampaignRootSink {
                    syscalls: secure_fs::LibcSyscalls::new(),
                    campaign_root_fd: summary.campaign_root_fd(),
                };
                let mut reader = ControlChannel {
                    syscalls: secure_fs::LibcSyscalls::new(),
                    fd: control_in_fd,
                };
                let mut writer = ControlChannel {
                    syscalls: secure_fs::LibcSyscalls::new(),
                    fd: control_out_fd,
                };
                let mut resident = ResidentLoop::new(&campaign_id, &candidate);
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
                match std::env::var_os("COMPARISON_SUPERVISOR_BUN_PATH") {
                    Some(bun_path) => {
                        if let Err(err) =
                            resident.observe_local_toolchain(std::path::Path::new(&bun_path))
                        {
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
