/**
 * Task 6 + Phase 3.6.1: Remote supervisor.
 *
 * The supervisor runs on Linux (the rig) and a sibling runs on macOS
 * (the controller host). Each supervisor:
 * - Acquires a lock file via flock (exclusive, non-blocking)
 * - Owns the server PGID so cleanup targets only that group
 * - Watches a controller heartbeat lease
 * - On lease expiry: kills the owned PGID, restores fq, writes cleanup
 *   artifact, releases the lock
 *
 * The supervisors are separate processes, not part of any server process
 * group. The Mac controller performs bounded shutdown and an independent
 * recovery command before the next run.
 *
 * This module owns:
 *
 *   1. The supervisor state machine and lease management types
 *      (`SupervisorConfig`, `SupervisorState`, `validateSupervisorLock`,
 *      `isLeaseValid`, `computeRenewal`).
 *
 *   2. The spawn contract: argv construction for the Mac-resident
 *      supervisor (`buildMacSupervisorArgv`) and the rig-side wrapper
 *      script (`buildRigSupervisorWrapperScript`) that runs over SSH
 *      and exec's the rig-resident supervisor. Both honor the four
 *      `--*-fd` bootstrap FDs the Rust binary expects at
 *      `crates/native/src/bin/comparison-supervisor.rs:88-92`, and the
 *      `--control-in-fd` / `--control-out-fd` pair that give the
 *      controller↔supervisor frame channel (per the supervisor's
 *      `control_descriptors` at `comparison-supervisor.rs:567-573`).
 *
 *   3. The process-management surface: `SupervisorHandle`, `SupervisorFd`,
 *      `spawnMacSupervisor` (local fork+exec), `spawnRigSupervisor`
 *      (SSH + wrapper script), and the bounded `stopSupervisor` shutdown.
 *
 * The Mac-side `spawnMacSupervisor` opens digest/root paths in the parent
 * and feeds authority bytes over an anonymous pipe (the Rust bootstrap
 * refuses a regular-file authority FD). Bun.spawn only inherits FDs that
 * appear in the `stdio` array, so the helper maps those descriptors onto
 * fixed child slots 3..N and passes those slot numbers in argv. Control
 * pipes are created with `pipe(2)` and the controller-kept ends get
 * `FD_CLOEXEC` so a failed/exec'd child cannot inherit the parent's
 * write/read ends.
 * The rig-side `spawnRigSupervisor` opens an SSH session whose
 * stdin/stdout ARE the supervisor's `--control-in-fd 0` /
 * `--control-out-fd 1`, and the wrapper script opens the four
 * trust-bootstrap files on the rig at their known paths and exec's
 * the supervisor with the FD numbers in argv. No SCM_RIGHTS.
 *
 * host-sidecar.ts is *not* where this lives. It is a pure FD/port
 * validator, classified `controllerOnlyTs`, and adding `Bun.spawn` to it
 * would shift a parser into a process-management role no caller outside
 * `compare-controller.ts` would expect. The supervisors' spawn lives
 * here because `remote-supervisor.ts` already owns lease/lock/PGID
 * lifecycle and is where anyone reading the supervisor's story looks.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import {
	type ChildProcessWithoutNullStreams,
	spawn as nodeSpawn,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	COHORT_MAX_CONNECTIONS_IN_FLIGHT,
	COHORT_NOT_READY_FAILURE_CODE,
	COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
	COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES,
	COHORT_PROTOCOL_FAILURE_CODE,
	COHORT_ROLE_REPLACEMENT_COUNT,
	COHORT_WORKER_COUNT,
	type CohortAdmissionReceiptV1,
	type CohortCapacityV1,
	type CohortGrantV1,
	type CohortLedgerV1,
	type CohortObservationEvidenceV1,
	type CohortRateSeriesV1,
	type CohortStartBarrierV1,
	type ConnectPermitGrantV1,
	type ConnectPermitRequestV1,
	enumerateGlobalOrdinals,
	LINUX_RELAY_OBSERVATION_MAX_BYTES,
	type LinuxRelayObservationV1,
	type ObservedChildProcessV1,
	type ObservedProcessProofV1,
	type OrderedPartialManifestEntryV1,
	type OrderedPartialManifestV1,
	observedChildrenDigestSha256,
	orderedPartialDigestSetSha256,
	PUBLISHER_PARTIAL_MAX_BYTES,
	type PublisherPartialV1,
	parseCohortAdmissionReceipt,
	parseCohortCapacity,
	parseCohortGrant,
	parseCohortObservationEvidence,
	parseCohortStartBarrier,
	parseCohortWarmupEpoch,
	parseConnectPermitComplete,
	parseConnectPermitRequest,
	parseLinuxRelayObservation,
	parseObservedProcessProof,
	parseOrderedPartialManifest,
	parsePublisherPartial,
	parseRigBarrierAcceptance,
	parseRigCohortAcceptance,
	parseRigRelayObservationReceipt,
	parseRigWarmupDrainedReceipt,
	parseRolePartial,
	parseRoleWarmupComplete,
	parseRoleWarmupCompletionManifest,
	parseTokenBundle,
	parseTokenBundleFdObservation,
	parseTokenCommitmentLeafManifest,
	parseWorkerPartial,
	permitNotBeforeMacNs,
	type RetainedCanonicalBytesV1,
	RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	ROLE_CHILD_FRAME_MAX_BYTES,
	type RolePartialAcceptedV1,
	type RoleWarmupCompleteV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	recomputeRootFromLeafManifest,
	resolveGlobalOrdinal,
	TOKEN_BUNDLE_FD,
	TOKEN_BUNDLE_FILE_MODE,
	type TokenBundleFdObservationV1,
	type TokenBundleV1,
	validateCohortStartBarrierPreconditions,
	validateConnectPermitCompletion,
	validateConnectPermitGrant,
	validateRoleWarmupCompletionManifest,
	validateTokenBundleBytes,
	WORKER_PARTIAL_MAX_BYTES,
	type WorkerPartialV1,
} from "./cohort-protocol.ts";
import {
	admitSignedRecordWithExpiryAndReplay,
	bytesOfCanonical,
	createMemoryReplayLedger,
	type Ed25519KeyPairBytes,
	type MacCohortEvidenceExportedAckV1,
	type MacExportCohortEvidenceRequestV1,
	type MacReceiptSignatureV1,
	type MacRigBarrierAcceptanceAckV1,
	type MacRigCohortAcceptanceAckV1,
	type MacStartBarrierIssuedAckV1,
	type MacWarmupCompletionManifestExportedAckV1,
	type MacWarmupEpochIssuedAckV1,
	type NsString,
	type ProtocolResult,
	parseRigReceiptSignature,
	type ReplayLedger,
	type ReplayLedgerSide,
	type RigReceiptSignatureV1,
	type Sha256Hex,
	STAGED_MAC_PUBLIC_KEY_LEAF,
	STAGED_RIG_PUBLIC_KEY_LEAF,
	sha256CanonicalRecord,
	signMacReceipt,
	verifyRigReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import { parseMeasurementGrant } from "./evidence.ts";
import {
	canonicalRecordBytes,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "./secure-fs.ts";
import {
	decodeSupervisorFrame,
	encodeSupervisorFrame,
	type MeasurementGrantV1,
} from "./supervisor-client.ts";
import {
	type MeasurementSeries,
	measurementPayloadBytes,
} from "./supervisor-protocol.ts";

export {
	STAGED_MAC_PUBLIC_KEY_LEAF,
	STAGED_RIG_PUBLIC_KEY_LEAF,
	createMemoryReplayLedger,
	type ReplayLedger,
	type ReplayLedgerSide,
};

export interface SupervisorConfig {
	/** Path to the flock file (always /tmp/bench.lock). */
	readonly lockFile: string;
	/** The network interface to restore on cleanup (always eno1). */
	readonly interface: string;
	/** The lease duration in ms. Controller must renew before expiry. */
	readonly leaseMs: number;
	/** The run ID this supervisor owns. */
	readonly runId: string;
}

export interface SupervisorState {
	readonly runId: string;
	readonly lockAcquired: boolean;
	readonly pgid: number | null;
	readonly leaseExpiry: number | null;
	readonly cleanupWritten: boolean;
	readonly lockReleased: boolean;
	readonly status: "active" | "cleaning-up" | "done" | "error";
}

export interface SupervisorCleanupResult {
	readonly runId: string;
	readonly pgidKilled: number | null;
	readonly qdiscRestored: boolean;
	readonly lockReleased: boolean;
	readonly artifactPath: string;
	readonly completedAt: number;
}

export interface LeaseRenewalResult {
	readonly accepted: boolean;
	readonly newExpiry: number;
}

/**
 * Validate that the supervisor has the bench lock before any network run.
 */
export function validateSupervisorLock(state: SupervisorState): {
	valid: boolean;
	reason?: string;
} {
	if (!state.lockAcquired) {
		return {
			valid: false,
			reason: "supervisor does not hold /tmp/bench.lock; cannot start run",
		};
	}
	if (state.status !== "active") {
		return {
			valid: false,
			reason: `supervisor is in state '${state.status}'; expected 'active'`,
		};
	}
	return { valid: true };
}

/**
 * Check whether the supervisor lease is still valid at the given timestamp.
 */
export function isLeaseValid(state: SupervisorState, nowMs: number): boolean {
	if (state.leaseExpiry === null) return false;
	return nowMs < state.leaseExpiry;
}

/**
 * Compute the heartbeat renewal timestamp given current time and lease duration.
 */
export function computeRenewal(
	state: SupervisorState,
	nowMs: number,
	leaseDurationMs: number,
): LeaseRenewalResult {
	const newExpiry = nowMs + leaseDurationMs;
	return {
		accepted: state.status === "active" && state.lockAcquired,
		newExpiry,
	};
}

// ---------------------------------------------------------------------------
// Phase 3.6.1: spawn contract
//
// `secure_fs.rs:7789` is explicit that the campaign has TWO residents: a
// Mac-resident supervisor that owns the Mac campaign root and the Mac
// staging root, and a Linux-resident supervisor that owns the Linux
// staging root and the Linux server PGID. The bytes that cross into each
// supervisor's process arrive over file descriptors, and the FD numbers
// the supervisor reads are the ones the controller passes in argv.
//
// The four trust-bootstrap FDs the supervisor reads:
//   --authority-fd        -> the campaign-authority/v1 record
//   --authority-digest-fd -> the campaign-authority's expected sha256
//   --campaign-root-fd    -> the campaign root directory FD
//   --staging-root-fd     -> the staging root directory FD
//
// And the optional control channel:
//   --control-in-fd       -> FD the supervisor reads from (controller writes)
//   --control-out-fd      -> FD the supervisor writes to (controller reads)
//
// The Rust source reads these at `comparison-supervisor.rs:84-92` and
// rejects duplicate numbers at `comparison-supervisor.rs:96-108`. Every
// FD passed to the supervisor must therefore be distinct.
// ---------------------------------------------------------------------------

/** A trust-bootstrap FD the supervisor opens before exec. */
export interface SupervisorFd {
	/** The OS FD number the supervisor will read after fork+exec inheritance. */
	readonly fd: number;
	/** A human-readable label for diagnostics and tests. */
	readonly label: string;
}

/** The four FDs the supervisor reads at startup. */
export interface TrustBootstrap {
	readonly authority: SupervisorFd;
	readonly authorityDigest: SupervisorFd;
	readonly campaignRoot: SupervisorFd;
	readonly stagingRoot: SupervisorFd;
}

/** The optional control channel FD pair. */
export interface ControlDescriptors {
	/** The FD the supervisor reads from; the controller writes here. */
	readonly controlIn: SupervisorFd;
	/** The FD the supervisor writes to; the controller reads here. */
	readonly controlOut: SupervisorFd;
}

export interface SupervisorSpawnOptions {
	/** Path to the comparison-supervisor binary. */
	readonly binaryPath: string;
	/** The four trust-bootstrap FDs (all distinct). */
	readonly bootstrap: TrustBootstrap;
	/** The control channel (omit for "no resident loop", per supervisor). */
	readonly control?: ControlDescriptors;
	/** Where the COMPARISON_SUPERVISOR_BUN_PATH env var should point. */
	readonly bunExecutablePath: string;
}

/** A typed refusal from the spawn helpers. */
export type SpawnRefusal =
	| {
			readonly ok: false;
			readonly code: "SPAWN_FD_DUPLICATE";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_BINARY_MISSING";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_BOOTSTRAP_FD_MISSING";
			readonly message: string;
	  };

/**
 * Pure helper: builds the argv the Mac-resident supervisor is spawned with.
 *
 * The argv is what `Bun.spawn` receives directly. The trust-bootstrap FDs
 * are inherited by the child via fork+exec; their FD numbers must already
 * be open in the parent at the moment of the spawn call.
 *
 * Order matters: the supervisor's `descriptor_option` parser
 * (`comparison-supervisor.rs:84-92`) scans the argv list, so every
 * `--*-fd N` pair must be present and must use a unique N. The function
 * refuses with `SPAWN_FD_DUPLICATE` before returning if any two descriptors
 * share a number.
 */
export function buildMacSupervisorArgv(
	options: SupervisorSpawnOptions,
): { readonly ok: true; readonly argv: readonly string[] } | SpawnRefusal {
	const fdCheck = assertDistinctFds(options);
	if (!fdCheck.ok) return fdCheck;
	if (!existsSync(options.binaryPath)) {
		return {
			ok: false,
			code: "SPAWN_BINARY_MISSING",
			message: `supervisor binary not found at ${options.binaryPath}`,
		};
	}
	const argv: string[] = [
		options.binaryPath,
		"--authority-fd",
		String(options.bootstrap.authority.fd),
		"--authority-digest-fd",
		String(options.bootstrap.authorityDigest.fd),
		"--campaign-root-fd",
		String(options.bootstrap.campaignRoot.fd),
		"--staging-root-fd",
		String(options.bootstrap.stagingRoot.fd),
	];
	if (options.control !== undefined) {
		argv.push(
			"--control-in-fd",
			String(options.control.controlIn.fd),
			"--control-out-fd",
			String(options.control.controlOut.fd),
		);
	}
	return { ok: true, argv };
}

/**
 * Pure helper: builds the shell script the controller runs over SSH on the
 * rig to spawn the Linux-resident supervisor. The script:
 *
 *   1. Opens the four trust-bootstrap files at their known paths on the
 *      rig (paths the staging step in Phase 3.6.0 published to both
 *      hosts), getting OS FD numbers.
 *   2. Execs the supervisor binary with those FD numbers in argv.
 *
 * The control channel for the rig-resident supervisor is the SSH
 * session's stdin/stdout directly: the supervisor reads
 * `--control-in-fd 0` / `--control-out-fd 1`, and the SSH client the
 * controller hands it writes/reads those FDs. No pipes, no SCM_RIGHTS;
 * standard Unix process plumbing.
 *
 * Returns the script body. The caller pipes it through `ssh host bash -s`
 * or writes it to a file and `scp`s it; the script is otherwise
 * self-contained.
 */
export function buildRigSupervisorWrapperScript(
	options: SupervisorSpawnOptions & {
		/** The four rig-side paths the staging step published. */
		readonly rigPaths: {
			readonly authorityFile: string;
			readonly authorityDigestFile: string;
			readonly campaignRootDir: string;
			readonly stagingRootDir: string;
		};
		/** The full path to the supervisor binary on the rig. */
		readonly rigBinaryPath: string;
	},
): { readonly ok: true; readonly script: string } | SpawnRefusal {
	const fdCheck = assertDistinctFds(options);
	if (!fdCheck.ok) return fdCheck;

	// The script pipes authority bytes (anonymous pipe — regular files are
	// refused by TRUST_AUTHORITY_PIPE_*), opens the digest + two directory
	// roots, then exec's the supervisor with fixed child slots 3..6 and
	// control on SSH stdin/stdout (0/1). Uses bash for process substitution.
	const script = `#!/usr/bin/env bash
set -eu
authority_fd=3
authority_digest_fd=4
campaign_root_fd=5
staging_root_fd=6
exec 3< <(cat -- ${shellQuote(options.rigPaths.authorityFile)})
exec 4<${shellQuote(options.rigPaths.authorityDigestFile)}
exec 5<${shellQuote(options.rigPaths.campaignRootDir)}
exec 6<${shellQuote(options.rigPaths.stagingRootDir)}
exec ${shellQuote(options.rigBinaryPath)} \\
  --authority-fd "\${authority_fd}" \\
  --authority-digest-fd "\${authority_digest_fd}" \\
  --campaign-root-fd "\${campaign_root_fd}" \\
  --staging-root-fd "\${staging_root_fd}" \\
  --control-in-fd 0 \\
  --control-out-fd 1
`;
	return { ok: true, script };
}

function shellQuote(s: string): string {
	// Single-quote everything; replace any embedded single quotes with the
	// standard '\'' close-quote/escape/reopen form.
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pure helper: refuses if any two FDs in the bootstrap + control channel
 * share a number. The supervisor's `resolve_descriptors` rejects duplicates
 * (`comparison-supervisor.rs:96-108`); the spawn helpers must catch this
 * earlier so the caller gets a typed refusal, not a supervisor startup
 * failure.
 */
export function assertDistinctFds(
	options: SupervisorSpawnOptions,
): { readonly ok: true } | SpawnRefusal {
	const all: SupervisorFd[] = [
		options.bootstrap.authority,
		options.bootstrap.authorityDigest,
		options.bootstrap.campaignRoot,
		options.bootstrap.stagingRoot,
	];
	if (options.control !== undefined) {
		all.push(options.control.controlIn, options.control.controlOut);
	}
	const seen = new Set<number>();
	for (const fd of all) {
		if (!Number.isInteger(fd.fd) || fd.fd < 0) {
			return {
				ok: false,
				code: "SPAWN_BOOTSTRAP_FD_MISSING",
				message: `FD ${fd.label} must be a non-negative integer, got ${fd.fd}`,
			};
		}
		if (seen.has(fd.fd)) {
			return {
				ok: false,
				code: "SPAWN_FD_DUPLICATE",
				message: `FD ${fd.label} collides with another descriptor at ${fd.fd}`,
			};
		}
		seen.add(fd.fd);
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Live spawn helpers
//
// These call `Bun.spawn`. They are deliberately thin: they open the four
// trust-bootstrap FDs in the parent, build the argv, and let Bun.spawn
// inherit the FDs across fork+exec. The `SupervisorHandle` returned owns
// the bootstrap FDs and the control pipe ends; the caller is responsible
// for `stopSupervisor(handle)` to release them.
//
// These are NOT covered by the unit tests in this module because Bun.spawn
// + real OS FDs is not what the tests want to assert — that path is
// exercised by the controller's e2e tests (Phase 3.6.5). The tests here
// pin the pure contract: argv construction, FD distinctness, control
// pipe direction, and the pipe(2)/CLOEXEC helper.
// ---------------------------------------------------------------------------

const F_SETFD = 2;
const FD_CLOEXEC = 1;

const libc = dlopen(
	process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
	{
		pipe: {
			args: [FFIType.ptr],
			returns: FFIType.i32,
		},
		fcntl: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
	},
);

/**
 * One anonymous Unix pipe: the supervisor-inherited end has no CLOEXEC;
 * the controller-kept end has FD_CLOEXEC so fork+exec cannot leak it into
 * a grandchild.
 */
export interface UnixPipeEnds {
	/** End the supervisor inherits (no CLOEXEC). */
	readonly childFd: number;
	/** End the controller keeps (FD_CLOEXEC). */
	readonly parentFd: number;
}

/**
 * Create a `pipe(2)` pair and mark `parentFd` with `FD_CLOEXEC`.
 *
 * Direction is encoded by the caller: for control-in, `childFd` is the
 * read end (supervisor reads) and `parentFd` is the write end (controller
 * writes). For control-out, `childFd` is the write end and `parentFd` is
 * the read end.
 */
export function createCloexecPipe(direction: {
	readonly parentKeeps: "read" | "write";
}):
	| { readonly ok: true; readonly pipe: UnixPipeEnds }
	| {
			readonly ok: false;
			readonly code: "SPAWN_PIPE_FAILED";
			readonly message: string;
	  } {
	const fds = new Int32Array(2);
	const rc = libc.symbols.pipe(ptr(fds));
	if (rc !== 0) {
		return {
			ok: false,
			code: "SPAWN_PIPE_FAILED",
			message: `pipe(2) failed with return ${rc}`,
		};
	}
	const readFd = fds[0] as number;
	const writeFd = fds[1] as number;
	const parentFd = direction.parentKeeps === "write" ? writeFd : readFd;
	const childFd = direction.parentKeeps === "write" ? readFd : writeFd;
	const cloexec = libc.symbols.fcntl(parentFd, F_SETFD, FD_CLOEXEC);
	if (cloexec !== 0) {
		safeClose(readFd);
		safeClose(writeFd);
		return {
			ok: false,
			code: "SPAWN_PIPE_FAILED",
			message: `fcntl(F_SETFD, FD_CLOEXEC) failed on parent fd ${parentFd}`,
		};
	}
	return { ok: true, pipe: { childFd, parentFd } };
}

/**
 * Create the control-in / control-out pipe pair the Mac-resident
 * supervisor expects (architect 5.3).
 */
export function createControlPipePair():
	| {
			readonly ok: true;
			readonly controlIn: UnixPipeEnds;
			readonly controlOut: UnixPipeEnds;
			readonly controllerToSupervisor: Writable;
			readonly supervisorToController: Readable;
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_PIPE_FAILED";
			readonly message: string;
	  } {
	const inbound = createCloexecPipe({ parentKeeps: "write" });
	if (!inbound.ok) return inbound;
	const outbound = createCloexecPipe({ parentKeeps: "read" });
	if (!outbound.ok) {
		safeClose(inbound.pipe.childFd);
		safeClose(inbound.pipe.parentFd);
		return outbound;
	}
	return {
		ok: true,
		controlIn: inbound.pipe,
		controlOut: outbound.pipe,
		controllerToSupervisor: createWriteStream("", {
			fd: inbound.pipe.parentFd,
			autoClose: false,
		}),
		supervisorToController: createReadStream("", {
			fd: outbound.pipe.parentFd,
			autoClose: false,
		}),
	};
}

/** A spawned supervisor and the channels that talk to it. */
export interface SupervisorHandle {
	/** The OS PID the supervisor's process started at. */
	readonly pid: number;
	/** Which host this supervisor lives on. */
	readonly host: "mac" | "rig";
	/**
	 * Process handle used by `stopSupervisor`. Mac spawn uses Node
	 * `child_process` so stdin/stdout are real Node streams; rig spawn
	 * still uses `Bun.Subprocess` and casts its pipes.
	 */
	readonly subprocess: SupervisorSubprocess;
	/** The four bootstrap FDs the parent opened; closed on stopSupervisor. */
	readonly bootstrapFds: readonly number[];
	/**
	 * What the controller writes; the supervisor reads (`--control-in-fd`).
	 * Absent when the spawn asked for no control channel.
	 */
	readonly controllerToSupervisor?: Writable;
	/**
	 * What the supervisor writes; the controller reads (`--control-out-fd`).
	 * Absent when the spawn asked for no control channel.
	 */
	readonly supervisorToController?: Readable;
	/** Control pipe FDs owned by the parent; closed on stopSupervisor. */
	readonly controlParentFds: readonly number[];
}

/** Minimal process surface shared by Bun and Node supervisor children. */
export interface SupervisorSubprocess {
	readonly pid: number;
	readonly exitCode: number | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	readonly exited: Promise<number>;
}

function wrapNodeChild(
	child: ChildProcessWithoutNullStreams,
): SupervisorSubprocess {
	const exited = new Promise<number>((resolve) => {
		child.once("exit", (code, signal) => {
			if (typeof code === "number") resolve(code);
			else resolve(signal === null ? -1 : 1);
		});
	});
	return {
		get pid() {
			return child.pid ?? -1;
		},
		get exitCode() {
			return child.exitCode;
		},
		kill(signal?: NodeJS.Signals | number): boolean {
			return child.kill(signal);
		},
		exited,
	};
}

function wrapBunSubprocess(proc: Bun.Subprocess): SupervisorSubprocess {
	return {
		get pid() {
			return proc.pid;
		},
		get exitCode() {
			return proc.exitCode;
		},
		kill(signal?: NodeJS.Signals | number): boolean {
			try {
				proc.kill(signal as NodeJS.Signals | undefined);
				return true;
			} catch {
				return false;
			}
		},
		exited: proc.exited,
	};
}

/** Refusal from the live spawn helpers. */
export type LiveSpawnRefusal =
	| SpawnRefusal
	| {
			readonly ok: false;
			readonly code: "SPAWN_BINARY_OPEN_FAILED";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_PIPE_FAILED";
			readonly message: string;
	  };

/**
 * Spawn the Mac-resident supervisor locally.
 *
 * Bun.spawn does not reliably remap arbitrary parent FDs onto fixed child
 * slots for this binary's trust bootstrap, so Mac spawn matches the rig
 * pattern: a bash wrapper opens the four trust roots (authority over an
 * anonymous pipe), then `exec`s the supervisor with `--control-in-fd 0` /
 * `--control-out-fd 1`. The controller's `stdin`/`stdout` pipes ARE the
 * control channel.
 *
 * Returns a `SupervisorHandle` the caller stores; `stopSupervisor(handle)`
 * kills the child (bash is replaced by `exec`, so the pid is the supervisor).
 */
export async function spawnMacSupervisor(
	options: SupervisorSpawnOptions & {
		/** The four local paths the staging step published. */
		readonly localPaths: {
			readonly authorityFile: string;
			readonly authorityDigestFile: string;
			readonly campaignRootDir: string;
			readonly stagingRootDir: string;
		};
		/**
		 * When true (default), wire control over bash stdin/stdout.
		 * Set false only for bootstrap-only probes (wrapper still opens
		 * control FDs 0/1 against `/dev/null` so the resident loop can
		 * exit immediately after toolchain observation — unused today).
		 */
		readonly controlChannel?: boolean;
	},
): Promise<
	{ readonly ok: true; readonly handle: SupervisorHandle } | LiveSpawnRefusal
> {
	const wantControl = options.controlChannel !== false;
	const wrapper = buildRigSupervisorWrapperScript({
		binaryPath: options.binaryPath,
		bunExecutablePath: options.bunExecutablePath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		// Control rides Bun.spawn stdin/stdout (0/1), same as the rig SSH path.
		control: {
			controlIn: { fd: 0, label: "control-in" },
			controlOut: { fd: 1, label: "control-out" },
		},
		rigPaths: options.localPaths,
		rigBinaryPath: options.binaryPath,
	});
	if (!wrapper.ok) return wrapper;

	const scriptPath = join(
		tmpdir(),
		`wtb-mac-supervisor-${process.pid}-${Date.now()}.sh`,
	);
	try {
		writeFileSync(scriptPath, wrapper.script, { mode: 0o700 });
	} catch (error) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `cannot write mac supervisor wrapper: ${(error as Error).message}`,
		};
	}

	let child: ChildProcessWithoutNullStreams;
	try {
		child = nodeSpawn("bash", [scriptPath], {
			stdio: wantControl
				? ["pipe", "pipe", "pipe"]
				: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				COMPARISON_SUPERVISOR_BUN_PATH: options.bunExecutablePath,
			},
		}) as ChildProcessWithoutNullStreams;
	} catch (error) {
		try {
			unlinkSync(scriptPath);
		} catch {
			// ignore
		}
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `node spawn(bash wrapper) failed: ${(error as Error).message}`,
		};
	}

	const proc = wrapNodeChild(child);

	// Drain stderr so a failed bootstrap cannot block on a full pipe.
	const stderrChunks: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => {
		stderrChunks.push(Buffer.from(chunk));
	});

	// Bootstrap is synchronous; a dead child here means trust roots or
	// toolchain observation failed before the resident loop. Keep the
	// wrapper path until bash has opened it (unlink after the alive check).
	await Bun.sleep(150);
	if (proc.exitCode !== null) {
		try {
			unlinkSync(scriptPath);
		} catch {
			// ignore
		}
		const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `mac supervisor exited ${proc.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`,
		};
	}
	try {
		unlinkSync(scriptPath);
	} catch {
		// ignore — bash may still hold the inode
	}

	if (!wantControl) {
		return {
			ok: true,
			handle: {
				pid: proc.pid,
				host: "mac",
				subprocess: proc,
				bootstrapFds: [],
				controlParentFds: [],
			},
		};
	}

	return {
		ok: true,
		handle: {
			pid: proc.pid,
			host: "mac",
			subprocess: proc,
			bootstrapFds: [],
			controllerToSupervisor: child.stdin,
			supervisorToController: child.stdout,
			controlParentFds: [],
		},
	};
}

/**
 * Spawn the rig-resident supervisor over SSH. The controller calls this on
 * the Mac; SSH connects to the rig, runs the wrapper script returned by
 * `buildRigSupervisorWrapperScript`, and the wrapper opens the four
 * trust-bootstrap files on the rig and exec's the supervisor binary.
 *
 * The control channel is the SSH session's stdin/stdout: the supervisor's
 * `--control-in-fd 0` is the SSH stdin (controller writes), and
 * `--control-out-fd 1` is the SSH stdout (controller reads). The caller
 * uses `Bun.spawn(["ssh", ...], { stdin: "pipe", stdout: "pipe" })` to
 * wire this up; this helper builds the SSH argv.
 *
 * The function returns the SSH argv; actual spawning is the caller's job.
 * That separation is what makes the function testable without a real rig.
 */
export function buildRigSshArgv(
	options: SupervisorSpawnOptions & {
		readonly rigPaths: {
			readonly authorityFile: string;
			readonly authorityDigestFile: string;
			readonly campaignRootDir: string;
			readonly stagingRootDir: string;
		};
		readonly rigBinaryPath: string;
		/** SSH user + host (e.g. `hermes-admin@10.99.0.2`). */
		readonly sshTarget: string;
		/** SSH identity file (e.g. `~/.ssh/ubuntu-vm-hermes`). */
		readonly sshIdentity: string;
	},
):
	| {
			readonly ok: true;
			readonly sshArgv: readonly string[];
			readonly wrapperScript: string;
	  }
	| SpawnRefusal {
	const wrapper = buildRigSupervisorWrapperScript(options);
	if (!wrapper.ok) return wrapper;
	const sshArgv: readonly string[] = [
		"ssh",
		"-i",
		options.sshIdentity,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		"-T", // no pty: stdin/stdout ARE the supervisor's control FDs
		options.sshTarget,
		"--",
		"bash",
		"-s", // read bash wrapper (process substitution) from stdin
	];
	return { ok: true, sshArgv, wrapperScript: wrapper.script };
}

/**
 * Spawn the Linux-resident supervisor over SSH.
 *
 * The wrapper script cannot share stdin with the control channel (`bash -s`
 * would consume stdin before `exec`), so this helper:
 *   1. Uploads the wrapper to a temp path on the rig over SSH.
 *   2. Starts a second SSH session whose stdin/stdout ARE the supervisor's
 *      `--control-in-fd 0` / `--control-out-fd 1`.
 */
export async function spawnRigSupervisor(
	options: SupervisorSpawnOptions & {
		readonly rigPaths: {
			readonly authorityFile: string;
			readonly authorityDigestFile: string;
			readonly campaignRootDir: string;
			readonly stagingRootDir: string;
		};
		readonly rigBinaryPath: string;
		readonly sshTarget: string;
		readonly sshIdentity: string;
	},
): Promise<
	{ readonly ok: true; readonly handle: SupervisorHandle } | LiveSpawnRefusal
> {
	const built = buildRigSshArgv(options);
	if (!built.ok) return built;

	const remoteWrapper = `/tmp/ws-wt-rig-supervisor-wrapper.$$`;
	const uploadArgv = [
		"ssh",
		"-i",
		options.sshIdentity,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		"-T",
		options.sshTarget,
		"--",
		"bash",
		"-c",
		`cat >${remoteWrapper} && chmod 700 ${remoteWrapper}`,
	];
	try {
		const upload = Bun.spawn(uploadArgv, {
			stdin: new Blob([built.wrapperScript]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const uploadCode = await upload.exited;
		if (uploadCode !== 0) {
			const stderr = await new Response(upload.stderr).text();
			return {
				ok: false,
				code: "SPAWN_BINARY_OPEN_FAILED",
				message: `rig wrapper upload failed (${uploadCode}): ${stderr.trim()}`,
			};
		}
	} catch (error) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `rig wrapper upload failed: ${(error as Error).message}`,
		};
	}

	const runArgv = [
		"ssh",
		"-i",
		options.sshIdentity,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		"-T",
		options.sshTarget,
		"--",
		"bash",
		remoteWrapper,
	];
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn(runArgv, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				COMPARISON_SUPERVISOR_BUN_PATH: options.bunExecutablePath,
			},
		});
	} catch (error) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `rig supervisor ssh spawn failed: ${(error as Error).message}`,
		};
	}

	const stdout = proc.stdout;
	const stdin = proc.stdin;
	if (stdout === null || stdin === null || typeof stdin === "number") {
		try {
			proc.kill("SIGKILL");
		} catch {
			// ignore
		}
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: "rig supervisor spawn did not expose stdin/stdout pipes",
		};
	}

	return {
		ok: true,
		handle: {
			pid: proc.pid,
			host: "rig",
			subprocess: wrapBunSubprocess(proc),
			bootstrapFds: [],
			controllerToSupervisor: stdin as unknown as Writable,
			supervisorToController: stdout as unknown as Readable,
			controlParentFds: [],
		},
	};
}

/**
 * Bounded supervisor shutdown. Sends SIGTERM, waits up to `deadlineMs`,
 * then SIGKILL if the child is still alive. Closes the parent's bootstrap
 * FDs.
 */
export async function stopSupervisor(
	handle: SupervisorHandle,
	deadlineMs: number,
): Promise<{ readonly ok: true; readonly exitCode: number }> {
	const closeOwnedFds = (): void => {
		for (const fd of handle.bootstrapFds) safeClose(fd);
		for (const fd of handle.controlParentFds) safeClose(fd);
		try {
			handle.controllerToSupervisor?.end();
		} catch {
			// ignore
		}
		try {
			handle.supervisorToController?.destroy();
		} catch {
			// ignore
		}
	};
	const proc = handle.subprocess;
	try {
		proc.kill("SIGTERM");
	} catch {
		// already exited; close FDs and report
		closeOwnedFds();
		return { ok: true, exitCode: 0 };
	}
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			closeOwnedFds();
			return { ok: true, exitCode: proc.exitCode };
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		// ignore
	}
	closeOwnedFds();
	return { ok: true, exitCode: proc.exitCode ?? -1 };
}

function safeClose(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// already closed or invalid; ignore
	}
}

/** Default relative path to the Mac-built comparison-supervisor binary. */
export const DEFAULT_SUPERVISOR_BINARY_RELATIVE =
	"target/release/comparison-supervisor";

/**
 * Resolve the Mac-resident supervisor binary. Prefers
 * `COMPARISON_SUPERVISOR_BINARY` when set; otherwise
 * `<cwd>/target/release/comparison-supervisor`.
 */
export function resolveSupervisorBinaryPath(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
):
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly message: string } {
	const fromEnv = env.COMPARISON_SUPERVISOR_BINARY;
	const candidate =
		typeof fromEnv === "string" && fromEnv.length > 0
			? fromEnv
			: join(cwd, DEFAULT_SUPERVISOR_BINARY_RELATIVE);
	if (!existsSync(candidate)) {
		return {
			ok: false,
			message: `supervisor binary not found at ${candidate} (set COMPARISON_SUPERVISOR_BINARY or build target/release/comparison-supervisor)`,
		};
	}
	return { ok: true, path: candidate };
}

/**
 * Resolve the Bun executable the supervisor re-execs measurement roles with.
 * Prefers `COMPARISON_SUPERVISOR_BUN_PATH`; otherwise `~/.bun/bin/bun` via
 * `$HOME`, falling back to `bun` on PATH only when `$HOME` is unset.
 */
export function resolveSupervisorBunPath(
	env: NodeJS.ProcessEnv = process.env,
):
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly message: string } {
	const fromEnv = env.COMPARISON_SUPERVISOR_BUN_PATH;
	if (typeof fromEnv === "string" && fromEnv.length > 0) {
		return { ok: true, path: fromEnv };
	}
	const home = env.HOME;
	if (typeof home === "string" && home.length > 0) {
		const candidate = join(home, ".bun", "bin", "bun");
		if (existsSync(candidate)) return { ok: true, path: candidate };
	}
	return {
		ok: false,
		message:
			"COMPARISON_SUPERVISOR_BUN_PATH unset and ~/.bun/bin/bun not found",
	};
}

// ---------------------------------------------------------------------------
// Phase 3.6.0 — Stage the trust bootstrap the Mac/rig supervisors open
//
// Layout under `stagedDir` (matches secure_fs leaf names):
//   authority.json
//   authority-digest.bin   (32 raw SHA-256 bytes, not hex)
//   campaign-root/
//     campaign-lock.json
//     manifest.json
//   staging-root/
//     staged-capability.json
// ---------------------------------------------------------------------------

export const TRUST_BOOTSTRAP_AUTHORITY_LEAF = "authority.json";
export const TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF = "authority-digest.bin";
export const TRUST_BOOTSTRAP_CAMPAIGN_ROOT = "campaign-root";
export const TRUST_BOOTSTRAP_STAGING_ROOT = "staging-root";
export const TRUST_BOOTSTRAP_LOCK_LEAF = "campaign-lock.json";
export const TRUST_BOOTSTRAP_CAPABILITY_LEAF = "staged-capability.json";
export const TRUST_BOOTSTRAP_MANIFEST_LEAF = "manifest.json";

const HEX_64 = /^[0-9a-f]{64}$/u;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function hexToRawDigest(hex: string): Uint8Array | null {
	if (!HEX_64.test(hex)) return null;
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** Bytes the staging step writes under `stagedDir`. */
export interface TrustBootstrapMaterial {
	readonly authorityBytes: Uint8Array;
	/** Lowercase hex SHA-256 of `authorityBytes`; must match the bytes. */
	readonly authoritySha256Hex: string;
	readonly campaignLockBytes: Uint8Array;
	readonly stagedCapabilityBytes: Uint8Array;
	readonly manifestBytes: Uint8Array;
}

/** Absolute paths `spawnMacSupervisor` / the rig wrapper consume. */
export interface StagedTrustBootstrapPaths {
	readonly stagedDir: string;
	readonly authorityFile: string;
	readonly authorityDigestFile: string;
	readonly campaignRootDir: string;
	readonly stagingRootDir: string;
	readonly digests: {
		readonly authority: string;
		readonly lock: string;
		readonly capability: string;
		readonly manifest: string;
	};
}

export type StageTrustRefusal =
	| {
			readonly ok: false;
			readonly code: "STAGE_DIGEST_MISMATCH";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "STAGE_DIGEST_IMPLAUSIBLE";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "STAGE_WRITE_FAILED";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "STAGE_VERIFY_FAILED";
			readonly message: string;
	  };

/**
 * Write the four trust-bootstrap surfaces under `stagedDir` and return the
 * absolute paths the Mac-resident spawn opens. Refuses when the supplied
 * authority digest does not hash-match the authority bytes, or when the
 * digest is not 64-char lowercase hex.
 */
export function stageTrustBootstrap(
	stagedDir: string,
	material: TrustBootstrapMaterial,
):
	| { readonly ok: true; readonly paths: StagedTrustBootstrapPaths }
	| StageTrustRefusal {
	if (!HEX_64.test(material.authoritySha256Hex)) {
		return {
			ok: false,
			code: "STAGE_DIGEST_IMPLAUSIBLE",
			message: `authoritySha256Hex must be 64 lowercase hex chars; got length ${material.authoritySha256Hex.length}`,
		};
	}
	const actual = sha256Hex(material.authorityBytes);
	if (actual !== material.authoritySha256Hex) {
		return {
			ok: false,
			code: "STAGE_DIGEST_MISMATCH",
			message: `authority bytes hash to ${actual}, not the declared ${material.authoritySha256Hex}`,
		};
	}
	const rawDigest = hexToRawDigest(material.authoritySha256Hex);
	if (rawDigest === null) {
		return {
			ok: false,
			code: "STAGE_DIGEST_IMPLAUSIBLE",
			message: "authoritySha256Hex could not be decoded to 32 bytes",
		};
	}

	const campaignRootDir = join(stagedDir, TRUST_BOOTSTRAP_CAMPAIGN_ROOT);
	const stagingRootDir = join(stagedDir, TRUST_BOOTSTRAP_STAGING_ROOT);
	const authorityFile = join(stagedDir, TRUST_BOOTSTRAP_AUTHORITY_LEAF);
	const authorityDigestFile = join(
		stagedDir,
		TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	);
	const lockFile = join(campaignRootDir, TRUST_BOOTSTRAP_LOCK_LEAF);
	const manifestFile = join(campaignRootDir, TRUST_BOOTSTRAP_MANIFEST_LEAF);
	const capabilityFile = join(stagingRootDir, TRUST_BOOTSTRAP_CAPABILITY_LEAF);

	try {
		mkdirSync(campaignRootDir, { recursive: true, mode: 0o700 });
		mkdirSync(stagingRootDir, { recursive: true, mode: 0o700 });
		writeFileSync(authorityFile, material.authorityBytes, { mode: 0o600 });
		writeFileSync(authorityDigestFile, rawDigest, { mode: 0o600 });
		writeFileSync(lockFile, material.campaignLockBytes, { mode: 0o600 });
		writeFileSync(manifestFile, material.manifestBytes, { mode: 0o600 });
		writeFileSync(capabilityFile, material.stagedCapabilityBytes, {
			mode: 0o600,
		});
	} catch (error) {
		return {
			ok: false,
			code: "STAGE_WRITE_FAILED",
			message: `cannot write trust bootstrap under ${stagedDir}: ${(error as Error).message}`,
		};
	}

	return {
		ok: true,
		paths: {
			stagedDir,
			authorityFile,
			authorityDigestFile,
			campaignRootDir,
			stagingRootDir,
			digests: {
				authority: actual,
				lock: sha256Hex(material.campaignLockBytes),
				capability: sha256Hex(material.stagedCapabilityBytes),
				manifest: sha256Hex(material.manifestBytes),
			},
		},
	};
}

/**
 * Re-open a previously staged directory and prove the on-disk authority
 * matches `expectedAuthoritySha256` and that the digest file is the raw
 * 32-byte form of that hex. Also requires the three campaign leaf files.
 */
export function verifyStagedTrustBootstrap(
	stagedDir: string,
	expectedAuthoritySha256: string,
):
	| { readonly ok: true; readonly paths: StagedTrustBootstrapPaths }
	| StageTrustRefusal {
	if (!HEX_64.test(expectedAuthoritySha256)) {
		return {
			ok: false,
			code: "STAGE_DIGEST_IMPLAUSIBLE",
			message: `expectedAuthoritySha256 must be 64 lowercase hex chars`,
		};
	}
	const authorityFile = join(stagedDir, TRUST_BOOTSTRAP_AUTHORITY_LEAF);
	const authorityDigestFile = join(
		stagedDir,
		TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	);
	const campaignRootDir = join(stagedDir, TRUST_BOOTSTRAP_CAMPAIGN_ROOT);
	const stagingRootDir = join(stagedDir, TRUST_BOOTSTRAP_STAGING_ROOT);
	const lockFile = join(campaignRootDir, TRUST_BOOTSTRAP_LOCK_LEAF);
	const manifestFile = join(campaignRootDir, TRUST_BOOTSTRAP_MANIFEST_LEAF);
	const capabilityFile = join(stagingRootDir, TRUST_BOOTSTRAP_CAPABILITY_LEAF);

	for (const path of [
		authorityFile,
		authorityDigestFile,
		lockFile,
		manifestFile,
		capabilityFile,
	]) {
		if (!existsSync(path)) {
			return {
				ok: false,
				code: "STAGE_VERIFY_FAILED",
				message: `staged trust bootstrap missing ${path}`,
			};
		}
	}

	let authorityBytes: Uint8Array;
	let digestBytes: Uint8Array;
	let lockBytes: Uint8Array;
	let capabilityBytes: Uint8Array;
	let manifestBytes: Uint8Array;
	try {
		authorityBytes = new Uint8Array(readFileSync(authorityFile));
		digestBytes = new Uint8Array(readFileSync(authorityDigestFile));
		lockBytes = new Uint8Array(readFileSync(lockFile));
		capabilityBytes = new Uint8Array(readFileSync(capabilityFile));
		manifestBytes = new Uint8Array(readFileSync(manifestFile));
	} catch (error) {
		return {
			ok: false,
			code: "STAGE_VERIFY_FAILED",
			message: `cannot read staged trust bootstrap: ${(error as Error).message}`,
		};
	}

	const actual = sha256Hex(authorityBytes);
	if (actual !== expectedAuthoritySha256) {
		return {
			ok: false,
			code: "STAGE_DIGEST_MISMATCH",
			message: `authority on disk hashes to ${actual}, expected ${expectedAuthoritySha256}`,
		};
	}
	if (digestBytes.byteLength !== 32) {
		return {
			ok: false,
			code: "STAGE_VERIFY_FAILED",
			message: `authority-digest.bin must be 32 bytes; got ${digestBytes.byteLength}`,
		};
	}
	const digestAsHex = [...digestBytes]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	if (digestAsHex !== expectedAuthoritySha256) {
		return {
			ok: false,
			code: "STAGE_DIGEST_MISMATCH",
			message: `authority-digest.bin decodes to ${digestAsHex}, expected ${expectedAuthoritySha256}`,
		};
	}

	return {
		ok: true,
		paths: {
			stagedDir,
			authorityFile,
			authorityDigestFile,
			campaignRootDir,
			stagingRootDir,
			digests: {
				authority: actual,
				lock: sha256Hex(lockBytes),
				capability: sha256Hex(capabilityBytes),
				manifest: sha256Hex(manifestBytes),
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Control-channel frame I/O (controller ↔ resident supervisor)
// ---------------------------------------------------------------------------

const SUPERVISOR_FRAME_SCHEMA = "comparison-supervisor-frame/v1" as const;
const OPEN_EXECUTION_KIND = "open-execution" as const;
const RUN_COMMAND_KIND = "run-command" as const;
const ARTIFACT_PAYLOAD_KIND = "artifact-payload" as const;
const ADMISSION_RECEIPT_KIND = "admission-receipt" as const;
const ADMISSION_REFUSAL_KIND = "admission-refusal" as const;
/** Same bound as `secure_fs::measurement::RUN_COMMAND_MAX_BYTES`. */
export const SUPERVISOR_RUN_COMMAND_MAX_BYTES = 65_536;
/** Same bound as `secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES`. */
export const SUPERVISOR_ARTIFACT_PAYLOAD_MAX_BYTES = 16_777_216;

export type ControlChannelRefusal = {
	readonly ok: false;
	readonly code:
		| "CONTROL_CHANNEL_MISSING"
		| "CONTROL_FRAME_ENCODE_FAILED"
		| "CONTROL_FRAME_WRITE_FAILED"
		| "CONTROL_FRAME_READ_TIMEOUT"
		| "CONTROL_FRAME_DECODE_FAILED"
		| "CONTROL_FRAME_UNEXPECTED_KIND"
		| "CONTROL_GRANT_MALFORMED"
		| "CONTROL_ADMISSION_REFUSED";
	readonly message: string;
};

function frameHeaderBytes(kind: string): Uint8Array {
	return canonicalRecordBytes({
		kind,
		schema: SUPERVISOR_FRAME_SCHEMA,
	});
}

function writeAll(writable: Writable, bytes: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		writable.write(Buffer.from(bytes), (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

/**
 * Read one complete supervisor frame from a Readable, buffering until the
 * codec can decode (or the deadline elapses).
 */
export async function readControlFrame(
	readable: Readable,
	payloadBound: number,
	deadlineMs: number,
): Promise<
	| {
			readonly ok: true;
			readonly frameBytes: Uint8Array;
			readonly kind: string;
	  }
	| ControlChannelRefusal
> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const deadline = Date.now() + deadlineMs;

	const tryDecode = ():
		| {
				readonly ok: true;
				readonly frameBytes: Uint8Array;
				readonly kind: string;
		  }
		| { readonly ok: false; readonly truncated: boolean }
		| ControlChannelRefusal => {
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const decoded = decodeSupervisorFrame(merged, payloadBound);
		if (!decoded.ok) {
			if (decoded.code === "FRAME_TRUNCATED") {
				return { ok: false, truncated: true };
			}
			return {
				ok: false,
				code: "CONTROL_FRAME_DECODE_FAILED",
				message: `control frame decode failed: ${decoded.code}`,
			};
		}
		let header: { kind?: unknown };
		try {
			header = JSON.parse(
				new TextDecoder().decode(decoded.value.frame.header),
			) as { kind?: unknown };
		} catch {
			return {
				ok: false,
				code: "CONTROL_FRAME_DECODE_FAILED",
				message: "control frame header is not JSON",
			};
		}
		if (typeof header.kind !== "string" || header.kind.length === 0) {
			return {
				ok: false,
				code: "CONTROL_FRAME_DECODE_FAILED",
				message: "control frame header missing kind",
			};
		}
		return {
			ok: true,
			frameBytes: merged.slice(0, decoded.value.consumed),
			kind: header.kind,
		};
	};

	while (Date.now() < deadline) {
		const early = tryDecode();
		if ("code" in early) return early;
		if (early.ok) return early;

		const remaining = Math.max(1, deadline - Date.now());
		const chunk: Buffer | null = await new Promise((resolve) => {
			const onReadable = (): void => {
				cleanup();
				resolve(readable.read() as Buffer | null);
			};
			const onEnd = (): void => {
				cleanup();
				resolve(null);
			};
			const onError = (): void => {
				cleanup();
				resolve(null);
			};
			const timer = setTimeout(
				() => {
					cleanup();
					resolve(null);
				},
				Math.min(remaining, 250),
			);
			const cleanup = (): void => {
				clearTimeout(timer);
				readable.off("readable", onReadable);
				readable.off("end", onEnd);
				readable.off("error", onError);
			};
			readable.once("readable", onReadable);
			readable.once("end", onEnd);
			readable.once("error", onError);
			const immediate = readable.read() as Buffer | null;
			if (immediate !== null) {
				cleanup();
				resolve(immediate);
			}
		});
		if (chunk === null || chunk.byteLength === 0) {
			if (readable.readableEnded) break;
			continue;
		}
		chunks.push(new Uint8Array(chunk));
		total += chunk.byteLength;
	}

	const final = tryDecode();
	if ("code" in final) return final;
	if (final.ok) return final;
	return {
		ok: false,
		code: "CONTROL_FRAME_READ_TIMEOUT",
		message: `control frame read timed out after ${deadlineMs}ms`,
	};
}

async function writeControlFrame(
	writable: Writable,
	kind: string,
	payload: Uint8Array,
	payloadBound: number,
): Promise<{ readonly ok: true } | ControlChannelRefusal> {
	const encoded = encodeSupervisorFrame(
		frameHeaderBytes(kind),
		payload,
		payloadBound,
	);
	if (!encoded.ok) {
		return {
			ok: false,
			code: "CONTROL_FRAME_ENCODE_FAILED",
			message: `encode ${kind} failed: ${encoded.code}`,
		};
	}
	try {
		await writeAll(writable, encoded.value);
	} catch (error) {
		return {
			ok: false,
			code: "CONTROL_FRAME_WRITE_FAILED",
			message: `write ${kind} failed: ${(error as Error).message}`,
		};
	}
	return { ok: true };
}

export interface OpenExecutionRequest {
	readonly runId: string;
	readonly transport: "ws" | "wt";
	readonly declaredMessageCount: number;
	readonly declaredMessageBytes: number;
}

/**
 * Open one execution on the resident supervisor and return the grant
 * carried by the answering `run-command` frame.
 */
export async function openExecution(
	handle: SupervisorHandle,
	request: OpenExecutionRequest,
	deadlineMs: number = 5_000,
): Promise<
	| { readonly ok: true; readonly grant: MeasurementGrantV1 }
	| ControlChannelRefusal
> {
	const writable = handle.controllerToSupervisor;
	const readable = handle.supervisorToController;
	if (writable === undefined || readable === undefined) {
		return {
			ok: false,
			code: "CONTROL_CHANNEL_MISSING",
			message: "supervisor handle has no control pipes",
		};
	}
	const payload = canonicalRecordBytes({
		runId: request.runId,
		transport: request.transport,
		declaredMessageCount: request.declaredMessageCount,
		declaredMessageBytes: request.declaredMessageBytes,
	});
	const written = await writeControlFrame(
		writable,
		OPEN_EXECUTION_KIND,
		payload,
		SUPERVISOR_RUN_COMMAND_MAX_BYTES,
	);
	if (!written.ok) return written;

	const framed = await readControlFrame(
		readable,
		SUPERVISOR_RUN_COMMAND_MAX_BYTES,
		deadlineMs,
	);
	if (!framed.ok) return framed;
	if (framed.kind !== RUN_COMMAND_KIND) {
		return {
			ok: false,
			code: "CONTROL_FRAME_UNEXPECTED_KIND",
			message: `expected run-command, got ${framed.kind}`,
		};
	}
	const decoded = decodeSupervisorFrame(
		framed.frameBytes,
		SUPERVISOR_RUN_COMMAND_MAX_BYTES,
	);
	if (!decoded.ok) {
		return {
			ok: false,
			code: "CONTROL_FRAME_DECODE_FAILED",
			message: `run-command payload decode failed: ${decoded.code}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(decoded.value.frame.payload));
	} catch {
		return {
			ok: false,
			code: "CONTROL_GRANT_MALFORMED",
			message: "run-command payload is not JSON",
		};
	}
	const grant = parseMeasurementGrant(parsed);
	if (!grant.ok) {
		return {
			ok: false,
			code: "CONTROL_GRANT_MALFORMED",
			message: `run-command grant refused: ${grant.code}`,
		};
	}
	return { ok: true, grant: grant.grant };
}

/**
 * Present one measured series under the open grant and return the raw
 * framed `admission-receipt` bytes (what `assertSupervisorAdmitted` needs).
 */
export async function presentArtifactPayload(
	handle: SupervisorHandle,
	series: MeasurementSeries,
	grant: MeasurementGrantV1,
	deadlineMs: number = 10_000,
): Promise<
	| { readonly ok: true; readonly admissionFrame: Uint8Array }
	| ControlChannelRefusal
> {
	const writable = handle.controllerToSupervisor;
	const readable = handle.supervisorToController;
	if (writable === undefined || readable === undefined) {
		return {
			ok: false,
			code: "CONTROL_CHANNEL_MISSING",
			message: "supervisor handle has no control pipes",
		};
	}
	const payload = measurementPayloadBytes(series, grant);
	const written = await writeControlFrame(
		writable,
		ARTIFACT_PAYLOAD_KIND,
		payload,
		SUPERVISOR_ARTIFACT_PAYLOAD_MAX_BYTES,
	);
	if (!written.ok) return written;

	const framed = await readControlFrame(
		readable,
		SUPERVISOR_RUN_COMMAND_MAX_BYTES,
		deadlineMs,
	);
	if (!framed.ok) return framed;
	if (framed.kind === ADMISSION_REFUSAL_KIND) {
		const decoded = decodeSupervisorFrame(
			framed.frameBytes,
			SUPERVISOR_RUN_COMMAND_MAX_BYTES,
		);
		const detail = decoded.ok
			? new TextDecoder().decode(decoded.value.frame.payload).trim()
			: "(undecodable refusal)";
		return {
			ok: false,
			code: "CONTROL_ADMISSION_REFUSED",
			message: `supervisor refused admission: ${detail}`,
		};
	}
	if (framed.kind !== ADMISSION_RECEIPT_KIND) {
		return {
			ok: false,
			code: "CONTROL_FRAME_UNEXPECTED_KIND",
			message: `expected admission-receipt, got ${framed.kind}`,
		};
	}
	return { ok: true, admissionFrame: framed.frameBytes };
}

// ---------------------------------------------------------------------------
// A2 durable replay ledger helpers (protocol support; unused by seal path)
// ---------------------------------------------------------------------------

/**
 * Filesystem O_CREAT|O_EXCL replay ledger. A3 attaches this to Mac/rig
 * admission so signed grant/acceptance/snapshot receipts are one-shot
 * across supervisor restarts.
 */
export function createDurableFilesystemReplayLedger(
	replayRoot: string,
): ReplayLedger {
	mkdirSync(join(replayRoot, "mac-records"), { recursive: true });
	mkdirSync(join(replayRoot, "rig-records"), { recursive: true });
	return {
		tryAppend(args) {
			const sideDir = join(
				replayRoot,
				args.side === "mac-records" ? "mac-records" : "rig-records",
				args.signedSchema.replaceAll("/", "_"),
			);
			mkdirSync(sideDir, { recursive: true });
			const leafPath = join(sideDir, args.signedBytesSha256);
			try {
				const fd = openSync(leafPath, "wx");
				try {
					writeSync(fd, `${args.signedBytesSha256}\n`);
				} finally {
					closeSync(fd);
				}
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error
						? String((error as { code: unknown }).code)
						: "";
				if (code === "EEXIST" || existsSync(leafPath)) {
					return {
						ok: false,
						code:
							args.side === "mac-records"
								? "MAC_GRANT_REPLAYED"
								: "RIG_RECEIPT_REPLAYED",
					};
				}
				return { ok: false, code: "TRUST_PROTOCOL", message: String(error) };
			}
			const leafSha256 = createHash("sha256")
				.update(`${args.side}/${args.signedSchema}/${args.signedBytesSha256}\n`)
				.digest("hex");
			return { ok: true, value: { leafSha256 } };
		},
		snapshot() {
			return replayRoot;
		},
	};
}

// ---------------------------------------------------------------------------
// B3: the Mac-owned fanout cohort supervisor
//
// Plan sections 4.3 and 4.4. Everything below is reachable only from the B3
// integration entrypoint; `compare-controller.ts` fanout selection and artifact
// promotion are untouched until B4.
//
// The single idea this section exists to enforce is that the controller is a
// courier. It carries bytes between the Mac supervisor and the rig, and it can
// carry them wrongly -- drop one, swap one for a genuine record from another
// cohort, rewrite a count inside one, or mint one of its own. None of those
// reach a number in the artifact, because every record the supervisor accepts
// is re-parsed, re-hashed from the bytes it was handed, signature-checked
// against a staged key, joined to what the supervisor already retains, and
// admitted through a replay ledger exactly once. What the supervisor exports is
// assembled only from those retained bytes; there is no argument through which
// a caller can state a value the supervisor did not observe.
//
// The other idea is ownership. The Mac supervisor plans the exact topology,
// seals each child's tokens into an unlinked read-only FD, paces every
// connection through one global-ordinal permit scheduler, and reaps every
// process group on every terminal path -- including the groups of a cohort it
// replaced before readiness.
// ---------------------------------------------------------------------------

/** Role children read control frames on FD 3 and write them on FD 4. */
export const MAC_FANOUT_CONTROL_READ_FD = 3;
export const MAC_FANOUT_CONTROL_WRITE_FD = 4;

/** The frozen per-scenario publisher cardinality; workers are always eight. */
export const MAC_FANOUT_PUBLISHER_COUNT = {
	chat: 10,
	ticker: 1,
} as const;

export type MacFanoutScenario = keyof typeof MAC_FANOUT_PUBLISHER_COUNT;

/** Signal order for a bounded reap: term, wait, kill, wait. */
export type MacFanoutSignal = "SIGTERM" | "SIGKILL";

/** Every path out of an execution reaps; none of them is allowed to skip one. */
export type MacFanoutTerminalPath =
	| "PASS"
	| "FAIL"
	| "REFUSED"
	| "SIGINT"
	| "SIGTERM";

export const MAC_FANOUT_TERMINAL_PATHS: readonly MacFanoutTerminalPath[] = [
	"PASS",
	"FAIL",
	"REFUSED",
	"SIGINT",
	"SIGTERM",
];

/** Plan section 4.3: SIGKILL + waitpid is bounded at five seconds. */
export const MAC_FANOUT_REAP_DEADLINE_MS = 5_000;

function macFail(
	code: string,
	message: string,
): {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
} {
	return { ok: false, code, message };
}

function notReadyFail(message: string) {
	return macFail(COHORT_NOT_READY_FAILURE_CODE, message);
}

function protocolFail(message: string) {
	return macFail(COHORT_PROTOCOL_FAILURE_CODE, message);
}

/** Retain exact bytes, not a digest of them, so a verifier can recompute. */
function retainBytes(bytes: Uint8Array): RetainedCanonicalBytesV1 {
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: Buffer.from(bytes).toString("base64"),
		byteLength: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
	};
}

// -- topology ---------------------------------------------------------------

/**
 * One supervisor-owned child: which role it plays, which global ordinals it
 * owns, and the only three descriptors it is given. A publisher child owns
 * exactly one publisher ordinal; worker `w` owns every subscriber ordinal
 * congruent to `w` mod 8.
 */
export interface MacFanoutChildPlanV1 {
	readonly childId: string;
	readonly role: "publisher" | "subscriber-worker";
	readonly publisherId: string | null;
	readonly workerIndex: number | null;
	readonly assignedGlobalOrdinals: readonly number[];
	readonly assignedRoleIds: readonly string[];
	readonly controlReadFd: 3;
	readonly controlWriteFd: 4;
	readonly tokenBundleFd: 5;
}

export interface MacFanoutTopologyV1 {
	readonly scenario: MacFanoutScenario;
	readonly publisherCount: number;
	readonly workerCount: 8;
	readonly subscriberCount: number;
	readonly expectedProcessCount: number;
	readonly expectedSessionCount: number;
	readonly children: readonly MacFanoutChildPlanV1[];
}

/**
 * Chat is ten dedicated publisher processes plus eight subscriber workers;
 * ticker is one plus eight. The ordinal domain is enumerated once, from
 * `cohort-protocol.ts`, so the assignment here and the permit scheduler below
 * cannot drift into two different ideas of who owns ordinal `o`.
 */
export function planMacFanoutTopology(args: {
	readonly scenario: MacFanoutScenario;
	readonly subscriberCount: number;
}): ProtocolResult<MacFanoutTopologyV1> {
	const publisherCount = MAC_FANOUT_PUBLISHER_COUNT[args.scenario];
	if (publisherCount === undefined) {
		return protocolFail(`unknown fanout scenario ${String(args.scenario)}`);
	}
	if (
		!Number.isSafeInteger(args.subscriberCount) ||
		args.subscriberCount < COHORT_WORKER_COUNT
	) {
		return protocolFail(
			`subscriberCount must be at least ${COHORT_WORKER_COUNT} so every worker owns a shard`,
		);
	}
	const ordinals = enumerateGlobalOrdinals({
		publisherCount,
		subscriberCount: args.subscriberCount,
	});
	if (!ordinals.ok) return ordinals;

	const publisherOrdinals = new Map<string, number>();
	const workerOrdinals = new Map<number, number[]>();
	const workerRoleIds = new Map<number, string[]>();
	for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
		workerOrdinals.set(worker, []);
		workerRoleIds.set(worker, []);
	}
	for (const assignment of ordinals.value) {
		if (assignment.role === "publisher") {
			publisherOrdinals.set(assignment.roleId, assignment.globalOrdinal);
			continue;
		}
		const worker = assignment.workerIndex as number;
		(workerOrdinals.get(worker) as number[]).push(assignment.globalOrdinal);
		(workerRoleIds.get(worker) as string[]).push(assignment.roleId);
	}
	if (publisherOrdinals.size !== publisherCount) {
		return protocolFail("publisher ordinals did not tile the publisher run");
	}

	const children: MacFanoutChildPlanV1[] = [];
	for (let index = 0; index < publisherCount; index += 1) {
		const publisherId = `publisher-${index.toString().padStart(6, "0")}`;
		const ordinal = publisherOrdinals.get(publisherId);
		if (ordinal === undefined) {
			return protocolFail(`no global ordinal owns ${publisherId}`);
		}
		children.push({
			childId: `publisher-child-${index}`,
			role: "publisher",
			publisherId,
			workerIndex: null,
			assignedGlobalOrdinals: [ordinal],
			assignedRoleIds: [publisherId],
			controlReadFd: MAC_FANOUT_CONTROL_READ_FD,
			controlWriteFd: MAC_FANOUT_CONTROL_WRITE_FD,
			tokenBundleFd: TOKEN_BUNDLE_FD,
		});
	}
	for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
		const assigned = workerOrdinals.get(worker) as number[];
		if (assigned.length === 0) {
			return protocolFail(`worker ${worker} owns no subscriber`);
		}
		children.push({
			childId: `subscriber-worker-${worker}`,
			role: "subscriber-worker",
			publisherId: null,
			workerIndex: worker,
			assignedGlobalOrdinals: assigned,
			assignedRoleIds: workerRoleIds.get(worker) as string[],
			controlReadFd: MAC_FANOUT_CONTROL_READ_FD,
			controlWriteFd: MAC_FANOUT_CONTROL_WRITE_FD,
			tokenBundleFd: TOKEN_BUNDLE_FD,
		});
	}
	return {
		ok: true,
		value: {
			scenario: args.scenario,
			publisherCount,
			workerCount: COHORT_WORKER_COUNT,
			subscriberCount: args.subscriberCount,
			expectedProcessCount: publisherCount + COHORT_WORKER_COUNT,
			expectedSessionCount: publisherCount + args.subscriberCount,
			children,
		},
	};
}

// -- sealed token FD 5 ------------------------------------------------------

/**
 * `O_CLOEXEC` is absent from Bun's `node:fs` constants, so the two platforms
 * this rig runs on carry their own value. Refusing on anything else is
 * deliberate: silently dropping the flag would leave the sealed descriptor
 * inheritable by every later spawn, which is the exact leak the seal exists to
 * prevent. Only the copy deliberately mapped onto child FD 5 may cross an exec.
 */
const O_CLOEXEC_BY_PLATFORM: Readonly<Record<string, number>> = {
	darwin: 0x0100_0000,
	linux: 0o2000000,
};

function tokenBundleCloexecFlag(): ProtocolResult<number> {
	const flag = O_CLOEXEC_BY_PLATFORM[process.platform];
	if (flag === undefined) {
		return protocolFail(
			`no O_CLOEXEC value is known for platform ${process.platform}`,
		);
	}
	return { ok: true, value: flag };
}

export interface SealedTokenBundleFdV1 {
	readonly childId: string;
	/** The read-only descriptor duplicated onto child FD 5. */
	readonly readFd: number;
	readonly byteSize: number;
	readonly sha256: Sha256Hex;
	readonly entryCount: number;
	readonly observation: TokenBundleFdObservationV1;
	readonly close: () => void;
}

/**
 * Plan section 4.3, executed rather than described: create the file
 * `O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC 0600` under the supervisor's private
 * runtime directory, write exactly one canonical bundle after the cap check,
 * fsync, close the write end, reopen `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, verify
 * device/inode/size/digest, then unlink the pathname so the descriptor is the
 * only way to the bytes. The child is handed the FD and never the path.
 *
 * The supervisor retains digest, size and entry count -- never the tokens.
 */
export function sealTokenBundleFd(args: {
	readonly runtimeDir: string;
	readonly bundle: TokenBundleV1;
}): ProtocolResult<SealedTokenBundleFdV1> {
	const parsed = parseTokenBundle(args.bundle);
	if (!parsed.ok) return parsed;
	const bytes = canonicalRecordBytes(parsed.value);
	const capped = validateTokenBundleBytes(bytes);
	if (!capped.ok) return capped;
	const expectedSha256 = sha256HexOfBytes(bytes);
	const cloexec = tokenBundleCloexecFlag();
	if (!cloexec.ok) return cloexec;

	mkdirSync(args.runtimeDir, { recursive: true, mode: 0o700 });
	const path = join(
		args.runtimeDir,
		`token-bundle-${parsed.value.childId}-${expectedSha256.slice(0, 16)}.json`,
	);
	const writeFlags =
		fsConstants.O_CREAT |
		fsConstants.O_EXCL |
		fsConstants.O_WRONLY |
		fsConstants.O_NOFOLLOW |
		cloexec.value;
	let writeFd: number;
	try {
		writeFd = openSync(path, writeFlags, TOKEN_BUNDLE_FILE_MODE);
	} catch (error: unknown) {
		return protocolFail(`token bundle create: ${String(error)}`);
	}
	try {
		let written = 0;
		while (written < bytes.byteLength) {
			written += writeSync(writeFd, bytes, written, bytes.byteLength - written);
		}
		fsyncSync(writeFd);
	} catch (error: unknown) {
		closeSync(writeFd);
		try {
			unlinkSync(path);
		} catch {
			/* the create already failed; nothing else holds the name */
		}
		return protocolFail(`token bundle write: ${String(error)}`);
	}
	closeSync(writeFd);

	const readFlags =
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | cloexec.value;
	let readFd: number;
	try {
		readFd = openSync(path, readFlags);
	} catch (error: unknown) {
		try {
			unlinkSync(path);
		} catch {
			/* best effort */
		}
		return protocolFail(`token bundle reopen: ${String(error)}`);
	}

	const fail = (message: string) => {
		closeSync(readFd);
		try {
			unlinkSync(path);
		} catch {
			/* already unlinked */
		}
		return protocolFail(message);
	};

	const beforeUnlink = fstatSync(readFd);
	if (!beforeUnlink.isFile()) return fail("sealed token bundle is not a file");
	if (beforeUnlink.size !== bytes.byteLength) {
		return fail(
			`sealed token bundle is ${beforeUnlink.size} bytes, wrote ${bytes.byteLength}`,
		);
	}
	const readBack = new Uint8Array(beforeUnlink.size);
	let read = 0;
	while (read < readBack.byteLength) {
		const chunk = readSync(
			readFd,
			readBack,
			read,
			readBack.byteLength - read,
			read,
		);
		if (chunk === 0) break;
		read += chunk;
	}
	if (read !== bytes.byteLength) {
		return fail(`sealed token bundle short read: ${read}/${bytes.byteLength}`);
	}
	if (sha256HexOfBytes(readBack) !== expectedSha256) {
		return fail("sealed token bundle digest is not the committed digest");
	}

	// From here the pathname is gone: only this descriptor reaches the bytes.
	try {
		unlinkSync(path);
	} catch (error: unknown) {
		closeSync(readFd);
		return protocolFail(`token bundle unlink: ${String(error)}`);
	}
	const afterUnlink = fstatSync(readFd);
	if (afterUnlink.nlink !== 0) {
		closeSync(readFd);
		return protocolFail(
			`token bundle still has ${afterUnlink.nlink} link(s) after unlink`,
		);
	}

	const observation: TokenBundleFdObservationV1 = {
		schema: "token-bundle-fd-observation/v1",
		fd: TOKEN_BUNDLE_FD,
		fileKind: "regular",
		accessMode: "read-only",
		appendMode: false,
		hardLinkCount: afterUnlink.nlink,
		deviceId: afterUnlink.dev.toString(),
		inode: afterUnlink.ino.toString(),
		byteSize: bytes.byteLength,
		contentSha256: expectedSha256,
	};
	const validated = parseTokenBundleFdObservation(observation);
	if (!validated.ok) {
		closeSync(readFd);
		return validated;
	}
	return {
		ok: true,
		value: {
			childId: parsed.value.childId,
			readFd,
			byteSize: bytes.byteLength,
			sha256: expectedSha256,
			entryCount: parsed.value.entryCount,
			observation,
			close: () => {
				try {
					closeSync(readFd);
				} catch {
					/* already closed */
				}
			},
		},
	};
}

// -- one global permit scheduler -------------------------------------------

interface HeapEntry {
	readonly globalOrdinal: number;
	readonly request: ConnectPermitRequestV1;
}

/** Smallest-ordinal-first, so a late request cannot jump the ramp. */
class OrdinalMinHeap {
	private readonly items: HeapEntry[] = [];

	get size(): number {
		return this.items.length;
	}

	peek(): HeapEntry | undefined {
		return this.items[0];
	}

	push(entry: HeapEntry): void {
		this.items.push(entry);
		let index = this.items.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (
				(this.items[parent] as HeapEntry).globalOrdinal <=
				(this.items[index] as HeapEntry).globalOrdinal
			) {
				break;
			}
			const swap = this.items[parent] as HeapEntry;
			this.items[parent] = this.items[index] as HeapEntry;
			this.items[index] = swap;
			index = parent;
		}
	}

	pop(): HeapEntry | undefined {
		const top = this.items[0];
		if (top === undefined) return undefined;
		const last = this.items.pop() as HeapEntry;
		if (this.items.length > 0) {
			this.items[0] = last;
			let index = 0;
			for (;;) {
				const left = index * 2 + 1;
				const right = left + 1;
				let smallest = index;
				if (
					left < this.items.length &&
					(this.items[left] as HeapEntry).globalOrdinal <
						(this.items[smallest] as HeapEntry).globalOrdinal
				) {
					smallest = left;
				}
				if (
					right < this.items.length &&
					(this.items[right] as HeapEntry).globalOrdinal <
						(this.items[smallest] as HeapEntry).globalOrdinal
				) {
					smallest = right;
				}
				if (smallest === index) break;
				const swap = this.items[smallest] as HeapEntry;
				this.items[smallest] = this.items[index] as HeapEntry;
				this.items[index] = swap;
				index = smallest;
			}
		}
		return top;
	}
}

export interface MacPermitSchedulerConfig {
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly rampEpochMacNs: NsString;
	readonly readinessDeadlineMs: number;
	/** The deterministic owner child of each ordinal, from the topology. */
	readonly childIdForOrdinal: (globalOrdinal: number) => string | undefined;
}

/**
 * Plan section 4.3: one `nextOrdinal`, one total in-flight map, one heap across
 * every publisher and subscriber request. There is deliberately no per-role
 * counter here -- a per-role counter that looked like global accounting is one
 * of the failures this class exists to make unrepresentable.
 *
 * The scheduler validates each grant it is about to issue against the pure
 * `cohort-protocol.ts` permit math before handing it out, so the ramp equation
 * has exactly one implementation and this class either agrees with it or
 * refuses.
 */
export class MacPermitScheduler {
	readonly config: MacPermitSchedulerConfig;

	private readonly heap = new OrdinalMinHeap();
	private readonly requested = new Set<number>();
	private readonly grants = new Map<number, ConnectPermitGrantV1>();
	private readonly completed = new Set<number>();
	private inFlightValue = 0;
	private inFlightPeakValue = 0;
	private sequenceValue = 0;

	constructor(config: MacPermitSchedulerConfig) {
		this.config = config;
	}

	get inFlight(): number {
		return this.inFlightValue;
	}

	get inFlightPeak(): number {
		return this.inFlightPeakValue;
	}

	get pendingCount(): number {
		return this.heap.size;
	}

	get grantedCount(): number {
		return this.grants.size;
	}

	get completedCount(): number {
		return this.completed.size;
	}

	/** Queue one child's connect request. Duplicates and strangers are refused. */
	request(value: unknown): ProtocolResult<true> {
		const request = parseConnectPermitRequest(value);
		if (!request.ok) return request;
		if (
			request.value.executionSha256 !== this.config.executionSha256 ||
			request.value.cohortGrantSha256 !== this.config.cohortGrantSha256
		) {
			return notReadyFail("permit request is bound to another cohort");
		}
		const owner = resolveGlobalOrdinal({
			globalOrdinal: request.value.globalOrdinal,
			publisherCount: this.config.publisherCount,
			subscriberCount: this.config.subscriberCount,
		});
		if (!owner.ok) return owner;
		if (owner.value.roleId !== request.value.roleId) {
			return notReadyFail(
				`ordinal ${request.value.globalOrdinal} belongs to ${owner.value.roleId}, not ${request.value.roleId}`,
			);
		}
		const ownerChild = this.config.childIdForOrdinal(
			request.value.globalOrdinal,
		);
		if (ownerChild === undefined || ownerChild !== request.value.childId) {
			return notReadyFail(
				`ordinal ${request.value.globalOrdinal} is not owned by ${request.value.childId}`,
			);
		}
		if (this.requested.has(request.value.globalOrdinal)) {
			return notReadyFail(
				`ordinal ${request.value.globalOrdinal} was already requested`,
			);
		}
		this.requested.add(request.value.globalOrdinal);
		this.heap.push({
			globalOrdinal: request.value.globalOrdinal,
			request: request.value,
		});
		return { ok: true, value: true };
	}

	/**
	 * Issue every permit that is due at `nowMacNs` and fits under the total
	 * in-flight cap, smallest ordinal first. Nothing is issued early and nothing
	 * is issued at the cap; both are simply not yet due.
	 */
	issueReady(
		nowMacNs: NsString,
	): ProtocolResult<readonly ConnectPermitGrantV1[]> {
		const issued: ConnectPermitGrantV1[] = [];
		for (;;) {
			const top = this.heap.peek();
			if (top === undefined) break;
			if (this.inFlightValue >= COHORT_MAX_CONNECTIONS_IN_FLIGHT) break;
			const notBefore = permitNotBeforeMacNs({
				rampEpochMacNs: this.config.rampEpochMacNs,
				globalOrdinal: top.globalOrdinal,
			});
			if (!notBefore.ok) return notBefore;
			if (BigInt(nowMacNs) < BigInt(notBefore.value)) break;

			this.sequenceValue += 1;
			const grant: ConnectPermitGrantV1 = {
				schema: "connect-permit-grant/v1",
				sequence: this.sequenceValue,
				executionSha256: this.config.executionSha256,
				cohortGrantSha256: this.config.cohortGrantSha256,
				childId: top.request.childId,
				globalOrdinal: top.globalOrdinal,
				notBeforeMacNs: notBefore.value,
				permitNonce: sha256CanonicalRecord({
					cohortGrantSha256: this.config.cohortGrantSha256,
					globalOrdinal: top.globalOrdinal,
					sequence: this.sequenceValue,
				}),
			};
			// The scheduler must agree with the frozen permit math, not merely
			// resemble it: a grant it cannot itself validate is a defect, not a
			// refusal to hand to a child.
			const checked = validateConnectPermitGrant({
				request: top.request,
				grant,
				rampEpochMacNs: this.config.rampEpochMacNs,
				publisherCount: this.config.publisherCount,
				subscriberCount: this.config.subscriberCount,
				inFlightBefore: this.inFlightValue,
			});
			if (!checked.ok) return checked;
			this.heap.pop();
			this.grants.set(top.globalOrdinal, grant);
			this.inFlightValue += 1;
			if (this.inFlightValue > this.inFlightPeakValue) {
				this.inFlightPeakValue = this.inFlightValue;
			}
			issued.push(grant);
		}
		return { ok: true, value: issued };
	}

	/** Completion spends the permit; a replay or a stranger spends nothing. */
	complete(value: unknown): ProtocolResult<true> {
		const complete = parseConnectPermitComplete(value);
		if (!complete.ok) return complete;
		const grant = this.grants.get(complete.value.globalOrdinal);
		if (grant === undefined) {
			return notReadyFail(
				`ordinal ${complete.value.globalOrdinal} has no outstanding permit`,
			);
		}
		if (this.completed.has(complete.value.globalOrdinal)) {
			return notReadyFail(
				`ordinal ${complete.value.globalOrdinal} was already completed`,
			);
		}
		const checked = validateConnectPermitCompletion({
			complete: complete.value,
			grant,
			readinessDeadlineMs: this.config.readinessDeadlineMs,
			rampEpochMacNs: this.config.rampEpochMacNs,
		});
		if (!checked.ok) return checked;
		this.completed.add(complete.value.globalOrdinal);
		this.inFlightValue -= 1;
		return { ok: true, value: true };
	}
}

// -- supervisor-owned children ----------------------------------------------

/**
 * The non-secret half of a cohort's token material. `FanoutCohortFixture` is
 * structurally assignable to this, so the token builder stays in one place and
 * this module never learns how a Merkle tree is shaped.
 */
export interface MacCohortTokenMaterial {
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly roleTokenCommitmentCount: number;
	readonly tokenSha256ByRoleId: ReadonlyMap<string, Sha256Hex>;
	readonly workerIndexByRoleId: ReadonlyMap<string, number | null>;
}

export interface MacMintedCohortV1 {
	readonly tokens: MacCohortTokenMaterial;
	readonly grant: CohortGrantV1;
}

/**
 * Mint one attempt's cohort: fresh tokens and a grant carrying the attempt and
 * nonce the supervisor chose. The supervisor -- not the caller -- owns the
 * attempt counter and the nonce, and it checks that what comes back carries
 * them.
 */
export type MacCohortMinter = (args: {
	readonly cohortAttempt: number;
	readonly grantNonceSha256: Sha256Hex;
}) => MacMintedCohortV1;

export interface MacFanoutSpawnRequestV1 {
	readonly plan: MacFanoutChildPlanV1;
	/** The parent-side read descriptor to duplicate onto child FD 5. */
	readonly tokenBundleReadFd: number;
	readonly tokenBundleSha256: Sha256Hex;
	readonly tokenBundleSize: number;
	readonly tokenBundleEntryCount: number;
	readonly childInstanceNonce: Sha256Hex;
	/** Exactly control-in, control-out, token bundle. Nothing else inherits. */
	readonly inheritedChildFds: readonly [3, 4, 5];
}

export interface MacFanoutSpawnedProcessV1 {
	readonly pid: number;
	readonly pgid: number;
}

export type MacFanoutChildSpawner = (
	request: MacFanoutSpawnRequestV1,
) => ProtocolResult<MacFanoutSpawnedProcessV1>;

/** Kill and wait on a whole process group, with the caller's deadline. */
export interface MacFanoutProcessControl {
	readonly killPgid: (pgid: number, signal: MacFanoutSignal) => void;
	readonly waitPgid: (pgid: number, deadlineMs: number) => boolean;
}

export interface MacFanoutChildStateV1 {
	readonly plan: MacFanoutChildPlanV1;
	readonly pid: number;
	readonly pgid: number;
	readonly instanceNonce: Sha256Hex;
	readonly tokenBundleSha256: Sha256Hex;
	readonly tokenBundleSize: number;
	readonly tokenBundleEntryCount: number;
	readonly spawnedAtMacNs: NsString;
	readyAtMacNs: NsString | null;
	warmupCompleteAtMacNs: NsString | null;
	measureArmedAtMacNs: NsString | null;
	stoppedAtMacNs: NsString | null;
	partialSha256: Sha256Hex | null;
	exitCode: number | null;
}

export interface MacFanoutReapRecordV1 {
	readonly childId: string;
	readonly pid: number;
	readonly pgid: number;
	readonly cohortAttempt: number;
	readonly signalsSent: readonly MacFanoutSignal[];
	readonly reaped: true;
}

export interface MacFanoutTeardownResultV1 {
	readonly terminalPath: MacFanoutTerminalPath;
	readonly records: readonly MacFanoutReapRecordV1[];
	readonly reapedPgids: readonly number[];
	readonly allReaped: true;
}

/** Digests the Phase-A execution path already fixed; not restatable later. */
export interface MacFanoutExecutionJoinsV1 {
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
	readonly macMeasurementAdmissionReceiptSha256: Sha256Hex;
	readonly macMeasurementAdmissionSignatureSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
}

export interface MacFanoutSupervisorConfig {
	readonly scenario: MacFanoutScenario;
	readonly subscriberCount: number;
	readonly executionSha256: Sha256Hex;
	readonly macKeys: Ed25519KeyPairBytes;
	readonly stagedRigPublicRaw32: Uint8Array;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly macClockId: string;
	readonly runtimeDir: string;
	readonly mintCohort: MacCohortMinter;
	readonly spawnChild: MacFanoutChildSpawner;
	readonly processControl: MacFanoutProcessControl;
	readonly ledger: ReplayLedger;
	readonly stagedCapabilityNotAfterMs: number;
	readonly executionJoins: MacFanoutExecutionJoinsV1;
	/** Staged binary digests recorded in every observed-child record. */
	readonly bunSha256: Sha256Hex;
	readonly entrypointSha256: Sha256Hex;
	readonly receiptValidityMs: number;
}

/** What the supervisor keeps of one presented or minted record. */
interface RetainedRecord {
	readonly retained: RetainedCanonicalBytesV1;
	readonly bytes: Uint8Array;
}

/** Plan section 4.3: at most one pre-readiness replacement; a second is fatal. */
export const MAC_FANOUT_MAX_PRE_READY_REPLACEMENTS = 1;

/**
 * The Mac side of one fanout cohort.
 *
 * Read the presentation methods together: each one parses the record, verifies
 * the rig signature over the exact canonical bytes it was handed, checks that
 * the record names this execution and this cohort grant, checks that whatever
 * the record claims to cover really is the bytes already retained here, and
 * admits it through the replay ledger once. Those five checks are what make a
 * courier a courier.
 */
export class MacFanoutSupervisor {
	readonly config: MacFanoutSupervisorConfig;
	readonly topology: MacFanoutTopologyV1;

	private attempt = 0;
	private grantNonce: Sha256Hex | null = null;
	private tokensValue: MacCohortTokenMaterial | null = null;
	private grantValue: CohortGrantV1 | null = null;
	private grantSha256Value: Sha256Hex | null = null;
	private schedulerValue: MacPermitScheduler | null = null;
	private replacements = 0;

	private readonly children = new Map<string, MacFanoutChildStateV1>();
	private readonly sealedFds: SealedTokenBundleFdV1[] = [];
	private readonly retiredGroups: {
		readonly childId: string;
		readonly pid: number;
		readonly pgid: number;
		readonly cohortAttempt: number;
	}[] = [];

	private readonly retained = new Map<string, RetainedRecord>();
	private readonly warmupCompletes = new Map<string, RetainedRecord>();
	private readonly publisherPartials = new Map<string, RetainedRecord>();
	private readonly workerPartials = new Map<number, RetainedRecord>();
	private readonly publisherPartialRecords = new Map<
		string,
		PublisherPartialV1
	>();
	private readonly workerPartialRecords = new Map<number, WorkerPartialV1>();
	private linuxObservation: LinuxRelayObservationV1 | null = null;
	private barrierRecord: CohortStartBarrierV1 | null = null;

	private receiptSequence = 0;
	private exported = false;
	private teardownResult: MacFanoutTeardownResultV1 | null = null;

	constructor(config: MacFanoutSupervisorConfig) {
		const topology = planMacFanoutTopology({
			scenario: config.scenario,
			subscriberCount: config.subscriberCount,
		});
		if (!topology.ok) {
			throw new Error(`fanout topology: ${topology.code}: ${topology.message}`);
		}
		this.config = config;
		this.topology = topology.value;
	}

	get cohortAttempt(): number {
		return this.attempt;
	}

	get grantNonceSha256(): Sha256Hex | null {
		return this.grantNonce;
	}

	get grant(): CohortGrantV1 | null {
		return this.grantValue;
	}

	get cohortGrantSha256(): Sha256Hex | null {
		return this.grantSha256Value;
	}

	get tokens(): MacCohortTokenMaterial | null {
		return this.tokensValue;
	}

	get scheduler(): MacPermitScheduler | null {
		return this.schedulerValue;
	}

	get replacementCount(): number {
		return this.replacements;
	}

	get spawnedChildren(): readonly MacFanoutChildStateV1[] {
		return [...this.children.values()];
	}

	get allChildrenReady(): boolean {
		return (
			this.children.size === this.topology.expectedProcessCount &&
			[...this.children.values()].every((child) => child.readyAtMacNs !== null)
		);
	}

	get anyChildReady(): boolean {
		return [...this.children.values()].some(
			(child) => child.readyAtMacNs !== null,
		);
	}

	private nextReceiptSequence(): number {
		this.receiptSequence += 1;
		return this.receiptSequence;
	}

	private macSign(
		signedSchema: MacReceiptSignatureV1["signedSchema"],
		signedBytes: Uint8Array,
	): MacReceiptSignatureV1 {
		return signMacReceipt({
			privatePkcs8Der: this.config.macKeys.privatePkcs8Der,
			publicRaw32: this.config.macKeys.publicRaw32,
			signedSchema,
			signedBytes,
		});
	}

	private retain(key: string, bytes: Uint8Array): RetainedRecord {
		const record = { retained: retainBytes(bytes), bytes };
		this.retained.set(key, record);
		return record;
	}

	private required(key: string): RetainedRecord | null {
		return this.retained.get(key) ?? null;
	}

	// -- 1. cohort grant, minted here and nowhere else -----------------------

	/**
	 * Mint attempt 1. The nonce is derived from the execution and the attempt,
	 * so a replacement cannot land on the nonce it just abandoned.
	 */
	openCohort(): ProtocolResult<{
		readonly grant: CohortGrantV1;
		readonly grantBytes: Uint8Array;
		readonly grantSha256: Sha256Hex;
		readonly grantSignature: MacReceiptSignatureV1;
		readonly cohortAttempt: number;
	}> {
		if (this.attempt !== 0) {
			return protocolFail("cohort was already opened");
		}
		return this.mintAttempt(1);
	}

	private mintAttempt(attempt: number): ProtocolResult<{
		readonly grant: CohortGrantV1;
		readonly grantBytes: Uint8Array;
		readonly grantSha256: Sha256Hex;
		readonly grantSignature: MacReceiptSignatureV1;
		readonly cohortAttempt: number;
	}> {
		const previousRoot =
			this.tokensValue?.roleTokenCommitmentRootSha256 ?? null;
		const grantNonceSha256 = sha256CanonicalRecord({
			executionSha256: this.config.executionSha256,
			macSupervisorInstanceNonce: this.config.macSupervisorInstanceNonce,
			cohortAttempt: attempt,
		});
		if (grantNonceSha256 === this.grantNonce) {
			return protocolFail("a replacement attempt reused the abandoned nonce");
		}
		const minted = this.config.mintCohort({
			cohortAttempt: attempt,
			grantNonceSha256,
		});
		const grant = parseCohortGrant(minted.grant);
		if (!grant.ok) return grant;
		if (grant.value.executionSha256 !== this.config.executionSha256) {
			return protocolFail("minted grant names another execution");
		}
		if (grant.value.cohortAttempt !== attempt) {
			return protocolFail(
				`minted grant carries attempt ${grant.value.cohortAttempt}, expected ${attempt}`,
			);
		}
		if (grant.value.publisherCount !== this.topology.publisherCount) {
			return protocolFail("minted grant publisher count is not the topology");
		}
		if (grant.value.subscriberCount !== this.topology.subscriberCount) {
			return protocolFail("minted grant subscriber count is not the topology");
		}
		if (
			grant.value.expectedProcessCount !== this.topology.expectedProcessCount
		) {
			return protocolFail("minted grant process count is not the topology");
		}
		if (
			grant.value.expectedSessionCount !== this.topology.expectedSessionCount
		) {
			return protocolFail("minted grant session count is not the topology");
		}
		if (
			grant.value.roleTokenCommitmentRootSha256 !==
			minted.tokens.roleTokenCommitmentRootSha256
		) {
			return protocolFail("minted grant does not carry the minted token root");
		}
		if (
			previousRoot !== null &&
			minted.tokens.roleTokenCommitmentRootSha256 === previousRoot
		) {
			return protocolFail(
				"a replacement attempt reused the abandoned token commitment root",
			);
		}

		const grantBytes = bytesOfCanonical(grant.value);
		const grantSha256 = sha256HexOfBytes(grantBytes);
		const grantSignature = this.macSign("cohort-grant/v1", grantBytes);

		this.attempt = attempt;
		this.grantNonce = grantNonceSha256;
		this.tokensValue = minted.tokens;
		this.grantValue = grant.value;
		this.grantSha256Value = grantSha256;
		this.retain("cohortGrant", grantBytes);
		this.retain("cohortGrantSignature", bytesOfCanonical(grantSignature));
		this.schedulerValue = new MacPermitScheduler({
			executionSha256: this.config.executionSha256,
			cohortGrantSha256: grantSha256,
			publisherCount: this.topology.publisherCount,
			subscriberCount: this.topology.subscriberCount,
			rampEpochMacNs: "0",
			readinessDeadlineMs: grant.value.readinessDeadlineMs,
			childIdForOrdinal: (ordinal) => this.childIdForOrdinal(ordinal),
		});
		return {
			ok: true,
			value: {
				grant: grant.value,
				grantBytes,
				grantSha256,
				grantSignature,
				cohortAttempt: attempt,
			},
		};
	}

	/** The deterministic owner child of one ordinal, from the planned topology. */
	childIdForOrdinal(globalOrdinal: number): string | undefined {
		for (const child of this.topology.children) {
			if (child.assignedGlobalOrdinals.includes(globalOrdinal)) {
				return child.childId;
			}
		}
		return undefined;
	}

	/** Re-arm the permit scheduler on the real ramp epoch, once ramping starts. */
	beginRamp(rampEpochMacNs: NsString): ProtocolResult<MacPermitScheduler> {
		const grant = this.grantValue;
		const grantSha256 = this.grantSha256Value;
		if (grant === null || grantSha256 === null) {
			return notReadyFail("no cohort grant to ramp");
		}
		const scheduler = new MacPermitScheduler({
			executionSha256: this.config.executionSha256,
			cohortGrantSha256: grantSha256,
			publisherCount: this.topology.publisherCount,
			subscriberCount: this.topology.subscriberCount,
			rampEpochMacNs,
			readinessDeadlineMs: grant.readinessDeadlineMs,
			childIdForOrdinal: (ordinal) => this.childIdForOrdinal(ordinal),
		});
		this.schedulerValue = scheduler;
		return { ok: true, value: scheduler };
	}

	// -- 2. spawn ------------------------------------------------------------

	/**
	 * Spawn every planned child, each with its own sealed FD 5. Two children may
	 * not share a PID, a PGID, an instance nonce, or a token bundle; the
	 * supervisor refuses rather than record a cohort whose members it cannot
	 * tell apart.
	 */
	spawnRoleChildren(args: {
		readonly bundleFor: (plan: MacFanoutChildPlanV1) => TokenBundleV1;
		readonly spawnedAtMacNs: NsString;
	}): ProtocolResult<readonly MacFanoutChildStateV1[]> {
		if (this.grantValue === null) return notReadyFail("no cohort grant");
		if (this.children.size !== 0)
			return protocolFail("children already spawned");
		const seenPid = new Set<number>();
		const seenPgid = new Set<number>();
		const seenBundle = new Set<Sha256Hex>();

		for (const plan of this.topology.children) {
			const sealed = sealTokenBundleFd({
				runtimeDir: this.config.runtimeDir,
				bundle: args.bundleFor(plan),
			});
			if (!sealed.ok) return sealed;
			if (sealed.value.childId !== plan.childId) {
				sealed.value.close();
				return protocolFail(
					`token bundle for ${sealed.value.childId} was sealed for ${plan.childId}`,
				);
			}
			if (seenBundle.has(sealed.value.sha256)) {
				sealed.value.close();
				return protocolFail("two children were handed the same token bundle");
			}
			seenBundle.add(sealed.value.sha256);
			this.sealedFds.push(sealed.value);

			const childInstanceNonce = sha256CanonicalRecord({
				executionSha256: this.config.executionSha256,
				cohortAttempt: this.attempt,
				childId: plan.childId,
				tokenBundleSha256: sealed.value.sha256,
			});
			const spawned = this.config.spawnChild({
				plan,
				tokenBundleReadFd: sealed.value.readFd,
				tokenBundleSha256: sealed.value.sha256,
				tokenBundleSize: sealed.value.byteSize,
				tokenBundleEntryCount: sealed.value.entryCount,
				childInstanceNonce,
				inheritedChildFds: [
					MAC_FANOUT_CONTROL_READ_FD,
					MAC_FANOUT_CONTROL_WRITE_FD,
					TOKEN_BUNDLE_FD,
				],
			});
			if (!spawned.ok) return spawned;
			if (seenPid.has(spawned.value.pid)) {
				return protocolFail(`PID ${spawned.value.pid} was spawned twice`);
			}
			if (seenPgid.has(spawned.value.pgid)) {
				return protocolFail(
					`PGID ${spawned.value.pgid} is shared by two role children`,
				);
			}
			seenPid.add(spawned.value.pid);
			seenPgid.add(spawned.value.pgid);
			this.children.set(plan.childId, {
				plan,
				pid: spawned.value.pid,
				pgid: spawned.value.pgid,
				instanceNonce: childInstanceNonce,
				tokenBundleSha256: sealed.value.sha256,
				tokenBundleSize: sealed.value.byteSize,
				tokenBundleEntryCount: sealed.value.entryCount,
				spawnedAtMacNs: args.spawnedAtMacNs,
				readyAtMacNs: null,
				warmupCompleteAtMacNs: null,
				measureArmedAtMacNs: null,
				stoppedAtMacNs: null,
				partialSha256: null,
				exitCode: null,
			});
		}
		if (this.children.size !== this.topology.expectedProcessCount) {
			return protocolFail(
				`spawned ${this.children.size} children, topology says ${this.topology.expectedProcessCount}`,
			);
		}
		// The bundles are loaded by now in a live run; the supervisor keeps no
		// descriptor to raw tokens beyond the spawn it was needed for.
		for (const sealed of this.sealedFds) sealed.close();
		return { ok: true, value: [...this.children.values()] };
	}

	markChildReady(args: {
		readonly childId: string;
		readonly readyAtMacNs: NsString;
	}): ProtocolResult<true> {
		const child = this.children.get(args.childId);
		if (child === undefined) return notReadyFail(`no child ${args.childId}`);
		if (child.readyAtMacNs !== null) {
			return notReadyFail(`${args.childId} was already ready`);
		}
		child.readyAtMacNs = args.readyAtMacNs;
		return { ok: true, value: true };
	}

	/** Record the lifecycle stamps a child reports between readiness and exit. */
	markChildLifecycle(args: {
		readonly childId: string;
		readonly warmupCompleteAtMacNs?: NsString;
		readonly measureArmedAtMacNs?: NsString;
		readonly stoppedAtMacNs?: NsString;
		readonly exitCode?: number;
	}): ProtocolResult<true> {
		const child = this.children.get(args.childId);
		if (child === undefined) return notReadyFail(`no child ${args.childId}`);
		if (child.readyAtMacNs === null) {
			return notReadyFail(`${args.childId} reported a stamp before readiness`);
		}
		if (args.warmupCompleteAtMacNs !== undefined) {
			child.warmupCompleteAtMacNs = args.warmupCompleteAtMacNs;
		}
		if (args.measureArmedAtMacNs !== undefined) {
			child.measureArmedAtMacNs = args.measureArmedAtMacNs;
		}
		if (args.stoppedAtMacNs !== undefined) {
			child.stoppedAtMacNs = args.stoppedAtMacNs;
		}
		if (args.exitCode !== undefined) child.exitCode = args.exitCode;
		return { ok: true, value: true };
	}

	// -- 3. replacement ------------------------------------------------------

	/**
	 * Plan section 4.3. Before readiness a replacement is a whole new cohort:
	 * the entire role cohort is killed and reaped, `cohortAttempt` increments,
	 * and a fresh nonce and a fresh token set are minted. Patching a child in
	 * place is not offered, because the abandoned tokens would still verify.
	 *
	 * After readiness there is no replacement at all, and a second pre-readiness
	 * replacement is terminal.
	 */
	replaceCohortBeforeReadiness(args: {
		readonly reason: string;
	}): ProtocolResult<{
		readonly cohortAttempt: number;
		readonly grantNonceSha256: Sha256Hex;
		readonly grant: CohortGrantV1;
		readonly grantSha256: Sha256Hex;
		readonly grantSignature: MacReceiptSignatureV1;
		readonly reaped: MacFanoutTeardownResultV1;
		readonly retiredTokenCommitmentRootSha256: Sha256Hex;
	}> {
		if (this.grantValue === null) return notReadyFail("no cohort to replace");
		if (this.anyChildReady) {
			return macFail(
				"CHILD_LIFECYCLE",
				`replacement after readiness is forbidden (${args.reason})`,
			);
		}
		if (this.replacements >= MAC_FANOUT_MAX_PRE_READY_REPLACEMENTS) {
			return macFail(
				"CHILD_LIFECYCLE",
				`a second pre-readiness replacement is terminal (${args.reason})`,
			);
		}
		const retiredRoot = (this.tokensValue as MacCohortTokenMaterial)
			.roleTokenCommitmentRootSha256;
		const reaped = this.reapGroups(
			[...this.children.values()].map((child) => ({
				childId: child.plan.childId,
				pid: child.pid,
				pgid: child.pgid,
				cohortAttempt: this.attempt,
			})),
			"REFUSED",
		);
		if (!reaped.ok) return reaped;
		// The abandoned groups stay on the reap list: a terminal path later must
		// still be able to say it left nothing of this attempt behind.
		this.retiredGroups.push(
			...[...this.children.values()].map((child) => ({
				childId: child.plan.childId,
				pid: child.pid,
				pgid: child.pgid,
				cohortAttempt: this.attempt,
			})),
		);
		this.children.clear();
		for (const sealed of this.sealedFds) sealed.close();
		this.sealedFds.length = 0;
		this.retained.delete("cohortGrant");
		this.retained.delete("cohortGrantSignature");
		this.warmupCompletes.clear();

		this.replacements += 1;
		const minted = this.mintAttempt(this.attempt + 1);
		if (!minted.ok) return minted;
		return {
			ok: true,
			value: {
				cohortAttempt: minted.value.cohortAttempt,
				grantNonceSha256: this.grantNonce as Sha256Hex,
				grant: minted.value.grant,
				grantSha256: minted.value.grantSha256,
				grantSignature: minted.value.grantSignature,
				reaped: reaped.value,
				retiredTokenCommitmentRootSha256: retiredRoot,
			},
		};
	}

	// -- 4. authenticated rig records the controller merely carries -----------

	/**
	 * The one place a rig-signed record enters. Parse-then-verify over the exact
	 * canonical bytes, insist the signature names the schema it actually covers,
	 * and admit once through the replay ledger inside the staged capability's
	 * lifetime. Everything a controller could do to a record on the way here --
	 * invent it, rewrite a field, replay it, hold it past expiry -- fails one of
	 * these four.
	 */
	private admitRigRecord(args: {
		readonly signedSchema: RigReceiptSignatureV1["signedSchema"];
		readonly signedBytes: Uint8Array;
		readonly signature: unknown;
		readonly issuedAtMs: number;
		readonly notAfterMs: number;
		readonly nowMs: number;
	}): ProtocolResult<{
		readonly retained: RetainedCanonicalBytesV1;
		readonly signatureBytes: Uint8Array;
	}> {
		const signature = parseRigReceiptSignature(args.signature);
		if (!signature.ok) {
			return macFail(
				"RIG_RECEIPT_SIGNATURE_INVALID",
				"unsigned or controller-invented rig record",
			);
		}
		if (signature.value.signedSchema !== args.signedSchema) {
			return macFail(
				"RIG_RECEIPT_SIGNATURE_INVALID",
				`signature covers ${signature.value.signedSchema}, not ${args.signedSchema}`,
			);
		}
		const verified = verifyRigReceiptSignature({
			stagedRigPublicRaw32: this.config.stagedRigPublicRaw32,
			signedBytes: args.signedBytes,
			signature: signature.value,
		});
		if (!verified.ok) return verified;
		const admitted = admitSignedRecordWithExpiryAndReplay({
			ledger: this.config.ledger,
			side: "rig-records",
			signedSchema: args.signedSchema,
			signedBytes: args.signedBytes,
			issuedAtMs: args.issuedAtMs,
			notAfterMs: args.notAfterMs,
			stagedCapabilityNotAfterMs: this.config.stagedCapabilityNotAfterMs,
			nowMs: args.nowMs,
		});
		if (!admitted.ok) return admitted;
		return {
			ok: true,
			value: {
				retained: retainBytes(args.signedBytes),
				signatureBytes: bytesOfCanonical(signature.value),
			},
		};
	}

	/** Every rig record must name this execution and this exact cohort grant. */
	private requireCohortJoin(record: {
		readonly executionSha256: Sha256Hex;
		readonly cohortGrantSha256: Sha256Hex;
	}): ProtocolResult<true> {
		if (record.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"rig record names another execution",
			);
		}
		if (record.cohortGrantSha256 !== this.grantSha256Value) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"rig record names another cohort grant",
			);
		}
		return { ok: true, value: true };
	}

	presentRigCohortAcceptance(args: {
		readonly acceptance: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<MacRigCohortAcceptanceAckV1> {
		const grant = this.grantValue;
		if (grant === null) return notReadyFail("no cohort grant to accept");
		const acceptance = parseRigCohortAcceptance(args.acceptance);
		if (!acceptance.ok) return acceptance;
		const joined = this.requireCohortJoin(acceptance.value);
		if (!joined.ok) return joined;
		const signatureRecord = this.required("cohortGrantSignature");
		if (signatureRecord === null)
			return notReadyFail("grant signature is gone");
		if (
			acceptance.value.cohortGrantSignatureSha256 !==
			signatureRecord.retained.sha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"acceptance covers a different grant signature",
			);
		}
		if (
			acceptance.value.roleTokenCommitmentRootSha256 !==
			grant.roleTokenCommitmentRootSha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"acceptance carries another cohort's token commitment root",
			);
		}
		if (
			acceptance.value.approvedPlanSha256 !== grant.approvedPlanSha256 ||
			acceptance.value.approvalRecordSha256 !== grant.approvalRecordSha256
		) {
			return macFail(
				"APPROVAL_IDENTITY_MISMATCH",
				"acceptance names another approval",
			);
		}
		const admitted = this.admitRigRecord({
			signedSchema: "rig-cohort-acceptance/v1",
			signedBytes: bytesOfCanonical(acceptance.value),
			signature: args.signature,
			issuedAtMs: acceptance.value.issuedAtMs,
			notAfterMs: acceptance.value.notAfterMs,
			nowMs: args.nowMs,
		});
		if (!admitted.ok) return admitted;
		this.retain("rigCohortAcceptance", bytesOfCanonical(acceptance.value));
		this.retain("rigCohortAcceptanceSignature", admitted.value.signatureBytes);
		return {
			ok: true,
			value: {
				schema: "mac-rig-cohort-acceptance-ack/v1",
				responseSeq: this.nextReceiptSequence(),
				ackRequestSeq: acceptance.value.receiptSequence,
				executionSha256: this.config.executionSha256,
				rigCohortAcceptanceSha256: admitted.value.retained.sha256,
			},
		};
	}

	/** Retain the exact plan-input bytes the grant already committed to. */
	retainWorkloadRolePlanInput(bytes: Uint8Array): ProtocolResult<true> {
		const grant = this.grantValue;
		if (grant === null) return notReadyFail("no cohort grant");
		if (sha256HexOfBytes(bytes) !== grant.workloadRolePlanInputSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"workload role plan input is not the bytes the grant committed to",
			);
		}
		this.retain("workloadRolePlanInput", bytes);
		return { ok: true, value: true };
	}

	/** Retain the leaf manifest; the grant already fixed its digest. */
	retainTokenCommitmentLeafManifest(bytes: Uint8Array): ProtocolResult<true> {
		const grant = this.grantValue;
		const tokens = this.tokensValue;
		if (grant === null || tokens === null)
			return notReadyFail("no cohort grant");
		if (sha256HexOfBytes(bytes) !== grant.tokenCommitmentLeafManifestSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"leaf manifest is not the manifest the grant committed to",
			);
		}
		const json = parseStrictJsonBytes(bytes);
		if (!json.ok) return protocolFail("leaf manifest is not canonical JSON");
		const manifest = parseTokenCommitmentLeafManifest(json.value);
		if (!manifest.ok) return manifest;
		const root = recomputeRootFromLeafManifest(manifest.value);
		if (!root.ok) return root;
		if (root.value !== tokens.roleTokenCommitmentRootSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"leaf manifest does not recompute this cohort's commitment root",
			);
		}
		this.retain("tokenCommitmentLeafManifest", bytes);
		return { ok: true, value: true };
	}

	/** Mint and sign the warmup epoch; it binds to the grant, never the barrier. */
	issueWarmupEpoch(epoch: unknown): ProtocolResult<MacWarmupEpochIssuedAckV1> {
		if (this.grantValue === null) return notReadyFail("no cohort grant");
		const parsed = parseCohortWarmupEpoch(epoch);
		if (!parsed.ok) return parsed;
		const joined = this.requireCohortJoin(parsed.value);
		if (!joined.ok) return joined;
		const bytes = bytesOfCanonical(parsed.value);
		const signature = this.macSign("cohort-warmup-epoch/v1", bytes);
		this.retain("cohortWarmupEpoch", bytes);
		this.retain("cohortWarmupEpochSignature", bytesOfCanonical(signature));
		return {
			ok: true,
			value: {
				schema: "mac-warmup-epoch-issued-ack/v1",
				responseSeq: this.nextReceiptSequence(),
				ackRequestSeq: parsed.value.receiptSequence,
				executionSha256: this.config.executionSha256,
				cohortWarmupEpochBase64: Buffer.from(bytes).toString("base64"),
				cohortWarmupEpochSignatureBase64: Buffer.from(
					bytesOfCanonical(signature),
				).toString("base64"),
			},
		};
	}

	/** One warmup completion frame per named child, inside the child frame cap. */
	retainRoleWarmupComplete(
		bytes: Uint8Array,
	): ProtocolResult<RoleWarmupCompleteV1> {
		if (bytes.byteLength > ROLE_CHILD_FRAME_MAX_BYTES) {
			return protocolFail("role warmup completion frame exceeds the child cap");
		}
		const json = parseStrictJsonBytes(bytes);
		if (!json.ok)
			return protocolFail("warmup completion is not canonical JSON");
		const frame = parseRoleWarmupComplete(json.value);
		if (!frame.ok) return frame;
		const child = this.children.get(frame.value.childId);
		if (child === undefined) {
			return notReadyFail(
				`${frame.value.childId} is not a child this supervisor spawned`,
			);
		}
		if (frame.value.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup frame names another execution",
			);
		}
		if (frame.value.cohortGrantSha256 !== this.grantSha256Value) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup frame names another cohort",
			);
		}
		if (this.warmupCompletes.has(frame.value.childId)) {
			return protocolFail(
				`${frame.value.childId} reported warmup completion twice`,
			);
		}
		this.warmupCompletes.set(frame.value.childId, {
			retained: retainBytes(bytes),
			bytes,
		});
		child.warmupCompleteAtMacNs = frame.value.completedAtMacNs;
		return frame;
	}

	/**
	 * Sign the ordered warmup manifest only if it covers the exact retained child
	 * frames, in the frozen publisher-then-worker order.
	 */
	issueRoleWarmupCompletionManifest(
		manifest: unknown,
	): ProtocolResult<MacWarmupCompletionManifestExportedAckV1> {
		const epoch = this.required("cohortWarmupEpoch");
		if (epoch === null) return notReadyFail("no warmup epoch was issued");
		const parsed = parseRoleWarmupCompletionManifest(manifest);
		if (!parsed.ok) return parsed;
		const epochJson = parseStrictJsonBytes(epoch.bytes);
		if (!epochJson.ok) return protocolFail("retained epoch is unreadable");
		const shardCounts = this.topology.children
			.filter((child) => child.role === "subscriber-worker")
			.map((child) => child.assignedRoleIds.length);
		const validated = validateRoleWarmupCompletionManifest({
			manifest: parsed.value,
			epoch: epochJson.value,
			publisherCount: this.topology.publisherCount,
			subscriberCount: this.topology.subscriberCount,
			shardSubscriberCounts: shardCounts,
		});
		if (!validated.ok) return validated;
		const ordered = this.orderedChildIds();
		if (parsed.value.entries.length !== ordered.length) {
			return protocolFail("warmup manifest entry count is not the topology");
		}
		for (const [index, entry] of parsed.value.entries.entries()) {
			const retained = this.warmupCompletes.get(ordered[index] as string);
			if (retained === undefined) {
				return notReadyFail(
					`${ordered[index]} never reported warmup completion`,
				);
			}
			if (
				entry.childId !== ordered[index] ||
				entry.roleWarmupCompleteSha256 !== retained.retained.sha256 ||
				entry.roleWarmupComplete.sha256 !== retained.retained.sha256 ||
				entry.roleWarmupComplete.bytesBase64 !== retained.retained.bytesBase64
			) {
				return macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`warmup manifest entry ${index} does not carry the retained child bytes`,
				);
			}
		}
		const bytes = bytesOfCanonical(parsed.value);
		const signature = this.macSign("role-warmup-completion-manifest/v1", bytes);
		const signatureBytes = bytesOfCanonical(signature);
		this.retain("roleWarmupCompletionManifest", bytes);
		this.retain("roleWarmupCompletionManifestSignature", signatureBytes);
		return {
			ok: true,
			value: {
				schema: "mac-warmup-completion-manifest-exported-ack/v1",
				responseSeq: this.nextReceiptSequence(),
				ackRequestSeq: parsed.value.entries.length,
				executionSha256: this.config.executionSha256,
				cohortWarmupEpochSha256: epoch.retained.sha256,
				roleWarmupCompletionManifestBase64:
					Buffer.from(bytes).toString("base64"),
				roleWarmupCompletionManifestSha256: sha256HexOfBytes(bytes),
				roleWarmupCompletionManifestSize: bytes.byteLength,
				roleWarmupCompletionManifestSignatureBase64:
					Buffer.from(signatureBytes).toString("base64"),
				roleWarmupCompletionManifestSignatureSha256:
					sha256HexOfBytes(signatureBytes),
				entryCount: parsed.value.entries.length,
				terminalWarmupExport: true,
			},
		};
	}

	presentRigWarmupDrainedReceipt(args: {
		readonly serverWarmupDrainedBytes: Uint8Array;
		readonly receipt: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<{ readonly rigWarmupDrainedReceiptSha256: Sha256Hex }> {
		const receipt = parseRigWarmupDrainedReceipt(args.receipt);
		if (!receipt.ok) return receipt;
		const joined = this.requireCohortJoin(receipt.value);
		if (!joined.ok) return joined;
		const drainedSha256 = sha256HexOfBytes(args.serverWarmupDrainedBytes);
		if (receipt.value.serverWarmupDrainedSha256 !== drainedSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup receipt does not cover the presented server frame",
			);
		}
		const epoch = this.required("cohortWarmupEpoch");
		const epochSignature = this.required("cohortWarmupEpochSignature");
		const manifest = this.required("roleWarmupCompletionManifest");
		const manifestSignature = this.required(
			"roleWarmupCompletionManifestSignature",
		);
		if (
			epoch === null ||
			epochSignature === null ||
			manifest === null ||
			manifestSignature === null
		) {
			return notReadyFail("warmup records are not all retained yet");
		}
		if (
			receipt.value.cohortWarmupEpochSha256 !== epoch.retained.sha256 ||
			receipt.value.cohortWarmupEpochSignatureSha256 !==
				epochSignature.retained.sha256 ||
			receipt.value.roleWarmupCompletionManifestSha256 !==
				manifest.retained.sha256 ||
			receipt.value.roleWarmupCompletionManifestSignatureSha256 !==
				manifestSignature.retained.sha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup receipt is joined to warmup records this supervisor is not holding",
			);
		}
		const admitted = this.admitRigRecord({
			signedSchema: "rig-warmup-drained-receipt/v1",
			signedBytes: bytesOfCanonical(receipt.value),
			signature: args.signature,
			issuedAtMs: receipt.value.issuedAtMs,
			notAfterMs: receipt.value.notAfterMs,
			nowMs: args.nowMs,
		});
		if (!admitted.ok) return admitted;
		this.retain("serverWarmupDrained", args.serverWarmupDrainedBytes);
		this.retain("rigWarmupDrainedReceipt", bytesOfCanonical(receipt.value));
		this.retain(
			"rigWarmupDrainedReceiptSignature",
			admitted.value.signatureBytes,
		);
		return {
			ok: true,
			value: { rigWarmupDrainedReceiptSha256: admitted.value.retained.sha256 },
		};
	}

	/**
	 * The Linux baseline ack. It comes from the Phase-A rig protocol rather than
	 * the cohort schemas, so it is admitted as signed bytes with its execution
	 * join checked, and it is the digest the barrier must then name.
	 */
	presentRigMeasureStartAck(args: {
		readonly ackBytes: Uint8Array;
		readonly signature: unknown;
		readonly issuedAtMs: number;
		readonly notAfterMs: number;
		readonly nowMs: number;
	}): ProtocolResult<{ readonly rigMeasureStartAckSha256: Sha256Hex }> {
		if (args.ackBytes.byteLength > RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES) {
			return protocolFail("rig measure-start ack exceeds its cap");
		}
		const json = parseStrictJsonBytes(args.ackBytes);
		if (!json.ok)
			return protocolFail("measure-start ack is not canonical JSON");
		const record = json.value as { readonly [key: string]: unknown };
		if (record.schema !== "rig-measure-start-ack/v1") {
			return protocolFail("presented record is not a rig measure-start ack");
		}
		if (record.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"measure-start ack names another execution",
			);
		}
		const admitted = this.admitRigRecord({
			signedSchema: "rig-measure-start-ack/v1",
			signedBytes: args.ackBytes,
			signature: args.signature,
			issuedAtMs: args.issuedAtMs,
			notAfterMs: args.notAfterMs,
			nowMs: args.nowMs,
		});
		if (!admitted.ok) return admitted;
		this.retain("rigMeasureStartAck", args.ackBytes);
		this.retain("rigMeasureStartAckSignature", admitted.value.signatureBytes);
		return {
			ok: true,
			value: { rigMeasureStartAckSha256: admitted.value.retained.sha256 },
		};
	}

	/**
	 * Mint and sign the start barrier. Its four retained-record bindings must
	 * name exactly what this supervisor is holding -- that is the whole reason
	 * the barrier cannot be minted before readiness, warmup and the Linux
	 * baseline have all actually happened.
	 */
	issueStartBarrier(
		barrier: unknown,
	): ProtocolResult<MacStartBarrierIssuedAckV1> {
		if (!this.allChildrenReady) {
			return notReadyFail("a start barrier may not be minted before readiness");
		}
		const acceptance = this.required("rigCohortAcceptance");
		const manifest = this.required("roleWarmupCompletionManifest");
		const manifestSignature = this.required(
			"roleWarmupCompletionManifestSignature",
		);
		const warmupReceipt = this.required("rigWarmupDrainedReceipt");
		const measureStartAck = this.required("rigMeasureStartAck");
		if (
			acceptance === null ||
			manifest === null ||
			manifestSignature === null ||
			warmupReceipt === null ||
			measureStartAck === null
		) {
			return notReadyFail("barrier preconditions are not all retained");
		}
		const preconditions = validateCohortStartBarrierPreconditions({
			barrier,
			rigCohortAcceptanceSha256: acceptance.retained.sha256,
			rigMeasureStartAckSha256: measureStartAck.retained.sha256,
			roleWarmupCompletionManifestSha256: manifest.retained.sha256,
			rigWarmupDrainedReceiptSha256: warmupReceipt.retained.sha256,
		});
		if (!preconditions.ok) return preconditions;
		const parsed = parseCohortStartBarrier(barrier);
		if (!parsed.ok) return parsed;
		const joined = this.requireCohortJoin(parsed.value);
		if (!joined.ok) return joined;
		if (
			parsed.value.roleWarmupCompletionManifestSignatureSha256 !==
			manifestSignature.retained.sha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"barrier names another warmup manifest signature",
			);
		}
		if (parsed.value.macClockId !== this.config.macClockId) {
			return protocolFail("barrier was stamped by another Mac clock");
		}
		const bytes = bytesOfCanonical(parsed.value);
		const signature = this.macSign("cohort-start-barrier/v1", bytes);
		this.barrierRecord = parsed.value;
		this.retain("cohortStartBarrier", bytes);
		this.retain("cohortStartBarrierSignature", bytesOfCanonical(signature));
		return {
			ok: true,
			value: {
				schema: "mac-start-barrier-issued-ack/v1",
				responseSeq: this.nextReceiptSequence(),
				ackRequestSeq: parsed.value.receiptSequence,
				executionSha256: this.config.executionSha256,
				cohortStartBarrierBase64: Buffer.from(bytes).toString("base64"),
				cohortStartBarrierSha256: sha256HexOfBytes(bytes),
				cohortStartBarrierSignatureBase64: Buffer.from(
					bytesOfCanonical(signature),
				).toString("base64"),
			},
		};
	}

	presentRigBarrierAcceptance(args: {
		readonly serverStartBarrierAcceptedBytes: Uint8Array;
		readonly acceptance: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<MacRigBarrierAcceptanceAckV1> {
		const barrier = this.required("cohortStartBarrier");
		const barrierSignature = this.required("cohortStartBarrierSignature");
		const measureStartAck = this.required("rigMeasureStartAck");
		if (
			barrier === null ||
			barrierSignature === null ||
			measureStartAck === null
		) {
			return notReadyFail("no barrier has been issued");
		}
		const acceptance = parseRigBarrierAcceptance(args.acceptance);
		if (!acceptance.ok) return acceptance;
		const joined = this.requireCohortJoin(acceptance.value);
		if (!joined.ok) return joined;
		const serverSha256 = sha256HexOfBytes(args.serverStartBarrierAcceptedBytes);
		if (
			acceptance.value.cohortStartBarrierSha256 !== barrier.retained.sha256 ||
			acceptance.value.cohortStartBarrierSignatureSha256 !==
				barrierSignature.retained.sha256 ||
			acceptance.value.rigMeasureStartAckSha256 !==
				measureStartAck.retained.sha256 ||
			acceptance.value.serverStartBarrierAcceptedSha256 !== serverSha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"barrier acceptance is joined to records this supervisor is not holding",
			);
		}
		const admitted = this.admitRigRecord({
			signedSchema: "rig-barrier-acceptance/v1",
			signedBytes: bytesOfCanonical(acceptance.value),
			signature: args.signature,
			issuedAtMs: acceptance.value.issuedAtMs,
			notAfterMs: acceptance.value.notAfterMs,
			nowMs: args.nowMs,
		});
		if (!admitted.ok) return admitted;
		this.retain(
			"serverStartBarrierAccepted",
			args.serverStartBarrierAcceptedBytes,
		);
		this.retain("rigBarrierAcceptance", bytesOfCanonical(acceptance.value));
		this.retain("rigBarrierAcceptanceSignature", admitted.value.signatureBytes);
		return {
			ok: true,
			value: {
				schema: "mac-rig-barrier-acceptance-ack/v1",
				responseSeq: this.nextReceiptSequence(),
				ackRequestSeq: acceptance.value.receiptSequence,
				executionSha256: this.config.executionSha256,
				rigBarrierAcceptanceSha256: admitted.value.retained.sha256,
				roleChildrenMayArm: true,
			},
		};
	}

	/**
	 * The Linux observation is the sole authority for registration, ingress,
	 * capacity and faults; the Mac side takes it only under a rig signature and
	 * only paired with the receipt that covers those exact bytes.
	 */
	presentRigRelayObservation(args: {
		readonly observationBytes: Uint8Array;
		readonly receipt: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<{ readonly linuxRelayObservationSha256: Sha256Hex }> {
		const barrier = this.required("cohortStartBarrier");
		if (barrier === null) return notReadyFail("no barrier has been issued");
		if (args.observationBytes.byteLength > LINUX_RELAY_OBSERVATION_MAX_BYTES) {
			return protocolFail("linux relay observation exceeds its cap");
		}
		const json = parseStrictJsonBytes(args.observationBytes);
		if (!json.ok)
			return protocolFail("linux observation is not canonical JSON");
		const observation = parseLinuxRelayObservation(json.value);
		if (!observation.ok) return observation;
		const joined = this.requireCohortJoin(observation.value);
		if (!joined.ok) return joined;
		if (
			observation.value.cohortStartBarrierSha256 !== barrier.retained.sha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"linux observation names another start barrier",
			);
		}
		const receipt = parseRigRelayObservationReceipt(args.receipt);
		if (!receipt.ok) return receipt;
		const rejoined = this.requireCohortJoin(receipt.value);
		if (!rejoined.ok) return rejoined;
		const observationSha256 = sha256HexOfBytes(args.observationBytes);
		if (receipt.value.linuxRelayObservationSha256 !== observationSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"rig receipt does not cover the presented Linux observation",
			);
		}
		if (receipt.value.cohortStartBarrierSha256 !== barrier.retained.sha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"rig relay receipt names another start barrier",
			);
		}
		const admitted = this.admitRigRecord({
			signedSchema: "rig-relay-observation-receipt/v1",
			signedBytes: bytesOfCanonical(receipt.value),
			signature: args.signature,
			issuedAtMs: receipt.value.issuedAtMs,
			notAfterMs: receipt.value.notAfterMs,
			nowMs: args.nowMs,
		});
		if (!admitted.ok) return admitted;
		this.linuxObservation = observation.value;
		this.retain("linuxRelayObservation", args.observationBytes);
		this.retain("rigRelayObservationReceipt", bytesOfCanonical(receipt.value));
		this.retain(
			"rigRelayObservationReceiptSignature",
			admitted.value.signatureBytes,
		);
		return {
			ok: true,
			value: { linuxRelayObservationSha256: observationSha256 },
		};
	}

	// -- 5. partials, which arrive only from the child that produced them ------

	/** Publisher IDs ascending, then workers 0..7: the frozen partial order. */
	private orderedChildIds(): readonly string[] {
		const publishers = this.topology.children
			.filter((child) => child.role === "publisher")
			.map((child) => child.childId);
		const workers = this.topology.children
			.filter((child) => child.role === "subscriber-worker")
			.map((child) => child.childId);
		return [...publishers, ...workers];
	}

	/**
	 * A partial is accepted only on the private control channel of the child it
	 * names, only once, and only if the frame's declared digest is the digest of
	 * the bytes it carries. The frame is the child's; nothing else may state one.
	 */
	acceptRolePartial(args: {
		readonly childId: string;
		readonly frame: unknown;
	}): ProtocolResult<RolePartialAcceptedV1> {
		const frame = parseRolePartial(args.frame);
		if (!frame.ok) return frame;
		if (frame.value.childId !== args.childId) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				`a partial for ${frame.value.childId} arrived on ${args.childId}'s channel`,
			);
		}
		const child = this.children.get(args.childId);
		if (child === undefined) {
			return notReadyFail(
				`${args.childId} is not a child this supervisor spawned`,
			);
		}
		if (child.readyAtMacNs === null) {
			return notReadyFail(
				`${args.childId} produced a partial before readiness`,
			);
		}
		if (child.partialSha256 !== null) {
			return protocolFail(`${args.childId} already delivered a partial`);
		}
		if (frame.value.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"partial names another execution",
			);
		}
		const bytes = Buffer.from(frame.value.partialBase64, "base64");
		const payload = new Uint8Array(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		);
		const partialSha256 = sha256HexOfBytes(payload);
		if (partialSha256 !== frame.value.partialSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"partial frame digest is not the digest of its own bytes",
			);
		}
		const json = parseStrictJsonBytes(payload);
		if (!json.ok) return protocolFail("partial is not canonical JSON");

		const expectedKind =
			child.plan.role === "publisher" ? "publisher" : "worker";
		if (frame.value.partialKind !== expectedKind) {
			return protocolFail(
				`${args.childId} is a ${child.plan.role} but sent a ${frame.value.partialKind} partial`,
			);
		}
		if (expectedKind === "publisher") {
			if (payload.byteLength > PUBLISHER_PARTIAL_MAX_BYTES) {
				return protocolFail("publisher partial exceeds its cap");
			}
			const parsed = parsePublisherPartial(json.value);
			if (!parsed.ok) return parsed;
			const bound = this.requirePartialBinding(parsed.value, child);
			if (!bound.ok) return bound;
			if (parsed.value.publisherId !== child.plan.publisherId) {
				return macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					"publisher partial names another publisher",
				);
			}
			this.publisherPartials.set(child.plan.publisherId as string, {
				retained: retainBytes(payload),
				bytes: payload,
			});
			this.publisherPartialRecords.set(
				child.plan.publisherId as string,
				parsed.value,
			);
		} else {
			if (payload.byteLength > WORKER_PARTIAL_MAX_BYTES) {
				return protocolFail("worker partial exceeds its cap");
			}
			const parsed = parseWorkerPartial(json.value);
			if (!parsed.ok) return parsed;
			const bound = this.requirePartialBinding(parsed.value, child);
			if (!bound.ok) return bound;
			if (parsed.value.workerIndex !== child.plan.workerIndex) {
				return macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					"worker partial names another shard",
				);
			}
			if (parsed.value.tokenBundleSha256 !== child.tokenBundleSha256) {
				return macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					"worker partial names another token bundle",
				);
			}
			this.workerPartials.set(child.plan.workerIndex as number, {
				retained: retainBytes(payload),
				bytes: payload,
			});
			this.workerPartialRecords.set(
				child.plan.workerIndex as number,
				parsed.value,
			);
		}
		child.partialSha256 = partialSha256;
		child.exitCode = 0;
		return {
			ok: true,
			value: {
				schema: "role-partial-accepted/v1",
				sequence: this.nextReceiptSequence(),
				executionSha256: this.config.executionSha256,
				childId: args.childId,
				partialSha256,
			},
		};
	}

	/** A partial must name this cohort, this barrier, and its own process. */
	private requirePartialBinding(
		partial: {
			readonly executionSha256: Sha256Hex;
			readonly cohortGrantSha256: Sha256Hex;
			readonly cohortStartBarrierSha256: Sha256Hex;
			readonly childId: string;
			readonly childPid: number;
			readonly childPgid: number;
			readonly childInstanceNonce: Sha256Hex;
		},
		child: MacFanoutChildStateV1,
	): ProtocolResult<true> {
		const barrier = this.required("cohortStartBarrier");
		if (barrier === null)
			return notReadyFail("no barrier to bind a partial to");
		if (partial.cohortGrantSha256 !== this.grantSha256Value) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"partial names another cohort",
			);
		}
		if (partial.cohortStartBarrierSha256 !== barrier.retained.sha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"partial names another barrier",
			);
		}
		if (
			partial.childId !== child.plan.childId ||
			partial.childPid !== child.pid ||
			partial.childPgid !== child.pgid ||
			partial.childInstanceNonce !== child.instanceNonce
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"partial does not name the process this supervisor spawned",
			);
		}
		return { ok: true, value: true };
	}

	// -- 6. aggregation and the one raw-evidence export -----------------------

	/** The ordered manifest, derived from retained bytes and nothing else. */
	private buildOrderedPartialManifest(): ProtocolResult<OrderedPartialManifestV1> {
		const barrier = this.required("cohortStartBarrier");
		if (barrier === null) return notReadyFail("no barrier");
		const ordered = this.orderedPartialRecords();
		if (!ordered.ok) return ordered;
		const entries: OrderedPartialManifestEntryV1[] = ordered.value.map(
			(item, order) => ({
				schema: "ordered-partial-manifest-entry/v1" as const,
				order,
				partialKind: item.kind,
				childId: item.childId,
				partialSha256: item.retained.retained.sha256,
				partialSize: item.retained.retained.byteLength,
			}),
		);
		const totalPartialBytes = entries.reduce(
			(total, entry) => total + entry.partialSize,
			0,
		);
		return parseOrderedPartialManifest({
			schema: "ordered-partial-manifest/v1",
			executionSha256: this.config.executionSha256,
			cohortGrantSha256: this.grantSha256Value as Sha256Hex,
			cohortStartBarrierSha256: barrier.retained.sha256,
			publisherPartialCount: this.topology.publisherCount,
			workerPartialCount: COHORT_WORKER_COUNT,
			totalPartialBytes,
			entries,
			orderedDigestSetSha256: orderedPartialDigestSetSha256(entries),
		});
	}

	/** Publishers ascending then workers 0..7, each with its retained bytes. */
	private orderedPartialRecords(): ProtocolResult<
		readonly {
			readonly kind: "publisher" | "worker";
			readonly childId: string;
			readonly retained: RetainedRecord;
		}[]
	> {
		const items: {
			readonly kind: "publisher" | "worker";
			readonly childId: string;
			readonly retained: RetainedRecord;
		}[] = [];
		for (const plan of this.topology.children) {
			if (plan.role === "publisher") {
				const retained = this.publisherPartials.get(plan.publisherId as string);
				if (retained === undefined) {
					return notReadyFail(`${plan.childId} never delivered its partial`);
				}
				items.push({ kind: "publisher", childId: plan.childId, retained });
			}
		}
		for (const plan of this.topology.children) {
			if (plan.role === "subscriber-worker") {
				const retained = this.workerPartials.get(plan.workerIndex as number);
				if (retained === undefined) {
					return notReadyFail(`${plan.childId} never delivered its partial`);
				}
				items.push({ kind: "worker", childId: plan.childId, retained });
			}
		}
		return { ok: true, value: items };
	}

	/** The process proof, assembled from spawn/ready/waitpid observations. */
	private buildObservedProcessProof(): ProtocolResult<ObservedProcessProofV1> {
		const barrier = this.required("cohortStartBarrier");
		if (barrier === null) return notReadyFail("no barrier");
		const children: ObservedChildProcessV1[] = [];
		for (const childId of this.orderedChildIds()) {
			const child = this.children.get(childId);
			if (child === undefined) return notReadyFail(`no child ${childId}`);
			if (
				child.readyAtMacNs === null ||
				child.warmupCompleteAtMacNs === null ||
				child.measureArmedAtMacNs === null ||
				child.stoppedAtMacNs === null ||
				child.partialSha256 === null ||
				child.exitCode === null
			) {
				return notReadyFail(`${childId} has an incomplete lifecycle`);
			}
			const worker =
				child.plan.role === "subscriber-worker"
					? this.workerPartialRecords.get(child.plan.workerIndex as number)
					: undefined;
			children.push({
				schema: "observed-child-process/v1",
				childId,
				role: child.plan.role,
				pid: child.pid,
				pgid: child.pgid,
				instanceNonce: child.instanceNonce,
				bunSha256: this.config.bunSha256,
				entrypointSha256: this.config.entrypointSha256,
				tokenOrBundleSha256: child.tokenBundleSha256,
				publisherId: child.plan.publisherId,
				workerIndex: child.plan.workerIndex,
				orderedSubscriberIdsSha256:
					worker === undefined ? null : worker.orderedSubscriberIdsSha256,
				subscriberCount:
					child.plan.role === "publisher"
						? 0
						: child.plan.assignedRoleIds.length,
				spawnedAtMacNs: child.spawnedAtMacNs,
				readyAtMacNs: child.readyAtMacNs,
				warmupCompleteAtMacNs: child.warmupCompleteAtMacNs,
				measureArmedAtMacNs: child.measureArmedAtMacNs,
				stoppedAtMacNs: child.stoppedAtMacNs,
				partialSha256: child.partialSha256,
				exitCode: child.exitCode,
				signal: null,
				replacementCount: COHORT_ROLE_REPLACEMENT_COUNT,
			});
		}
		return parseObservedProcessProof({
			schema: "observed-process-proof/v1",
			executionSha256: this.config.executionSha256,
			cohortGrantSha256: this.grantSha256Value as Sha256Hex,
			cohortStartBarrierSha256: barrier.retained.sha256,
			expectedProcessCount: this.topology.expectedProcessCount,
			observedProcessCount: children.length,
			expectedPublisherCount: this.topology.publisherCount,
			observedPublisherCount: this.topology.publisherCount,
			expectedWorkerCount: COHORT_WORKER_COUNT,
			observedWorkerCount: COHORT_WORKER_COUNT,
			expectedSubscriberCount: this.topology.subscriberCount,
			observedSubscriberCount: this.topology.subscriberCount,
			children,
			childrenDigestSha256: observedChildrenDigestSha256(children),
		});
	}

	/**
	 * Recompute conservation, ledger, rate series and capacity from the retained
	 * partial bytes and the Linux observation. None of these four is a number the
	 * supervisor was told; each is a number it recomputed from evidence.
	 */
	private buildDerivedRecords(): ProtocolResult<{
		readonly rateSeries: CohortRateSeriesV1;
		readonly ledger: CohortLedgerV1;
		readonly capacity: CohortCapacityV1;
	}> {
		const grant = this.grantValue;
		const barrier = this.barrierRecord;
		const linux = this.linuxObservation;
		if (grant === null || barrier === null || linux === null) {
			return notReadyFail(
				"derived records need grant, barrier and observation",
			);
		}
		const publisherRecords: PublisherPartialV1[] = [];
		for (const plan of this.topology.children) {
			if (plan.role !== "publisher") continue;
			const record = this.publisherPartialRecords.get(
				plan.publisherId as string,
			);
			if (record === undefined) return notReadyFail(`${plan.childId} partial`);
			publisherRecords.push(record);
		}
		const workerRecords: WorkerPartialV1[] = [];
		for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
			const record = this.workerPartialRecords.get(worker);
			if (record === undefined) return notReadyFail(`worker ${worker} partial`);
			workerRecords.push(record);
		}
		const conservation = recomputeCohortOriginConservation({
			publisherPartials: publisherRecords,
			workerPartials: workerRecords,
			linuxRelayObservation: linux,
			subscriberCount: this.topology.subscriberCount,
			messageBytes: grant.messageBytes,
		});
		if (!conservation.ok) return conservation;
		const ledger = recomputeCohortLedger({
			conservation: conservation.value,
			subscriberCount: this.topology.subscriberCount,
			messageBytes: grant.messageBytes,
		});
		if (!ledger.ok) return ledger;

		const firstDelivery = workerRecords
			.map((worker) => BigInt(worker.firstDeliveryAtMacNs))
			.reduce((low, value) => (value < low ? value : low));
		const lastDelivery = workerRecords
			.map((worker) => BigInt(worker.lastDeliveryAtMacNs))
			.reduce((high, value) => (value > high ? value : high));
		const drained = workerRecords.some(
			(worker) => worker.deliveredAfterMeasureStop > 0,
		);
		// With no post-stop drain the last delivery *is* the last measured one.
		// With a drain, the measured window's last delivery is not separately
		// observed, so the barrier's stop instant is the only defensible stamp.
		const lastMeasured = drained
			? BigInt(barrier.measureStopAtMacNs)
			: lastDelivery;
		const rateSeries = recomputeCohortRateSeries({
			workerPartials: workerRecords,
			conservation: conservation.value,
			windowCount: barrier.windowCount,
			measuredDurationMs: barrier.measuredDurationMs,
			firstDeliveryAtMacNs: firstDelivery.toString(),
			lastMeasuredWindowDeliveryAtMacNs: lastMeasured.toString(),
			lastDeliveryIncludingDrainAtMacNs: lastDelivery.toString(),
		});
		if (!rateSeries.ok) return rateSeries;

		const capacity = parseCohortCapacity({
			schema: "cohort-capacity/v1",
			expectedSessions: this.topology.expectedSessionCount,
			sessionsAccepted: linux.sessionsAccepted,
			sessionsActivePeak: linux.sessionsActivePeak,
			expectedPublishers: this.topology.publisherCount,
			registeredPublishers: linux.registeredPublisherCount,
			expectedSubscribers: this.topology.subscriberCount,
			registeredSubscribers: linux.registeredSubscriberCount,
		});
		if (!capacity.ok) return capacity;
		return {
			ok: true,
			value: {
				rateSeries: rateSeries.value,
				ledger: ledger.value,
				capacity: capacity.value,
			},
		};
	}

	/**
	 * The sole final raw-evidence egress. Everything in the bundle is a retained
	 * byte string this supervisor either signed or authenticated on arrival; the
	 * request carries a sequence and a digest, never content. It runs once.
	 */
	exportCohortEvidence(args: {
		readonly request: MacExportCohortEvidenceRequestV1;
		readonly issuedAtMs: number;
		readonly notAfterMs: number;
	}): ProtocolResult<MacCohortEvidenceExportedAckV1> {
		if (this.exported) {
			return protocolFail("cohort evidence was already exported");
		}
		if (args.request.schema !== "mac-export-cohort-evidence-request/v1") {
			return protocolFail("export request schema");
		}
		if (args.request.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"export request names another execution",
			);
		}
		const admission = this.buildAdmissionReceipt({
			issuedAtMs: args.issuedAtMs,
			notAfterMs: args.notAfterMs,
		});
		if (!admission.ok) return admission;
		const admissionBytes = bytesOfCanonical(admission.value);
		const admissionSha256 = sha256HexOfBytes(admissionBytes);
		if (args.request.cohortAdmissionReceiptSha256 !== admissionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"export request names an admission receipt this supervisor did not mint",
			);
		}
		const admissionSignature = this.macSign(
			"cohort-admission-receipt/v1",
			admissionBytes,
		);
		this.retain("cohortAdmissionReceipt", admissionBytes);
		this.retain(
			"cohortAdmissionSignature",
			bytesOfCanonical(admissionSignature),
		);

		const assembled = this.assembleEvidence();
		if (!assembled.ok) return assembled;
		const evidenceBytes = bytesOfCanonical(assembled.value);
		if (
			evidenceBytes.byteLength > COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES
		) {
			return protocolFail(
				"cohort observation evidence exceeds its decoded cap",
			);
		}
		const encoded = Buffer.from(evidenceBytes).toString("base64");
		if (encoded.length > COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES) {
			return protocolFail(
				"cohort observation evidence exceeds its encoded cap",
			);
		}
		this.exported = true;
		return {
			ok: true,
			value: {
				schema: "mac-cohort-evidence-exported-ack/v1",
				responseSeq: this.nextReceiptSequence(),
				ackRequestSeq: args.request.requestSeq,
				executionSha256: this.config.executionSha256,
				cohortObservationEvidenceBase64: encoded,
				cohortObservationEvidenceSha256: sha256HexOfBytes(evidenceBytes),
				cohortObservationEvidenceSize: evidenceBytes.byteLength,
				terminalExport: true,
			},
		};
	}

	/**
	 * Derive the manifest, process proof, series, ledger and capacity, and retain
	 * their exact bytes. Idempotent, so a controller may ask for the admission
	 * receipt's digest before it asks for the export that carries it.
	 */
	private ensureDerivedRecords(): ProtocolResult<{
		readonly ledger: CohortLedgerV1;
	}> {
		const manifest = this.buildOrderedPartialManifest();
		if (!manifest.ok) return manifest;
		const proof = this.buildObservedProcessProof();
		if (!proof.ok) return proof;
		const derived = this.buildDerivedRecords();
		if (!derived.ok) return derived;
		this.retain("orderedPartialManifest", bytesOfCanonical(manifest.value));
		this.retain("observedProcessProof", bytesOfCanonical(proof.value));
		this.retain("rateSeries", bytesOfCanonical(derived.value.rateSeries));
		this.retain("ledger", bytesOfCanonical(derived.value.ledger));
		this.retain("capacity", bytesOfCanonical(derived.value.capacity));
		return { ok: true, value: { ledger: derived.value.ledger } };
	}

	/**
	 * Mint the admission receipt. Every digest field is read out of the retained
	 * map; the ledger totals are the recomputed ones. Callable before export so a
	 * controller can name the receipt it is about to ask for.
	 */
	buildAdmissionReceipt(args: {
		readonly issuedAtMs: number;
		readonly notAfterMs: number;
	}): ProtocolResult<CohortAdmissionReceiptV1> {
		const grant = this.grantValue;
		if (grant === null) return notReadyFail("no cohort grant");
		const derived = this.ensureDerivedRecords();
		if (!derived.ok) return derived;
		const digestOf = (key: string): Sha256Hex | null =>
			this.retained.get(key)?.retained.sha256 ?? null;
		const keys = [
			"cohortGrant",
			"cohortGrantSignature",
			"rigCohortAcceptance",
			"rigCohortAcceptanceSignature",
			"tokenCommitmentLeafManifest",
			"cohortWarmupEpoch",
			"cohortWarmupEpochSignature",
			"roleWarmupCompletionManifest",
			"roleWarmupCompletionManifestSignature",
			"serverWarmupDrained",
			"rigWarmupDrainedReceipt",
			"rigWarmupDrainedReceiptSignature",
			"rigMeasureStartAck",
			"rigMeasureStartAckSignature",
			"cohortStartBarrier",
			"cohortStartBarrierSignature",
			"rigBarrierAcceptance",
			"rigBarrierAcceptanceSignature",
			"serverStartBarrierAccepted",
			"orderedPartialManifest",
			"observedProcessProof",
			"linuxRelayObservation",
			"rigRelayObservationReceipt",
			"rigRelayObservationReceiptSignature",
			"rateSeries",
			"ledger",
			"capacity",
		];
		const digests = new Map<string, Sha256Hex>();
		for (const key of keys) {
			const digest = digestOf(key);
			if (digest === null) return notReadyFail(`${key} is not retained`);
			digests.set(key, digest);
		}
		const get = (key: string): Sha256Hex => digests.get(key) as Sha256Hex;
		return parseCohortAdmissionReceipt({
			schema: "cohort-admission-receipt/v1",
			executionSha256: this.config.executionSha256,
			measurementGrantSha256: this.config.executionJoins.measurementGrantSha256,
			macExecutionGrantReceiptSha256:
				this.config.executionJoins.macExecutionGrantReceiptSha256,
			cohortGrantSha256: get("cohortGrant"),
			cohortGrantSignatureSha256: get("cohortGrantSignature"),
			rigCohortAcceptanceSha256: get("rigCohortAcceptance"),
			rigCohortAcceptanceSignatureSha256: get("rigCohortAcceptanceSignature"),
			tokenCommitmentLeafManifestSha256: get("tokenCommitmentLeafManifest"),
			cohortWarmupEpochSha256: get("cohortWarmupEpoch"),
			cohortWarmupEpochSignatureSha256: get("cohortWarmupEpochSignature"),
			roleWarmupCompletionManifestSha256: get("roleWarmupCompletionManifest"),
			roleWarmupCompletionManifestSignatureSha256: get(
				"roleWarmupCompletionManifestSignature",
			),
			serverWarmupDrainedSha256: get("serverWarmupDrained"),
			rigWarmupDrainedReceiptSha256: get("rigWarmupDrainedReceipt"),
			rigWarmupDrainedReceiptSignatureSha256: get(
				"rigWarmupDrainedReceiptSignature",
			),
			rigMeasureStartAckSha256: get("rigMeasureStartAck"),
			rigMeasureStartAckSignatureSha256: get("rigMeasureStartAckSignature"),
			cohortStartBarrierSha256: get("cohortStartBarrier"),
			cohortStartBarrierSignatureSha256: get("cohortStartBarrierSignature"),
			rigBarrierAcceptanceSha256: get("rigBarrierAcceptance"),
			rigBarrierAcceptanceSignatureSha256: get("rigBarrierAcceptanceSignature"),
			serverStartBarrierAcceptedSha256: get("serverStartBarrierAccepted"),
			orderedPartialManifestSha256: get("orderedPartialManifest"),
			observedProcessProofSha256: get("observedProcessProof"),
			linuxRelayObservationSha256: get("linuxRelayObservation"),
			rigRelayObservationReceiptSha256: get("rigRelayObservationReceipt"),
			rigRelayObservationReceiptSignatureSha256: get(
				"rigRelayObservationReceiptSignature",
			),
			rigServerSnapshotReceiptSha256:
				this.config.executionJoins.rigServerSnapshotReceiptSha256,
			rigServerSnapshotReceiptSignatureSha256:
				this.config.executionJoins.rigServerSnapshotReceiptSignatureSha256,
			macMeasurementAdmissionReceiptSha256:
				this.config.executionJoins.macMeasurementAdmissionReceiptSha256,
			macMeasurementAdmissionSignatureSha256:
				this.config.executionJoins.macMeasurementAdmissionSignatureSha256,
			rateSeriesSha256: get("rateSeries"),
			ledgerSha256: get("ledger"),
			capacitySha256: get("capacity"),
			approvedPlanSha256: grant.approvedPlanSha256,
			approvalRecordSha256: grant.approvalRecordSha256,
			publisherCount: this.topology.publisherCount,
			workerCount: COHORT_WORKER_COUNT,
			subscriberCount: this.topology.subscriberCount,
			offeredIngress: derived.value.ledger.offeredIngress,
			serverAcceptedIngress: derived.value.ledger.serverAcceptedIngress,
			linuxRelayWritesCompleted: derived.value.ledger.linuxRelayWritesCompleted,
			delivered: derived.value.ledger.delivered,
			macSupervisorInstanceNonce: this.config.macSupervisorInstanceNonce,
			signingPublicKeySha256: sha256HexOfBytes(this.config.macKeys.publicRaw32),
			receiptSequence: this.receiptSequence + 1,
			issuedAtMs: args.issuedAtMs,
			notAfterMs: args.notAfterMs,
		});
	}

	/** Assemble the export from retained members only; no argument reaches it. */
	private assembleEvidence(): ProtocolResult<CohortObservationEvidenceV1> {
		const member = (key: string): RetainedCanonicalBytesV1 | null =>
			this.retained.get(key)?.retained ?? null;
		const need = (key: string): RetainedCanonicalBytesV1 => {
			const value = member(key);
			if (value === null) throw new Error(`missing retained member ${key}`);
			return value;
		};
		const ordered = this.orderedPartialRecords();
		if (!ordered.ok) return ordered;
		const warmupCompletes: RetainedCanonicalBytesV1[] = [];
		for (const childId of this.orderedChildIds()) {
			const retained = this.warmupCompletes.get(childId);
			if (retained === undefined) {
				return notReadyFail(`${childId} warmup completion is not retained`);
			}
			warmupCompletes.push(retained.retained);
		}
		let evidence: CohortObservationEvidenceV1;
		try {
			evidence = {
				schema: "cohort-observation-evidence/v1",
				workloadRolePlanInput: need("workloadRolePlanInput"),
				cohortGrant: need("cohortGrant"),
				cohortGrantSignature: need("cohortGrantSignature"),
				rigCohortAcceptance: need("rigCohortAcceptance"),
				rigCohortAcceptanceSignature: need("rigCohortAcceptanceSignature"),
				tokenCommitmentLeafManifest: need("tokenCommitmentLeafManifest"),
				cohortWarmupEpoch: need("cohortWarmupEpoch"),
				cohortWarmupEpochSignature: need("cohortWarmupEpochSignature"),
				roleWarmupCompletionManifest: need("roleWarmupCompletionManifest"),
				roleWarmupCompletionManifestSignature: need(
					"roleWarmupCompletionManifestSignature",
				),
				roleWarmupCompletes: warmupCompletes,
				serverWarmupDrained: need("serverWarmupDrained"),
				rigWarmupDrainedReceipt: need("rigWarmupDrainedReceipt"),
				rigWarmupDrainedReceiptSignature: need(
					"rigWarmupDrainedReceiptSignature",
				),
				rigMeasureStartAck: need("rigMeasureStartAck"),
				rigMeasureStartAckSignature: need("rigMeasureStartAckSignature"),
				cohortStartBarrier: need("cohortStartBarrier"),
				cohortStartBarrierSignature: need("cohortStartBarrierSignature"),
				rigBarrierAcceptance: need("rigBarrierAcceptance"),
				rigBarrierAcceptanceSignature: need("rigBarrierAcceptanceSignature"),
				serverStartBarrierAccepted: need("serverStartBarrierAccepted"),
				publisherPartials: ordered.value
					.filter((item) => item.kind === "publisher")
					.map((item) => item.retained.retained),
				workerPartials: ordered.value
					.filter((item) => item.kind === "worker")
					.map((item) => item.retained.retained),
				orderedPartialManifest: need("orderedPartialManifest"),
				observedProcessProof: need("observedProcessProof"),
				linuxRelayObservation: need("linuxRelayObservation"),
				rigRelayObservationReceipt: need("rigRelayObservationReceipt"),
				rigRelayObservationReceiptSignature: need(
					"rigRelayObservationReceiptSignature",
				),
				rateSeries: need("rateSeries"),
				ledger: need("ledger"),
				capacity: need("capacity"),
				cohortAdmissionReceipt: need("cohortAdmissionReceipt"),
				cohortAdmissionSignature: need("cohortAdmissionSignature"),
			};
		} catch (error: unknown) {
			return notReadyFail(String(error));
		}
		// Re-parse what we are about to hand out, with the same parser the
		// controller and the offline verifier will use.
		const validated = parseCohortObservationEvidence({
			evidence,
			expectedPublisherCount: this.topology.publisherCount,
			expectedSubscriberCount: this.topology.subscriberCount,
			expectedExecutionSha256: this.config.executionSha256,
			expectedCohortGrantSha256: this.grantSha256Value as Sha256Hex,
		});
		if (!validated.ok) return validated;
		return { ok: true, value: evidence };
	}

	// -- 7. bounded reap on every terminal path -------------------------------

	private reapGroups(
		groups: readonly {
			readonly childId: string;
			readonly pid: number;
			readonly pgid: number;
			readonly cohortAttempt: number;
		}[],
		terminalPath: MacFanoutTerminalPath,
	): ProtocolResult<MacFanoutTeardownResultV1> {
		const records: MacFanoutReapRecordV1[] = [];
		for (const group of groups) {
			const signalsSent: MacFanoutSignal[] = [];
			this.config.processControl.killPgid(group.pgid, "SIGTERM");
			signalsSent.push("SIGTERM");
			let reaped = this.config.processControl.waitPgid(
				group.pgid,
				MAC_FANOUT_REAP_DEADLINE_MS,
			);
			if (!reaped) {
				this.config.processControl.killPgid(group.pgid, "SIGKILL");
				signalsSent.push("SIGKILL");
				reaped = this.config.processControl.waitPgid(
					group.pgid,
					MAC_FANOUT_REAP_DEADLINE_MS,
				);
			}
			if (!reaped) {
				return macFail(
					"CHILD_LIFECYCLE",
					`process group ${group.pgid} survived SIGKILL and the ${MAC_FANOUT_REAP_DEADLINE_MS} ms wait`,
				);
			}
			records.push({
				childId: group.childId,
				pid: group.pid,
				pgid: group.pgid,
				cohortAttempt: group.cohortAttempt,
				signalsSent,
				reaped: true,
			});
		}
		return {
			ok: true,
			value: {
				terminalPath,
				records,
				reapedPgids: records.map((record) => record.pgid),
				allReaped: true,
			},
		};
	}

	/**
	 * Every terminal path reaps the same set: the live cohort plus any process
	 * group abandoned by a pre-readiness replacement. Idempotent, because a
	 * signal handler and a normal return can both reach it.
	 */
	teardown(
		terminalPath: MacFanoutTerminalPath,
	): ProtocolResult<MacFanoutTeardownResultV1> {
		if (this.teardownResult !== null) {
			return { ok: true, value: this.teardownResult };
		}
		if (!MAC_FANOUT_TERMINAL_PATHS.includes(terminalPath)) {
			return protocolFail(`unknown terminal path ${String(terminalPath)}`);
		}
		const groups = [
			...this.retiredGroups,
			...[...this.children.values()].map((child) => ({
				childId: child.plan.childId,
				pid: child.pid,
				pgid: child.pgid,
				cohortAttempt: this.attempt,
			})),
		];
		const reaped = this.reapGroups(groups, terminalPath);
		if (!reaped.ok) return reaped;
		for (const sealed of this.sealedFds) sealed.close();
		this.sealedFds.length = 0;
		this.teardownResult = reaped.value;
		return reaped;
	}

	/** Every process group this supervisor has ever owned, live or abandoned. */
	get ownedPgids(): readonly number[] {
		return [
			...this.retiredGroups.map((group) => group.pgid),
			...[...this.children.values()].map((child) => child.pgid),
		];
	}
}
