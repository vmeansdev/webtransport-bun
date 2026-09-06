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
	spawnSync as nodeSpawnSync,
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
	read as nodeFsRead,
	write as nodeFsWrite,
	openSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	assertChildInboundSequence,
	assertChildOutboundSequence,
	type ChildSequenceState,
	createChildSequenceState,
	decodeRoleChildFrame,
	encodeRoleChildFrame,
	RoleChildFrameReader,
	roleChildMaxFramesPerDirection,
} from "./child-pipe-protocol.ts";
import {
	COHORT_MAX_CONNECTIONS_IN_FLIGHT,
	COHORT_NOT_READY_FAILURE_CODE,
	COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES,
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
	expectedWarmupDeliveries,
	expectedWarmupIngress,
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
	type PublisherRoleGrantV1,
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
	parseStagedServerLaunchRecord,
	parseTokenBundle,
	parseTokenBundleFdObservation,
	parseTokenCommitmentLeafManifest,
	parseWorkerPartial,
	permitNotBeforeMacNs,
	type RetainedCanonicalBytesV1,
	RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	type RigBarrierAcceptanceV1,
	type RigCohortAcceptanceV1,
	type RigRelayObservationReceiptV1,
	type RigWarmupDrainedReceiptV1,
	ROLE_CHILD_FRAME_MAX_BYTES,
	type RolePartialAcceptedV1,
	type RoleWarmupCompleteV1,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	recomputeRootFromLeafManifest,
	resolveGlobalOrdinal,
	type SubscriberShardV1,
	TOKEN_BUNDLE_FD,
	TOKEN_BUNDLE_FILE_MODE,
	type TokenBundleEntryV1,
	type TokenBundleFdObservationV1,
	type TokenBundleV1,
	type TokenCommitmentLeafManifestV1,
	type TokenCommitmentLeafV1,
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
	assertRemoteResponseSeq,
	type Base64,
	bytesOfCanonical,
	type CampaignFailureCode,
	COHORT_EVIDENCE_EXPORT_MAX_DECODED_BYTES,
	COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES,
	CohortEvidenceBudget,
	type CrossSupervisorExecutionV1,
	createMemoryReplayLedger,
	createRemoteSequenceState,
	decodeRegisteredRemotePayload,
	encodeRegisteredRemotePayload,
	isCampaignFailureCode,
	isCohortRemoteSchema,
	type MacCohortEvidenceExportedAckV1,
	type MacCohortOpenedAckV1,
	type MacExecutionGrantReceiptV1,
	type MacExecutionOpenedAckV1,
	type MacMeasurementAdmissionIssuedAckV1,
	type MacReceiptSignatureV1,
	type MacRigBarrierAcceptanceAckV1,
	type MacRigCohortAcceptanceAckV1,
	type MacStartBarrierIssuedAckV1,
	type MacWarmupCompletionManifestExportedAckV1,
	type MacWarmupEpochIssuedAckV1,
	type NsString,
	type ProtocolResult,
	parseCohortRemotePayload,
	parseMacExecutionGrantReceipt,
	parseMacReceiptSignature,
	parsePhaseAMacRemotePayload,
	parsePhaseARigRemotePayload,
	parseRemoteSupervisorRefusal,
	parseRigExecutionAcceptance,
	parseRigReceiptSignature,
	type RemoteSequenceState,
	type ReplayLedger,
	type ReplayLedgerSide,
	RIG_SPAWN_SERVER_REQUEST_MAX_BYTES,
	type RigExecutionAcceptanceV1,
	type RigReceiptSignatureV1,
	remotePayloadBoundForSchema,
	type Sha256Hex,
	STAGED_MAC_PUBLIC_KEY_LEAF,
	STAGED_RIG_PUBLIC_KEY_LEAF,
	sha256CanonicalRecord,
	takeRemoteRequestSeq,
	verifyCohortExportAckSignature,
	verifyMacReceiptSignature,
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
	/**
	 * The two campaign-scoped cohort descriptors (design §2.9(4), review
	 * NEW-3), all-or-none: the Mac Ed25519 PKCS#8 DER and the staged rig
	 * public key. Present exactly when this supervisor is the Mac cohort
	 * signer; absent for a Phase-A / bootstrap-only spawn, which holds no
	 * private key on any descriptor.
	 */
	readonly cohort?: MacCohortDescriptors;
	/**
	 * The two cohort descriptors a **rig** supervisor installs its cohort
	 * runtime from (`comparison-supervisor.rs` `cohort_install_descriptors`:
	 * `--cohort-signing-key-fd` and `--cohort-role-root-fd`, both or neither,
	 * else `TRUST_DESCRIPTOR_ARGUMENT_INVALID`). Present exactly when this
	 * supervisor is the rig; a supervisor is one role, so a spawn naming both
	 * this and `cohort` is refused before any script is built.
	 */
	readonly rigCohort?: RigCohortDescriptors;
}

/** One descriptor the launcher opens by path and the child inherits by number. */
export interface SupervisorPathFd extends SupervisorFd {
	/** The path the *wrapper* opens — never a path the supervisor can name. */
	readonly path: string;
}

/**
 * §2.9(4)'s two-descriptor option table. Two, all-or-none: a present-but-
 * incomplete pair is `TRUST_DESCRIPTOR_ARGUMENT_INVALID` on the binary side,
 * and the type makes it unrepresentable on this one.
 */
export interface MacCohortDescriptors {
	/** fd 7 — `$COMPARISON_MAC_SIGNING_KEY`, mode 0400 owner `_wtcompare`. */
	readonly macSigningKey: SupervisorPathFd;
	/** fd 8 — `staging-root/rig-supervisor-ed25519.pub`. */
	readonly stagedRigPublicKey: SupervisorPathFd;
	/**
	 * The validity window every receipt this signer mints states (design
	 * §2.9(2), row 19). The binary refuses to install its cohort runtime
	 * without `WS_WT_COHORT_RECEIPT_VALIDITY_MS` (`comparison-supervisor.rs`,
	 * "supervisor mac cohort runtime requires"), and a uid crossing's
	 * `env_reset` drops the controller's environment, so the wrapper exports
	 * it beside the descriptors rather than relying on inheritance.
	 */
	readonly receiptValidityMs: number;
}

/**
 * The rig's two install descriptors (design §3.1 "booted the way the rig
 * wrapper boots it, with `--cohort-signing-key-fd` … `--cohort-role-root-fd`").
 * The binary reads the key bytes off the first (`read_all_from_fd`, 4 KiB
 * bound) and `fchdir`s every server child into the second before exec, so
 * the launch record's argv resolves against it and the supervisor never
 * names a path for the thing it executes.
 */
export interface RigCohortDescriptors {
	/** The rig Ed25519 PKCS#8 DER (`$COMPARISON_RIG_SIGNING_KEY`), mode 0400. */
	readonly signingKey: SupervisorPathFd;
	/** The directory holding the staged role entrypoints (`$RIG_STAGE/roles`). */
	readonly roleRoot: SupervisorPathFd;
}

/**
 * The bootstrap paths a supervisor wrapper opens, in one of two shapes. The
 * shape is decided by the platform the root was staged on, never by an
 * environment switch:
 *
 * - **two roots** — the Mac (`mac-campaign` + `mac-staging`), and the darwin
 *   local-acceptance rig of design §3.1, which boots from the Mac's own pair;
 * - **one root** — the Linux rig. The 2026-08-24 amendment models the Linux
 *   supervisor with a single retained staging handle ("the trusted Linux
 *   supervisor, which already retains its staging handle"; lock and
 *   capability "through its retained Linux staging-root handle"), and the
 *   authority declares exactly one Linux root, `linux-staging`. So
 *   `stagingRootDir` is that directory — `COMPARISON_RIG_STAGED_DIR`, the
 *   `observe-linux --root` — holding the lock, capability and manifest leaves
 *   directly, and no campaign root exists to open: the wrapper emits no
 *   `--campaign-root-fd`, and the binary's Linux arm reads all three trust
 *   records through the staging handle while its darwin arm refuses the
 *   single-root argv (`resolve_descriptors`, `comparison-supervisor.rs`).
 */
export interface TwoRootTrustBootstrapPaths {
	readonly authorityFile: string;
	readonly authorityDigestFile: string;
	readonly campaignRootDir: string;
	readonly stagingRootDir: string;
}

export interface SingleRootTrustBootstrapPaths {
	readonly authorityFile: string;
	readonly authorityDigestFile: string;
	readonly stagingRootDir: string;
	readonly campaignRootDir?: undefined;
}

export type RigTrustBootstrapPaths =
	| TwoRootTrustBootstrapPaths
	| SingleRootTrustBootstrapPaths;

/** The name both binaries read the Bun they will launch from. */
export const SUPERVISOR_BUN_PATH_ENV = "COMPARISON_SUPERVISOR_BUN_PATH";

/** The name the Mac binary reads its receipt validity window from. */
export const MAC_RECEIPT_VALIDITY_ENV = "WS_WT_COHORT_RECEIPT_VALIDITY_MS";

/**
 * The account the Mac supervisor runs as when it holds a signing key.
 * Plan 238 fixes the key's owner; `bin/stage-live-campaign.ts:1025-1026`
 * writes `COMPARISON_MAC_SUPERVISOR_USER=_wtcompare` into the frozen run
 * command, which is the value this default matches.
 */
export const MAC_SUPERVISOR_DEFAULT_USER = "_wtcompare";

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
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_COHORT_ROLE_AMBIGUOUS";
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
 *   1. Opens the trust-bootstrap files at their known paths on the rig
 *      (paths the staging step in Phase 3.6.0 published to both hosts),
 *      getting OS FD numbers: the authority pipe on 3, its digest on 4, and
 *      either both roots (5 campaign, 6 staging) or the one Linux root on 6
 *      (`RigTrustBootstrapPaths`).
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
		/** The rig-side paths the staging step published (three or four). */
		readonly rigPaths: RigTrustBootstrapPaths;
		/** The full path to the supervisor binary on the rig. */
		readonly rigBinaryPath: string;
		/**
		 * Present exactly when this script is handed to a *different uid*.
		 *
		 * The lines it adds are design §2.9(4a) rows 13-15, and every one of
		 * them exists because `sudo` — not `ssh` — is what runs the script:
		 * sudoers' `umask` replaces the caller's (row 13), `secure_path`
		 * replaces `PATH` (row 14), and the child inherits a cwd the target uid
		 * may not be able to traverse (row 15). Row 10 (the environment) is
		 * not tier-specific: `env_reset` drops it under `sudo` and `SendEnv`
		 * drops it under `ssh`, so the wrapper exports it on every path.
		 */
		readonly uidCrossing?: { readonly targetUser: string };
	},
): { readonly ok: true; readonly script: string } | SpawnRefusal {
	const fdCheck = assertDistinctFds(options);
	if (!fdCheck.ok) return fdCheck;
	if (options.cohort !== undefined && options.rigCohort !== undefined) {
		return {
			ok: false,
			code: "SPAWN_COHORT_ROLE_AMBIGUOUS",
			message:
				"a supervisor is the Mac cohort signer or the rig, never both: " +
				"`cohort` and `rigCohort` were both given",
		};
	}

	// Rows 15 and 13: establish the cwd, then the mode mask the reverse
	// crossing depends on. Only a uid crossing needs them.
	const crossing =
		options.uidCrossing === undefined
			? ""
			: `cd /
umask 007
`;
	// Row 10: the one variable both binaries require
	// (`comparison-supervisor.rs` "supervisor toolchain observation required:
	// set COMPARISON_SUPERVISOR_BUN_PATH"). The wrapper is the spawn's one
	// environment authority on every tier and on both hosts: `sudo`'s
	// `env_reset` drops the controller's environment on the Mac, and `ssh`
	// forwards only `SendEnv` names to the rig (`ssh -G <host>` on this Mac
	// lists `LANG` and `LC_*`, nothing else), so inheritance never carries it.
	const bunPathExport = `export ${SUPERVISOR_BUN_PATH_ENV}=${shellQuote(options.bunExecutablePath)}
`;
	// Row 14: the wrapper's one PATH lookup. Absolute under a uid crossing,
	// because `secure_path` decides `PATH` there and the script must depend on
	// no environment at all.
	const catCommand = options.uidCrossing === undefined ? "cat" : "/bin/cat";
	const cohort = options.cohort;
	if (
		cohort !== undefined &&
		(!Number.isSafeInteger(cohort.receiptValidityMs) ||
			cohort.receiptValidityMs <= 0)
	) {
		throw new RangeError("receiptValidityMs must be a positive integer");
	}
	const cohortOpens =
		cohort === undefined
			? ""
			: `export ${MAC_RECEIPT_VALIDITY_ENV}=${cohort.receiptValidityMs}
exec ${cohort.macSigningKey.fd}<${shellQuote(cohort.macSigningKey.path)}
exec ${cohort.stagedRigPublicKey.fd}<${shellQuote(cohort.stagedRigPublicKey.path)}
`;
	const cohortFlags =
		cohort === undefined
			? ""
			: ` \\
  --cohort-mac-signing-key-fd ${cohort.macSigningKey.fd} \\
  --cohort-staged-rig-public-key-fd ${cohort.stagedRigPublicKey.fd}`;
	// The rig's pair, opened exactly as `cohort_install_descriptors` reads
	// them: the key on one descriptor, the role root directory on the other.
	// A directory opens read-only like any file; the binary `fchdir`s to it.
	const rigCohort = options.rigCohort;
	if (rigCohort !== undefined) {
		for (const descriptor of [rigCohort.signingKey, rigCohort.roleRoot]) {
			if (!descriptor.path.startsWith("/")) {
				throw new RangeError(
					`rig cohort descriptor ${descriptor.label} needs an absolute path, got ${JSON.stringify(descriptor.path)}`,
				);
			}
		}
	}
	const rigCohortOpens =
		rigCohort === undefined
			? ""
			: `exec ${rigCohort.signingKey.fd}<${shellQuote(rigCohort.signingKey.path)}
exec ${rigCohort.roleRoot.fd}<${shellQuote(rigCohort.roleRoot.path)}
`;
	const rigCohortFlags =
		rigCohort === undefined
			? ""
			: ` \\
  --cohort-signing-key-fd ${rigCohort.signingKey.fd} \\
  --cohort-role-root-fd ${rigCohort.roleRoot.fd}`;

	// Every bootstrap path is opened by the wrapper alone, under `set -eu`
	// and (on a uid crossing) from `cd /`: a relative one would resolve
	// against a cwd the script does not own.
	const rigPaths = options.rigPaths;
	for (const [label, path] of Object.entries(rigPaths)) {
		if (label === "campaignRootDir" && path === undefined) continue;
		if (typeof path !== "string" || !path.startsWith("/")) {
			throw new RangeError(
				`rig bootstrap path ${label} needs an absolute path, got ${JSON.stringify(path)}`,
			);
		}
	}
	// The root shape (`RigTrustBootstrapPaths`): a campaign root is opened on
	// 5 and named to the binary exactly when the staging produced one; the
	// Linux rig's single root goes on 6 alone and the binary is told nothing
	// about a campaign root, so its Linux arm boots from the staging handle
	// and its darwin arm refuses the argv.
	const campaignRootDir = rigPaths.campaignRootDir;
	const rootVars =
		campaignRootDir === undefined
			? "staging_root_fd=6\n"
			: "campaign_root_fd=5\nstaging_root_fd=6\n";
	const rootOpens =
		campaignRootDir === undefined
			? `exec 6<${shellQuote(rigPaths.stagingRootDir)}\n`
			: `exec 5<${shellQuote(campaignRootDir)}\nexec 6<${shellQuote(rigPaths.stagingRootDir)}\n`;
	const rootFlags =
		campaignRootDir === undefined
			? ` \\
  --staging-root-fd "\${staging_root_fd}"`
			: ` \\
  --campaign-root-fd "\${campaign_root_fd}" \\
  --staging-root-fd "\${staging_root_fd}"`;

	// The script pipes authority bytes (anonymous pipe — regular files are
	// refused by TRUST_AUTHORITY_PIPE_*), opens the digest + the directory
	// root(s), then exec's the supervisor with fixed child slots 3..6 and
	// control on SSH stdin/stdout (0/1). Uses bash for process substitution.
	const script = `#!/usr/bin/env bash
set -eu
${crossing}${bunPathExport}authority_fd=3
authority_digest_fd=4
${rootVars}exec 3< <(${catCommand} -- ${shellQuote(rigPaths.authorityFile)})
exec 4<${shellQuote(rigPaths.authorityDigestFile)}
${rootOpens}${cohortOpens}${rigCohortOpens}exec ${shellQuote(options.rigBinaryPath)} \\
  --authority-fd "\${authority_fd}" \\
  --authority-digest-fd "\${authority_digest_fd}"${rootFlags} \\
  --control-in-fd 0 \\
  --control-out-fd 1${cohortFlags}${rigCohortFlags}
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
	if (options.cohort !== undefined) {
		all.push(options.cohort.macSigningKey, options.cohort.stagedRigPublicKey);
	}
	if (options.rigCohort !== undefined) {
		// Both or neither on the binary side; a pair with a hole is a missing
		// descriptor here, named by the slot that is empty.
		for (const [slot, descriptor] of [
			["rigCohort.signingKey", options.rigCohort.signingKey],
			["rigCohort.roleRoot", options.rigCohort.roleRoot],
		] as const) {
			if (descriptor === undefined || descriptor === null) {
				return {
					ok: false,
					code: "SPAWN_BOOTSTRAP_FD_MISSING",
					message: `rig cohort descriptor ${slot} is missing`,
				};
			}
			all.push(descriptor);
		}
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
		// Neither Node nor Bun exposes `getpgid(2)`, and §2.9(4e)'s spawn
		// assertion has to read the group from the kernel rather than infer it
		// from having passed `detached: true`.
		getpgid: {
			args: [FFIType.i32],
			returns: FFIType.i32,
		},
	},
);

/**
 * The process group of `pid`, read from the kernel. `-1` when the pid is gone.
 * `processGroupIdOf(0)` is this process's own group.
 */
export function processGroupIdOf(pid: number): number {
	return libc.symbols.getpgid(pid);
}

/** This process's own group — the one stage 3 must never signal. */
export function controllerProcessGroupId(): number {
	return libc.symbols.getpgid(0);
}

/**
 * §2.9(4e): the spawn-time assertion, separated from the spawn so the refusal
 * can be driven with the numbers a *non*-detached spawn really produces.
 *
 * Without `detached: true` the child sits in the controller's group, and
 * `kill -- -<pgid>` at teardown would signal the controller, the rig
 * supervisor and every role child — ending the campaign that issued it. The
 * assertion is the regression guard; the spawn option alone is not.
 */
export function assertDisjointProcessGroup(handle: {
	readonly pid: number;
	readonly pgid: number;
}):
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly code: "SPAWN_PROCESS_GROUP_NOT_DISJOINT";
			readonly message: string;
	  } {
	const controller = controllerProcessGroupId();
	if (handle.pgid <= 0) {
		return {
			ok: false,
			code: "SPAWN_PROCESS_GROUP_NOT_DISJOINT",
			message: `supervisor pid ${handle.pid} has no readable process group`,
		};
	}
	if (handle.pgid === controller) {
		return {
			ok: false,
			code: "SPAWN_PROCESS_GROUP_NOT_DISJOINT",
			message:
				`supervisor pid ${handle.pid} shares process group ${handle.pgid} ` +
				`with the controller; the spawn must be detached`,
		};
	}
	return { ok: true };
}

/** What a control command (the liveness probe, a forced stop) reported. */
export interface ControlCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
}

/**
 * §2.9(4e): the *reading* of the target-uid liveness probe, not just the
 * command.
 *
 * > Non-zero exit means the group is gone — `EPERM` included. Zero means alive.
 *
 * The `EPERM` half is the counter-intuitive one. On Darwin a process group
 * whose every member is a zombie answers `EPERM` to `kill(-pgid, 0)` — for
 * signal 0 as much as for a real signal — because an exited process no longer
 * carries the credentials the permission check reads (measured, and recorded
 * at `remote-supervisor.ts:5729-5740`). Reading `EPERM` as *alive* is what
 * makes a bounded reap unbounded: the poll would spin to its deadline every
 * time. The premise that makes `EPERM` unambiguous is that the probe runs **as
 * the group's own owner**, so it can never mean "a stranger's group" — which
 * is precisely why `processGroupAlive` (`:5742`), which probes from the
 * controller, cannot be reused across this boundary.
 */
export function readGroupLivenessProbe(
	result: ControlCommandResult,
): "alive" | "gone" {
	return result.exitCode === 0 ? "alive" : "gone";
}

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
	/**
	 * The OS PID the supervisor's process started at. Under a uid crossing
	 * this is **`sudo`'s** pid — sudo may exec in place or fork and relay —
	 * which is why nothing addresses a signal at it.
	 */
	readonly pid: number;
	/**
	 * The process group the spawn established (§2.9(4e)). Stage 3 and S9's
	 * reap assertion name this number instead of each deriving one.
	 */
	readonly pgid: number;
	/**
	 * Present when the process runs as another uid, naming the account that
	 * owns it — the account the liveness probe and the forced stop must run as.
	 */
	readonly uidCrossing?: { readonly targetUser: string };
	/** Which host this supervisor lives on. */
	readonly host: "mac" | "rig";
	/**
	 * Process handle used by `stopSupervisor`. Both spawns use Node
	 * `child_process`, so `controllerToSupervisor`/`supervisorToController`
	 * are real Node streams the framing code can drive.
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
	/**
	 * The child's retained stderr tail and exit status. Handed to every
	 * channel built on this handle so a failed exchange can say whether the
	 * process is still there and, if not, what it said on the way out.
	 */
	readonly diagnostics?: SupervisorChildDiagnostics;
}

/** Minimal process surface the supervisor children are driven through. */
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

/**
 * How much of a supervisor child's stderr a post-mortem carries.
 *
 * The child's diagnostics are not evidence — only the framed channel is — but
 * a supervisor that dies before its first frame says why on stderr and
 * nowhere else, so the tail is retained and quoted in the refusal. Bounded,
 * because a talkative ssh must not turn a refusal message into a log dump.
 */
export const SUPERVISOR_STDERR_TAIL_MAX_BYTES = 4_096;

/** How a supervisor child stopped: a status, or a signal that killed it. */
export interface SupervisorChildExitV1 {
	readonly code: number | null;
	readonly signal: string | null;
}

/**
 * What a spawned supervisor's process said and how it ended.
 *
 * Held by the spawn and read by every control exchange, so a channel that
 * cannot get an answer can state whether the process is still there and, when
 * it is not, name the status and the last thing it wrote.
 */
export interface SupervisorChildDiagnostics {
	/** Null while the child is still running; its exit otherwise. */
	exit(): SupervisorChildExitV1 | null;
	/** The last `SUPERVISOR_STDERR_TAIL_MAX_BYTES` the child wrote. */
	stderrTail(): string;
}

/**
 * Drain the child's stderr into a bounded tail and record its exit.
 *
 * Draining is not optional: an undrained stderr pipe blocks the child once
 * the kernel buffer fills. What is new here is that the bytes are kept, so
 * the reason a supervisor exited before its first frame survives the exit.
 */
export function attachSupervisorChildDiagnostics(
	child: ChildProcessWithoutNullStreams,
): SupervisorChildDiagnostics {
	let tail = Buffer.alloc(0);
	child.stderr?.on("data", (chunk: Buffer) => {
		tail = Buffer.concat([tail, Buffer.from(chunk)]);
		if (tail.byteLength > SUPERVISOR_STDERR_TAIL_MAX_BYTES) {
			tail = tail.subarray(tail.byteLength - SUPERVISOR_STDERR_TAIL_MAX_BYTES);
		}
	});
	let exit: SupervisorChildExitV1 | null = null;
	child.once("exit", (code, signal) => {
		exit = { code: code ?? null, signal: signal ?? null };
	});
	return {
		exit: () => exit,
		stderrTail: () => tail.toString("utf8"),
	};
}

/**
 * The post-mortem a refusal carries, or "" when the spawn kept none.
 *
 * Every control failure that has diagnostics states them: a read timeout on a
 * process that exited 69 an hour ago is a different fact from a read timeout
 * on a process that is alive and simply slow, and the controller used to
 * report both as the same five-second wait.
 */
export function describeSupervisorChildDeath(
	diagnostics: SupervisorChildDiagnostics | undefined,
): string {
	if (diagnostics === undefined) return "";
	const exit = diagnostics.exit();
	const tail = diagnostics.stderrTail();
	const stderr =
		tail.length === 0
			? "stderr empty"
			: `stderr tail (${Buffer.byteLength(tail, "utf8")} bytes): ${tail}`;
	if (exit === null) return `child still running; ${stderr}`;
	return `child exited code=${exit.code ?? "none"} signal=${exit.signal ?? "none"}; ${stderr}`;
}

/**
 * Wait until the child proves it survived its own startup, or died trying.
 *
 * Both supervisors bootstrap synchronously — trust roots, the uid crossing,
 * toolchain observation — and only then enter the serve loop, so a process
 * still alive at the end of this window has passed every step that can refuse
 * before a frame. Resolves the moment the child exits; the window is the
 * upper bound, not the cost of a healthy spawn's failure path.
 */
async function awaitSupervisorReadiness(
	diagnostics: SupervisorChildDiagnostics,
	readinessMs: number,
): Promise<{ readonly alive: boolean }> {
	const until = Date.now() + Math.max(0, readinessMs);
	for (;;) {
		if (diagnostics.exit() !== null) return { alive: false };
		if (Date.now() >= until) return { alive: diagnostics.exit() === null };
		await Bun.sleep(Math.min(25, Math.max(1, until - Date.now())));
	}
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
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_UID_SEAM_REFUSED";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_PROCESS_GROUP_NOT_DISJOINT";
			readonly message: string;
	  }
	| {
			readonly ok: false;
			readonly code: "SPAWN_CHILD_EXITED";
			readonly message: string;
	  };

/**
 * How a Mac supervisor spawn crosses (or does not cross) the uid boundary.
 *
 * - `a` — the real boundary: `sudo -n -u _wtcompare`, a 0400 key at plan 238's
 *   path, and §3.3's assertions 3 and 5 made for real.
 * - `b` — the named seam: the controller uid, a key under the campaign scratch
 *   root, reachable only with **both** `COMPARISON_MAC_SUPERVISOR_UID_SEAM=1`
 *   and that path condition, so the production path (whose frozen run command
 *   sets neither) cannot fall into it.
 * - `phase-a` — no cohort descriptors at all: no private key is on any
 *   descriptor, so there is nothing for the boundary to protect (§2.9(4b),
 *   "Phase A is unaffected").
 */
export type MacSupervisorSpawnTier = "a" | "b" | "phase-a";

/** Everything `spawnMacSupervisor` will hand to `execve`, and nothing else. */
export interface MacSupervisorSpawnPlan {
	readonly command: string;
	readonly argv: readonly string[];
	readonly script: string;
	readonly tier: MacSupervisorSpawnTier;
	/** The account the process will run as; absent when it is the controller's. */
	readonly targetUser?: string;
}

/** The extra inputs a Mac spawn needs beyond the shared spawn options. */
export interface MacSupervisorSpawnInputs {
	/** The four local paths the staging step published. */
	readonly localPaths: {
		readonly authorityFile: string;
		readonly authorityDigestFile: string;
		readonly campaignRootDir: string;
		readonly stagingRootDir: string;
	};
	/**
	 * Ask for tier B. Refused unless the campaign scratch root really contains
	 * the key **and** `COMPARISON_MAC_SUPERVISOR_UID_SEAM=1`.
	 */
	readonly controllerUidSeam?: { readonly campaignScratchRoot: string };
}

/**
 * Pure helper: the argv form of §2.9(4)'s option (iv).
 *
 * `sudo -n -u <user> /bin/bash -c <script text>` — the script travels as
 * **argv**, delivered by `execve`, and is never a filesystem object. Option
 * (i) (a file in the staged tree) breaks §9's immutability; option (ii)
 * (`bash -s`) consumes stdin, which *is* the control channel; option (iii)
 * (exec the binary directly) cannot establish descriptors, which only a shell
 * can. The cost is that the script text is visible in `ps` argv: it carries
 * the binary path, the key *path* and the fd layout, every one of which is
 * already world-readable in the mode-0444 frozen run command (plan 2684/2886).
 * No key *bytes* are in it, and a named test asserts that.
 */
export function buildMacSupervisorSpawnPlan(
	options: SupervisorSpawnOptions & MacSupervisorSpawnInputs,
):
	| { readonly ok: true; readonly plan: MacSupervisorSpawnPlan }
	| LiveSpawnRefusal {
	const tier = resolveMacSupervisorTier(options);
	if (!tier.ok) return tier;
	const wrapper = buildRigSupervisorWrapperScript({
		...options,
		rigPaths: options.localPaths,
		rigBinaryPath: options.binaryPath,
		...(tier.targetUser === undefined
			? {}
			: { uidCrossing: { targetUser: tier.targetUser } }),
	});
	if (!wrapper.ok) return wrapper;
	if (tier.targetUser === undefined) {
		return {
			ok: true,
			plan: {
				command: "/bin/bash",
				argv: ["-c", wrapper.script],
				script: wrapper.script,
				tier: tier.tier,
			},
		};
	}
	return {
		ok: true,
		plan: {
			command: "/usr/bin/sudo",
			argv: ["-n", "-u", tier.targetUser, "/bin/bash", "-c", wrapper.script],
			script: wrapper.script,
			tier: tier.tier,
			targetUser: tier.targetUser,
		},
	};
}

/**
 * Which uid runs this spawn, decided by what is on the descriptors rather than
 * by a flag: a spawn that carries the Mac signing key crosses to the account
 * that owns it, and only the two-condition seam can hold it back.
 */
function resolveMacSupervisorTier(
	options: SupervisorSpawnOptions & MacSupervisorSpawnInputs,
):
	| {
			readonly ok: true;
			readonly tier: MacSupervisorSpawnTier;
			readonly targetUser?: string;
	  }
	| LiveSpawnRefusal {
	if (options.cohort === undefined) {
		if (options.controllerUidSeam !== undefined) {
			return {
				ok: false,
				code: "SPAWN_UID_SEAM_REFUSED",
				message:
					"the tier-B seam was requested for a spawn that carries no cohort " +
					"descriptors; there is no key for it to move",
			};
		}
		return { ok: true, tier: "phase-a" };
	}
	if (options.controllerUidSeam === undefined) {
		return {
			ok: true,
			tier: "a",
			targetUser:
				process.env.COMPARISON_MAC_SUPERVISOR_USER ??
				MAC_SUPERVISOR_DEFAULT_USER,
		};
	}
	if (process.env.COMPARISON_MAC_SUPERVISOR_UID_SEAM !== "1") {
		return {
			ok: false,
			code: "SPAWN_UID_SEAM_REFUSED",
			message:
				"tier B needs COMPARISON_MAC_SUPERVISOR_UID_SEAM=1 as well as a key " +
				"inside the campaign scratch root; the variable is not set",
		};
	}
	const root = resolve(options.controllerUidSeam.campaignScratchRoot);
	const key = resolve(options.cohort.macSigningKey.path);
	if (key !== root && !key.startsWith(`${root}${sep}`)) {
		return {
			ok: false,
			code: "SPAWN_UID_SEAM_REFUSED",
			message:
				`tier B refuses ${key}: it is outside the campaign scratch root ` +
				`${root}, so the seam would move the boundary rather than the key`,
		};
	}
	return { ok: true, tier: "b" };
}

/**
 * Spawn the Mac-resident supervisor locally, under the uid that owns its key.
 *
 * Bun.spawn does not reliably remap arbitrary parent FDs onto fixed child
 * slots for this binary's trust bootstrap, so Mac spawn matches the rig
 * pattern: a bash wrapper opens the trust roots (authority over an anonymous
 * pipe), then `exec`s the supervisor with `--control-in-fd 0` /
 * `--control-out-fd 1`. The controller's `stdin`/`stdout` pipes ARE the
 * control channel, and they are the one thing that crosses the uid boundary
 * as an open descriptor (§2.9(4a) row 12) — by construction, because stage 1
 * of the shutdown is closing fd 0.
 *
 * The wrapper is **argv, not a file** (§2.9(4) form (iv)). Revision 3 wrote it
 * `0700` into `tmpdir()`, which on macOS is `/var/folders/<hash>/T`,
 * `drwx------` and per-user by construction: `_wtcompare` cannot traverse it,
 * so `/bin/bash <scriptPath>` fails at exec, before fd 3 is opened and before
 * the key is touched. Mode alone cannot fix that; the directory is the
 * problem. As argv there is no filesystem object at all, so there is nothing
 * to digest-pin, nothing to unlink and nothing to leak between runs.
 *
 * `detached: true` is `setsid(2)` — the same property
 * `createMacFanoutRoleChildHost` states at `:6152` for every role child — so
 * the supervisor's group is disjoint from the controller's and the forced stop
 * can name it without naming the campaign.
 *
 * Returns a `SupervisorHandle` the caller stores; `stopSupervisor(handle)`
 * winds it down and reports whether it was reaped.
 */
/**
 * Upper bound on the Mac readiness wait. The child is local: the whole
 * bootstrap is a `sudo` exec plus the trust reads, and a failure resolves the
 * wait at the child's exit rather than at this bound.
 */
const MAC_SUPERVISOR_READINESS_MS = 500;

export async function spawnMacSupervisor(
	options: SupervisorSpawnOptions &
		MacSupervisorSpawnInputs & {
			/**
			 * When true (default), wire control over bash stdin/stdout.
			 * Set false only for bootstrap-only probes (wrapper still opens
			 * control FDs 0/1 against `/dev/null` so the resident loop can
			 * exit immediately after toolchain observation — unused today).
			 */
			readonly controlChannel?: boolean;
			/** Upper bound on the readiness wait; defaults to the Mac's. */
			readonly readinessMs?: number;
		},
): Promise<
	{ readonly ok: true; readonly handle: SupervisorHandle } | LiveSpawnRefusal
> {
	const wantControl = options.controlChannel !== false;
	const planned = buildMacSupervisorSpawnPlan(options);
	if (!planned.ok) return planned;
	const plan = planned.plan;

	let child: ChildProcessWithoutNullStreams;
	try {
		child = nodeSpawn(plan.command, [...plan.argv], {
			stdio: wantControl
				? ["pipe", "pipe", "pipe"]
				: ["ignore", "ignore", "pipe"],
			detached: true,
			// No environment of its own: the wrapper exports the Bun path (row
			// 10) on both tiers, and a second source here would be the one the
			// binary never reads under tier A.
		}) as ChildProcessWithoutNullStreams;
	} catch (error) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `node spawn(${plan.command}) failed: ${(error as Error).message}`,
		};
	}

	const proc = wrapNodeChild(child);
	const pgid = processGroupIdOf(proc.pid);
	const handle: SupervisorHandle = {
		pid: proc.pid,
		pgid,
		host: "mac",
		subprocess: proc,
		bootstrapFds: [],
		controlParentFds: [],
		...(plan.targetUser === undefined
			? {}
			: { uidCrossing: { targetUser: plan.targetUser } }),
		...(wantControl
			? {
					controllerToSupervisor: child.stdin,
					supervisorToController: child.stdout,
				}
			: {}),
	};

	// §2.9(4e): refuse before any frame is sent. Without this a future edit
	// that drops `detached` silently re-arms the campaign-wide self-kill.
	const disjoint = assertDisjointProcessGroup(handle);
	if (!disjoint.ok) {
		await stopSupervisor(handle, 2_000);
		return disjoint;
	}

	// Drain stderr so a failed bootstrap cannot block on a full pipe, and keep
	// the tail: it is the only place a supervisor that never reaches the serve
	// loop says why.
	const diagnostics = attachSupervisorChildDiagnostics(child);

	// Bootstrap is synchronous; a dead child here means the uid crossing, the
	// trust roots or toolchain observation failed before the resident loop.
	const readiness = await awaitSupervisorReadiness(
		diagnostics,
		options.readinessMs ?? MAC_SUPERVISOR_READINESS_MS,
	);
	if (!readiness.alive) {
		return {
			ok: false,
			code: "SPAWN_CHILD_EXITED",
			message: `mac supervisor died before its first frame: ${describeSupervisorChildDeath(diagnostics)}`,
		};
	}

	return { ok: true, handle: { ...handle, diagnostics } };
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
	options: SupervisorSpawnOptions & RigSshSpawnInputs,
):
	| {
			readonly ok: true;
			readonly sshArgv: readonly string[];
			readonly wrapperScript: string;
	  }
	| SpawnRefusal {
	// The wrapper's own crossing lines (rows 13-15) follow the spawn's.
	const wrapper = buildRigSupervisorWrapperScript(options);
	if (!wrapper.ok) return wrapper;
	// `-T`: no pty, stdin/stdout ARE the supervisor's control FDs;
	// `bash -s`: read the wrapper (process substitution) from stdin.
	const sshArgv: readonly string[] = [...RIG_SSH_PREFIX(options), "bash", "-s"];
	return { ok: true, sshArgv, wrapperScript: wrapper.script };
}

/** The ssh session options every rig spawn shares. */
export interface RigSshSpawnInputs {
	readonly rigPaths: RigTrustBootstrapPaths;
	readonly rigBinaryPath: string;
	readonly sshTarget: string;
	readonly sshIdentity: string;
	/**
	 * Present when the rig's descriptors can only be opened by another
	 * account: staging installs the rig signing key mode 0400 owned by
	 * `_wtcompare` and proves the ssh user cannot read it
	 * (`bin/stage-live-campaign.ts`, the `chown`/`test ! -r` pair after the
	 * rig key mint), so the wrapper must run as that owner. Same form (iv) as
	 * the Mac: the script travels as `sudo … /bin/bash -c <argv>` inside the
	 * ssh command and is never a file the target uid would have to read.
	 */
	readonly uidCrossing?: { readonly targetUser: string };
}

const RIG_SSH_PREFIX = (options: RigSshSpawnInputs): readonly string[] => [
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
];

/**
 * Pure helper: the ssh argv that *runs* the rig supervisor, once the wrapper
 * is in place. Without a uid crossing the wrapper was uploaded to
 * `remoteWrapperPath` and runs as the ssh user; with one, the script is the
 * argv of `sudo -n -u <user> /bin/bash -c`, single-quoted for the remote
 * login shell that ssh hands the joined command to.
 */
export function buildRigSshRunArgv(
	options: SupervisorSpawnOptions & RigSshSpawnInputs,
	remoteWrapperPath: string,
):
	| {
			readonly ok: true;
			readonly runArgv: readonly string[];
			readonly wrapperScript: string;
	  }
	| SpawnRefusal {
	const built = buildRigSshArgv(options);
	if (!built.ok) return built;
	const prefix = RIG_SSH_PREFIX(options);
	if (options.uidCrossing === undefined) {
		return {
			ok: true,
			runArgv: [...prefix, "bash", remoteWrapperPath],
			wrapperScript: built.wrapperScript,
		};
	}
	return {
		ok: true,
		runArgv: [
			...prefix,
			"sudo",
			"-n",
			"-u",
			options.uidCrossing.targetUser,
			"/bin/bash",
			"-c",
			shellQuote(built.wrapperScript),
		],
		wrapperScript: built.wrapperScript,
	};
}

/**
 * Spawn the Linux-resident supervisor over SSH.
 *
 * The wrapper script cannot share stdin with the control channel (`bash -s`
 * would consume stdin before `exec`), so this helper:
 *   1. Uploads the wrapper to a temp path on the rig over SSH — unless the
 *      spawn crosses a uid, in which case the script travels as argv
 *      (`RigSshSpawnInputs.uidCrossing`) and nothing is uploaded.
 *   2. Starts a second SSH session whose stdin/stdout ARE the supervisor's
 *      `--control-in-fd 0` / `--control-out-fd 1`.
 */
/**
 * How the rig's ssh client is started. Injected only so a test can drive the
 * handle's control pipes without an ssh hop; production passes none and gets
 * `nodeSpawn`, the same source `spawnMacSupervisor` uses.
 */
export type RigChildSpawner = (
	command: string,
	argv: readonly string[],
) => ChildProcessWithoutNullStreams;

/**
 * Refuse a control pair the framing code cannot drive.
 *
 * `writeAll` resolves from `Writable.write`'s completion callback and
 * `readControlFrame` drives `Readable.read` and its `"readable"`/`"end"`
 * events. `Bun.spawn`'s pipes answer neither -- a `FileSink` takes the
 * callback and never calls it, a `ReadableStream` has no `read` -- so a cast
 * to `Writable`/`Readable` turns the first frame into a wait with no end.
 * Named here so a wrong pipe shape is a typed spawn refusal instead.
 */
export function controlPipeShapeRefusal(
	stdin: unknown,
	stdout: unknown,
): string | null {
	const writable = stdin as { write?: unknown; once?: unknown } | null;
	if (
		typeof writable?.write !== "function" ||
		typeof writable.once !== "function"
	) {
		return "controllerToSupervisor is not a node Writable (no write/once); writeAll would never complete";
	}
	const readable = stdout as { read?: unknown; once?: unknown } | null;
	if (
		typeof readable?.read !== "function" ||
		typeof readable.once !== "function"
	) {
		return "supervisorToController is not a node Readable (no read/once); readControlFrame cannot drive it";
	}
	return null;
}

/** Bound on the wrapper upload, the one ssh hop before the supervisor runs. */
const RIG_WRAPPER_UPLOAD_DEADLINE_MS = 30_000;

/**
 * Upper bound on the rig readiness wait. Paid once per campaign, and only
 * when the supervisor lives: a child that dies resolves the wait at its exit.
 * Generous next to an ssh hop, and nowhere near any frame deadline.
 */
const RIG_SUPERVISOR_READINESS_MS = 2_000;

/**
 * The production rig spawner: `nodeSpawn`, not `Bun.spawn`, for the same
 * reason `spawnMacSupervisor` uses it -- the control channel is framed over
 * node streams, and Bun's pipe objects (`FileSink`, `ReadableStream`) cannot
 * answer that framing.
 */
export function spawnRigSshChild(
	command: string,
	argv: readonly string[],
): ChildProcessWithoutNullStreams {
	return nodeSpawn(command, [...argv], {
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
}

export async function spawnRigSupervisor(
	options: SupervisorSpawnOptions &
		RigSshSpawnInputs & {
			readonly spawnChild?: RigChildSpawner;
			/** Upper bound on the readiness wait; defaults to the rig's. */
			readonly readinessMs?: number;
		},
): Promise<
	{ readonly ok: true; readonly handle: SupervisorHandle } | LiveSpawnRefusal
> {
	const remoteWrapper = `/tmp/ws-wt-rig-supervisor-wrapper.$$`;
	const built = buildRigSshRunArgv(options, remoteWrapper);
	if (!built.ok) return built;

	if (options.uidCrossing === undefined) {
		const uploadArgv = [
			...RIG_SSH_PREFIX(options),
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
			// Bounded for the same reason the run's own ssh steps are: an ssh
			// that never returns would otherwise hold the spawn open forever.
			let uploadTimedOut = false;
			const uploadTimer = setTimeout(() => {
				uploadTimedOut = true;
				try {
					upload.kill("SIGKILL");
				} catch {
					// ignore: the child may have exited already
				}
			}, RIG_WRAPPER_UPLOAD_DEADLINE_MS);
			const uploadCode = await upload.exited;
			clearTimeout(uploadTimer);
			if (uploadTimedOut) {
				return {
					ok: false,
					code: "SPAWN_BINARY_OPEN_FAILED",
					message: `rig wrapper upload exceeded ${RIG_WRAPPER_UPLOAD_DEADLINE_MS}ms`,
				};
			}
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
	}

	const [runCommand, ...runArgs] = [...built.runArgv];
	if (runCommand === undefined) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: "rig supervisor argv is empty",
		};
	}
	const spawnChild = options.spawnChild ?? spawnRigSshChild;
	let child: ChildProcessWithoutNullStreams;
	try {
		// The local process is the ssh client; nothing in its environment
		// reaches the rig (`SendEnv` carries `LANG`/`LC_*` only). The wrapper
		// exports the Bun path itself.
		child = spawnChild(runCommand, runArgs);
	} catch (error) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `rig supervisor ssh spawn failed: ${(error as Error).message}`,
		};
	}

	const proc = wrapNodeChild(child);
	const shapeRefusal = controlPipeShapeRefusal(child.stdin, child.stdout);
	if (shapeRefusal !== null) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// ignore
		}
		return {
			ok: false,
			code: "SPAWN_PIPE_FAILED",
			message: `rig supervisor spawn: ${shapeRefusal}`,
		};
	}

	// Drain stderr so a talkative ssh cannot block the rig on a full pipe --
	// the same reason `spawnMacSupervisor` drains its child's. The bytes are
	// kept: they are the only place a supervisor that dies before its first
	// frame says why, and discarding them is what made the r1 campaign report
	// four identical five-second read timeouts with no cause anywhere.
	const diagnostics = attachSupervisorChildDiagnostics(child);

	// The announcement follows evidence. The rig's bootstrap is synchronous
	// (trust roots, uid crossing, toolchain observation) and ssh exits with
	// the remote command, so a child still alive here has passed every step
	// that can refuse before a frame; one that is gone is refused by name
	// instead of costing one frame deadline per arm.
	const readiness = await awaitSupervisorReadiness(
		diagnostics,
		options.readinessMs ?? RIG_SUPERVISOR_READINESS_MS,
	);
	if (!readiness.alive) {
		return {
			ok: false,
			code: "SPAWN_CHILD_EXITED",
			message: `rig supervisor died before its first frame: ${describeSupervisorChildDeath(diagnostics)}`,
		};
	}

	return {
		ok: true,
		handle: {
			diagnostics,
			pid: proc.pid,
			// The local process is the `ssh` client, which runs as the
			// controller and in the controller's group. It is deliberately NOT
			// detached: nothing signals this group, and stage 3 refuses to.
			pgid: processGroupIdOf(proc.pid),
			host: "rig",
			subprocess: proc,
			bootstrapFds: [],
			controllerToSupervisor: child.stdin,
			supervisorToController: child.stdout,
			controlParentFds: [],
		},
	};
}

/** Which stage of §2.9(4d) the supervisor actually stopped at. */
export type SupervisorStopStage = "control-channel-eof" | "forced-group-stop";

/** The verdict `stopSupervisor` returns — reaped, or the stage that timed out. */
export type SupervisorStopResult =
	| {
			readonly ok: true;
			readonly exitCode: number;
			readonly reaped: true;
			readonly stoppedBy: SupervisorStopStage;
			/** Everything the supervisor wrote before its channel reached EOF. */
			readonly finalBytes: Uint8Array;
	  }
	| {
			readonly ok: false;
			readonly code: "SUPERVISOR_NOT_REAPED";
			readonly stoppedBy: SupervisorStopStage;
			readonly message: string;
			readonly finalBytes: Uint8Array;
	  };

export interface SupervisorStopOptions {
	/**
	 * Runs the target-uid liveness probe and the forced stop. Injected only so
	 * a test can drive stage 3 without a real group; production passes none and
	 * gets `runControlCommandLocally`.
	 */
	readonly runControlCommand?: (
		argv: readonly string[],
	) => ControlCommandResult;
	/** Bound on stage 3 alone. Defaults to `min(deadlineMs, 2000)`. */
	readonly forcedDeadlineMs?: number;
}

function runControlCommandLocally(
	argv: readonly string[],
): ControlCommandResult {
	const [command, ...rest] = argv;
	const out = nodeSpawnSync(command as string, rest, { encoding: "utf8" });
	return { exitCode: out.status ?? -1, stderr: (out.stderr ?? "").trim() };
}

/**
 * Collect what the supervisor writes on its way out, without closing its
 * channel. Stage 1 is a **half-close**, so this side keeps reading.
 */
function collectFinalBytes(stream: Readable | undefined): {
	readonly bytes: () => Uint8Array;
	readonly ended: () => boolean;
} {
	const chunks: Buffer[] = [];
	let ended = stream === undefined;
	if (stream !== undefined && typeof stream.on === "function") {
		stream.on("data", (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk));
		});
		stream.on("end", () => {
			ended = true;
		});
		stream.on("close", () => {
			ended = true;
		});
		stream.on("error", () => {
			ended = true;
		});
	} else {
		// A rig handle carries a Bun `ReadableStream` cast to `Readable`; if a
		// frame reader already holds it there is nothing to collect here.
		ended = true;
	}
	return {
		bytes: () => new Uint8Array(Buffer.concat(chunks)),
		ended: () => ended,
	};
}

async function waitFor(
	predicate: () => boolean,
	deadlineMs: number,
): Promise<boolean> {
	const until = Date.now() + Math.max(0, deadlineMs);
	for (;;) {
		if (predicate()) return true;
		if (Date.now() >= until) return false;
		await new Promise((r) => setTimeout(r, 25));
	}
}

/**
 * §2.9(4d): bounded, three-stage supervisor shutdown that reports whether the
 * process was **reaped** rather than whether a signal was issued.
 *
 * 1. **Graceful — a half-close.** `controllerToSupervisor.end()` and nothing
 *    else: the supervisor's fd 0 reaches EOF (the serve loop breaks on
 *    `Ok(None)` at `comparison-supervisor.rs:641` at this HEAD (the design cites
 *    the pre-wave `:604-606`), then falls through to
 *    `teardown_cohort()`), while its fd 1 stays open and this side keeps
 *    reading. Closing a pipe needs no matching uid. Tearing down the *output*
 *    channel here instead would leave the supervisor's last frames — every
 *    failure arm calls `self.terminate(writer, code)` — writing into a broken
 *    pipe, and the controller would silently discard what it said.
 * 2. **Reap proof.** A bounded wait on the child's own exit. Under a uid
 *    crossing that child is `sudo`, which does not exit until *its* child
 *    does, whether it execs or forks — so observing it **is** the waitpid
 *    proof.
 * 3. **Forced.** `sudo -n -u <user> /bin/kill -TERM -- -<pgid>` then `-KILL`,
 *    addressed at the supervisor's **own** group, with liveness read as the
 *    target uid (`readGroupLivenessProbe`). Never `SIGKILL` at `handle.pid`:
 *    in sudo's fork mode that kills the *waiter* without reaping its child,
 *    orphaning the supervisor to launchd while this function reported it
 *    reaped — the exact false verdict the stage exists to eliminate.
 *
 * `closeOwnedFds()` runs **after** the reap, where releasing the bootstrap fds
 * and the parent's control copies is correct because nothing is left to say.
 */
export async function stopSupervisor(
	handle: SupervisorHandle,
	deadlineMs: number,
	options?: SupervisorStopOptions,
): Promise<SupervisorStopResult> {
	const runControlCommand =
		options?.runControlCommand ?? runControlCommandLocally;
	const forcedDeadlineMs =
		options?.forcedDeadlineMs ?? Math.min(Math.max(deadlineMs, 0), 2_000);
	const proc = handle.subprocess;
	const collected = collectFinalBytes(handle.supervisorToController);

	const closeOwnedFds = (): void => {
		// The stream goes first and closes the descriptor it owns. Under Bun a
		// `ReadStream.destroy()` closes its fd even with `autoClose: false`, and
		// it does so after this call returns; closing that number here first
		// would free it for reuse, and the stream's late close would then land
		// on whatever reused it (the cascaded-EBADF signature). So only the
		// descriptors the stream does not own are closed here, after it.
		const stream = handle.supervisorToController;
		const streamFdValue = (stream as { readonly fd?: unknown } | undefined)?.fd;
		const streamFd = typeof streamFdValue === "number" ? streamFdValue : null;
		try {
			stream?.destroy();
		} catch {
			// ignore
		}
		for (const fd of handle.bootstrapFds) {
			if (fd !== streamFd) safeClose(fd);
		}
		for (const fd of handle.controlParentFds) {
			if (fd !== streamFd) safeClose(fd);
		}
	};

	// -- stage 1: half-close, and nothing else -----------------------------
	try {
		handle.controllerToSupervisor?.end();
	} catch {
		// already ended; the supervisor has its EOF either way
	}

	// -- stage 2: the reap proof -------------------------------------------
	let reaped = await waitFor(() => proc.exitCode !== null, deadlineMs);
	if (reaped) {
		// Give the output channel a moment to reach EOF so the final frame is
		// in hand before the descriptors go.
		await waitFor(() => collected.ended(), 250);
		closeOwnedFds();
		return {
			ok: true,
			exitCode: proc.exitCode ?? -1,
			reaped: true,
			stoppedBy: "control-channel-eof",
			finalBytes: collected.bytes(),
		};
	}

	// -- stage 3: forced, addressed at the group ---------------------------
	const target = `-${handle.pgid}`;
	const user = handle.uidCrossing?.targetUser;
	const disjoint = assertDisjointProcessGroup(handle);
	if (!disjoint.ok) {
		if (user !== undefined) {
			closeOwnedFds();
			return {
				ok: false,
				code: "SUPERVISOR_NOT_REAPED",
				stoppedBy: "forced-group-stop",
				message:
					`refusing the forced stop: ${disjoint.message}. Signalling this ` +
					`process group would end the campaign that issued the teardown.`,
				finalBytes: collected.bytes(),
			};
		}
		// No uid crossing and no group of its own: the rig's local `ssh` client,
		// which this process owns. Signal the process, never the group, and
		// never with SIGKILL.
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		reaped = await waitFor(() => proc.exitCode !== null, forcedDeadlineMs);
		await waitFor(() => collected.ended(), 100);
		closeOwnedFds();
		return reaped
			? {
					ok: true,
					exitCode: proc.exitCode ?? -1,
					reaped: true,
					stoppedBy: "forced-group-stop",
					finalBytes: collected.bytes(),
				}
			: {
					ok: false,
					code: "SUPERVISOR_NOT_REAPED",
					stoppedBy: "forced-group-stop",
					message: `pid ${handle.pid} did not exit after SIGTERM`,
					finalBytes: collected.bytes(),
				};
	}
	const alive = (): boolean => {
		if (proc.exitCode !== null) return false;
		if (user === undefined) return processGroupIdOf(handle.pid) > 0;
		return (
			readGroupLivenessProbe(
				runControlCommand([
					"/usr/bin/sudo",
					"-n",
					"-u",
					user,
					"/bin/kill",
					"-0",
					"--",
					target,
				]),
			) === "alive"
		);
	};
	const signal = (name: "-TERM" | "-KILL"): void => {
		if (user === undefined) {
			try {
				process.kill(-handle.pgid, name === "-TERM" ? "SIGTERM" : "SIGKILL");
			} catch {
				// ESRCH / EPERM both mean the group is finished (see
				// `readGroupLivenessProbe`); anything else is not actionable here.
			}
			return;
		}
		runControlCommand([
			"/usr/bin/sudo",
			"-n",
			"-u",
			user,
			"/bin/kill",
			name,
			"--",
			target,
		]);
	};

	signal("-TERM");
	reaped = await waitFor(
		() => proc.exitCode !== null || !alive(),
		Math.floor(forcedDeadlineMs / 2),
	);
	if (!reaped) {
		signal("-KILL");
		reaped = await waitFor(
			() => proc.exitCode !== null || !alive(),
			Math.ceil(forcedDeadlineMs / 2),
		);
	}
	await waitFor(() => collected.ended(), 100);
	closeOwnedFds();
	if (!reaped) {
		return {
			ok: false,
			code: "SUPERVISOR_NOT_REAPED",
			stoppedBy: "forced-group-stop",
			message:
				`process group ${handle.pgid} still holds a process after the ` +
				`forced stop; the supervisor was signalled but not reaped`,
			finalBytes: collected.bytes(),
		};
	}
	return {
		ok: true,
		exitCode: proc.exitCode ?? -1,
		reaped: true,
		stoppedBy: "forced-group-stop",
		finalBytes: collected.bytes(),
	};
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
		| "CONTROL_CHILD_EXITED"
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

/**
 * Bound a control-pipe write.
 *
 * `writeAll` resolves from the completion callback, and a pipe object that
 * never invokes it (or a peer that never drains) leaves that promise pending
 * forever. Every control write is a step in a deadline-governed exchange, so
 * the write carries the same deadline the answer does.
 */
export async function withWriteDeadline(
	write: Promise<void>,
	deadlineMs: number,
	what: string,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			write,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(new Error(`${what} did not complete in ${deadlineMs}ms`)),
					deadlineMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
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
	options?: {
		/**
		 * The spawn's view of the process on the other end. When it has
		 * already exited there is nothing left to wait for, so the read
		 * refuses at once and names the status and stderr instead of
		 * spending the frame deadline and reporting a timeout.
		 */
		readonly childDiagnostics?: SupervisorChildDiagnostics;
	},
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
	const diagnostics = options?.childDiagnostics;
	const childIsGone = (): ControlChannelRefusal | null =>
		diagnostics !== undefined && diagnostics.exit() !== null
			? {
					ok: false,
					code: "CONTROL_CHILD_EXITED",
					message: `supervisor ${describeSupervisorChildDeath(diagnostics)}`,
				}
			: null;
	const goneAtEntry = childIsGone();
	if (goneAtEntry !== null) return goneAtEntry;

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
			// A child that exited mid-wait ends the wait: whatever it was
			// going to say, it already said on stderr.
			const gone = childIsGone();
			if (gone !== null) return gone;
			if (readable.readableEnded) break;
			continue;
		}
		chunks.push(new Uint8Array(chunk));
		total += chunk.byteLength;
	}

	const final = tryDecode();
	if ("code" in final) return final;
	if (final.ok) return final;
	const goneAtExit = childIsGone();
	if (goneAtExit !== null) return goneAtExit;
	const postMortem = describeSupervisorChildDeath(diagnostics);
	return {
		ok: false,
		code: "CONTROL_FRAME_READ_TIMEOUT",
		message: `control frame read timed out after ${deadlineMs}ms${postMortem === "" ? "" : ` (${postMortem})`}`,
	};
}

async function writeControlFrame(
	writable: Writable,
	kind: string,
	payload: Uint8Array,
	payloadBound: number,
	deadlineMs: number,
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
		await withWriteDeadline(
			writeAll(writable, encoded.value),
			deadlineMs,
			`write ${kind}`,
		);
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
		deadlineMs,
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
		deadlineMs,
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
	// Released exactly once. The number is the kernel's to hand out again the
	// moment it closes, so a second `closeSync` on it would not be "already
	// closed" -- it would close whatever opened next (a later execution's
	// pipe, the process's own stderr), which is the cascaded-EBADF signature.
	let released = false;
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
				if (released) return;
				released = true;
				try {
					closeSync(readFd);
				} catch {
					/* the descriptor was never opened past this point */
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

// ---------------------------------------------------------------------------
// The controller <-> Mac cohort channel (amendment C4, design §2.9)
//
// The Mac supervisor is a process that alone holds the Mac signing key. This
// is the controller's client of that process, and it is deliberately only a
// client: every record the Mac mints comes back on a registered ack as exact
// bytes plus a signature the staged Mac public key must verify, and nothing
// here can produce a Mac-signed byte. Sequence numbers are the §3.3 pair,
// every frame is decoded at its registered bound, the per-execution evidence
// budget is charged before a bulk field is encoded or decoded, and the exact
// ack payload bytes the binary wrote are retained rather than re-encoded.
// ---------------------------------------------------------------------------

/** One bounded serial channel to the binary that alone holds the Mac key. */
export interface MacCohortChannelConfig {
	readonly controllerToMac: Writable;
	readonly macToController: Readable;
	/**
	 * The Mac spawn's view of the supervisor process, or `undefined` for a
	 * channel driven over scripted pipes. Required for the same reason the
	 * rig channel's is: the compiler asks every call site.
	 */
	readonly childDiagnostics: SupervisorChildDiagnostics | undefined;
	readonly stagedMacPublicRaw32: Uint8Array;
	readonly deadlineMs: number;
	/** The §2.9(2d) per-execution accounting; a fresh one unless shared. */
	readonly budget?: CohortEvidenceBudget;
}

/** A registered ack, with the exact payload bytes the binary wrote. */
export interface MacChannelAckV1<T> {
	readonly ack: T;
	readonly ackPayloadBytes: Uint8Array;
}

/** Exact record bytes and the verified Mac signature over them. */
export interface MacSignedRecordV1 {
	readonly bytes: Uint8Array;
	readonly signatureBytes: Uint8Array;
	readonly signature: MacReceiptSignatureV1;
}

/** What the Phase-A open returns once every binding has been checked. */
export interface MacExecutionOpenedV1 {
	readonly ack: MacExecutionOpenedAckV1;
	readonly ackPayloadBytes: Uint8Array;
	readonly executionSha256: Sha256Hex;
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionBytes: Uint8Array;
	readonly measurementGrantBytes: Uint8Array;
	readonly measurementGrantSha256: Sha256Hex;
	readonly receipt: MacExecutionGrantReceiptV1;
	readonly receiptBytes: Uint8Array;
	readonly receiptSignature: MacReceiptSignatureV1;
	readonly receiptSignatureBytes: Uint8Array;
}

/** The Phase-A observation frame, as exact bytes; null where §3.3 allows it. */
export interface MacRigObservationPresentationV1 {
	readonly rigExecutionAcceptanceBytes: Uint8Array;
	readonly rigExecutionAcceptanceSignatureBytes: Uint8Array;
	readonly rigMeasureStartAckBytes: Uint8Array;
	readonly rigMeasureStartAckSignatureBytes: Uint8Array;
	readonly rigBarrierAcceptanceBytes: Uint8Array | null;
	readonly rigBarrierAcceptanceSignatureBytes: Uint8Array | null;
	readonly serverWarmupDrainedBytes: Uint8Array | null;
	readonly serverStartBarrierAcceptedBytes: Uint8Array | null;
	readonly snapshotFrameBytes: Uint8Array;
	readonly rigServerSnapshotReceiptBytes: Uint8Array;
	readonly rigServerSnapshotReceiptSignatureBytes: Uint8Array;
	readonly linuxRelayObservationBytes: Uint8Array | null;
	readonly rigRelayObservationReceiptBytes: Uint8Array | null;
	readonly rigRelayObservationReceiptSignatureBytes: Uint8Array | null;
	readonly orderedPartialManifestBytes: Uint8Array | null;
	readonly observedProcessProofBytes: Uint8Array | null;
	readonly cohortRateSeriesBytes: Uint8Array | null;
	readonly cohortLedgerBytes: Uint8Array | null;
	readonly cohortCapacityBytes: Uint8Array | null;
}

/** MAC_JOIN's result: the two admissions the binary signed, verified here. */
export interface MacMeasurementAdmissionIssuedV1 {
	readonly ack: MacMeasurementAdmissionIssuedAckV1;
	readonly ackPayloadBytes: Uint8Array;
	readonly macMeasurementAdmission: MacSignedRecordV1;
	/** Null exactly when the binary answered null; a cohort caller refuses that. */
	readonly cohortAdmission: MacSignedRecordV1 | null;
}

/** The terminal export: the eight-field ack, signature already verified. */
export interface MacCohortEvidenceExportV1 {
	readonly ack: MacCohortEvidenceExportedAckV1;
	readonly ackPayloadBytes: Uint8Array;
}

function strictJsonOf(
	bytes: Uint8Array,
	what: string,
): ProtocolResult<unknown> {
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) return protocolFail(`${what} is not strict canonical JSON`);
	return { ok: true, value: json.value };
}

const base64OfBytes = (bytes: Uint8Array): Base64 =>
	Buffer.from(bytes).toString("base64") as Base64;

const base64OrNull = (bytes: Uint8Array | null): Base64 | null =>
	bytes === null ? null : base64OfBytes(bytes);

/** The payload region of one supervisor frame, exactly as it was written. */
function framePayloadBytes(frameBytes: Uint8Array): ProtocolResult<Uint8Array> {
	const decoded = decodeSupervisorFrame(frameBytes, frameBytes.byteLength);
	if (!decoded.ok) return protocolFail(`ack frame: ${decoded.code}`);
	if (decoded.value.consumed !== frameBytes.byteLength) {
		return protocolFail("ack frame carried trailing bytes");
	}
	return { ok: true, value: new Uint8Array(decoded.value.frame.payload) };
}

export class MacCohortChannel {
	readonly stagedMacPublicRaw32: Uint8Array;
	readonly budget: CohortEvidenceBudget;
	private readonly sequence = createRemoteSequenceState();
	private inFlight = false;
	private terminal = false;
	private executionSha: Sha256Hex | null = null;
	private openedValue: MacExecutionOpenedV1 | null = null;

	constructor(private readonly config: MacCohortChannelConfig) {
		if (config.stagedMacPublicRaw32.byteLength !== 32) {
			throw new RangeError("staged Mac public key must be 32 raw bytes");
		}
		if (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs <= 0) {
			throw new RangeError("Mac channel deadline must be a positive integer");
		}
		this.stagedMacPublicRaw32 = new Uint8Array(config.stagedMacPublicRaw32);
		this.budget = config.budget ?? new CohortEvidenceBudget();
	}

	get executionSha256(): Sha256Hex | null {
		return this.executionSha;
	}

	get openedExecution(): MacExecutionOpenedV1 | null {
		return this.openedValue;
	}

	get isTerminal(): boolean {
		return this.terminal;
	}

	/** The request seq the next frame will carry; a test pins the count. */
	get nextRequestSeq(): number {
		return this.sequence.requestSeq;
	}

	/**
	 * One request, one registered ack.
	 *
	 * Order matters and is the contract: the request is exact-key parsed under
	 * its registered caps, the budget is charged for its bulk fields, only then
	 * is it encoded and written. The ack is read at the bound of the kind its
	 * own header declares, refusals are surfaced with the binary's closed code,
	 * the kind and exact keys are checked, the sequence pair is checked, and
	 * the execution binding is checked. Any failure is terminal for the channel.
	 */
	async request<T extends { readonly schema: string }>(
		request: { readonly schema: string; readonly [key: string]: unknown },
		expectedSchema: T["schema"],
	): Promise<ProtocolResult<MacChannelAckV1<T>>> {
		if (this.terminal) return protocolFail("Mac channel is terminal");
		if (this.inFlight)
			return protocolFail("Mac channel has a request in flight");
		const bound = remotePayloadBoundForSchema(expectedSchema);
		if (bound === null) return protocolFail("unregistered Mac acknowledgment");
		const seq = takeRemoteRequestSeq(this.sequence);
		if (!seq.ok) return seq;
		const payload = { ...request, requestSeq: seq.value };
		const parsedRequest = isCohortRemoteSchema(payload.schema)
			? parseCohortRemotePayload(payload)
			: parsePhaseAMacRemotePayload(payload);
		if (!parsedRequest.ok) return parsedRequest;
		const charged = this.budget.charge(payload);
		if (!charged.ok) return charged;
		const encoded = encodeRegisteredRemotePayload(payload);
		if (!encoded.ok) return encoded;
		this.inFlight = true;
		try {
			const write = writeAll(this.config.controllerToMac, encoded.value);
			const deadline = new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Mac write deadline")),
					this.config.deadlineMs,
				);
				timer.unref();
			});
			await Promise.race([write, deadline]);
			const diagnostics = this.config.childDiagnostics;
			const frame = await readControlFrame(
				this.config.macToController,
				bound,
				this.config.deadlineMs,
				{
					...(diagnostics === undefined
						? {}
						: { childDiagnostics: diagnostics }),
				},
			);
			if (!frame.ok)
				return this.fail(protocolFail(`${frame.code}: ${frame.message}`));
			const decoded = decodeRegisteredRemotePayload(frame.frameBytes);
			if (!decoded.ok) return this.fail(decoded);
			const value = decoded.value.payload;
			if (value.schema === "remote-supervisor-refusal/v1") {
				const refusal = parseRemoteSupervisorRefusal(value);
				if (!refusal.ok) return this.fail(refusal);
				return this.fail(
					macFail(refusal.value.code, `Mac refused ${request.schema}`),
				);
			}
			if (
				value.schema !== expectedSchema ||
				decoded.value.headerKind !== expectedSchema.slice(0, -3)
			) {
				return this.fail(protocolFail("unexpected Mac acknowledgment kind"));
			}
			const parsedAck = isCohortRemoteSchema(expectedSchema)
				? parseCohortRemotePayload(value)
				: parsePhaseAMacRemotePayload(value);
			if (!parsedAck.ok) return this.fail(parsedAck);
			const sequence = assertRemoteResponseSeq(
				this.sequence,
				value.responseSeq as number,
				value.ackRequestSeq as number,
			);
			if (!sequence.ok) return this.fail(sequence);
			if (
				this.executionSha !== null &&
				value.executionSha256 !== this.executionSha
			) {
				return this.fail(
					macFail(
						"CROSS_SUPERVISOR_MISMATCH",
						"Mac acknowledgment names another execution",
					),
				);
			}
			const payloadBytes = framePayloadBytes(frame.frameBytes);
			if (!payloadBytes.ok) return this.fail(payloadBytes);
			// The binary writes canonical JSON; a payload that does not
			// re-canonicalize to itself is not an exact carrier of anything.
			if (
				sha256HexOfBytes(payloadBytes.value) !==
				sha256HexOfBytes(bytesOfCanonical(parsedAck.value))
			) {
				return this.fail(protocolFail("Mac acknowledgment is not canonical"));
			}
			if (expectedSchema === "mac-cohort-evidence-exported-ack/v1") {
				this.terminal = true;
			}
			return {
				ok: true,
				value: {
					ack: parsedAck.value as unknown as T,
					ackPayloadBytes: payloadBytes.value,
				},
			};
		} catch (error) {
			const described = describeSupervisorChildDeath(
				this.config.childDiagnostics,
			);
			return this.fail(
				protocolFail(
					`Mac channel: ${String(error)}${described === "" ? "" : ` (${described})`}`,
				),
			);
		} finally {
			this.inFlight = false;
		}
	}

	private fail<T>(result: ProtocolResult<T>): ProtocolResult<T> {
		this.terminal = true;
		return result;
	}

	/**
	 * Decode one signed record the binary returned: exact base64 on both
	 * halves, canonical JSON on both, the signature's `signedSchema` is the one
	 * the caller expects, and the signature verifies over the exact record
	 * bytes under the staged Mac public key. Nothing else verifies a Mac byte.
	 */
	signedRecord(
		bytesBase64: string,
		signatureBase64: string,
		schema: MacReceiptSignatureV1["signedSchema"],
	): ProtocolResult<MacSignedRecordV1> {
		const bytes = decodeBase64Exact(bytesBase64);
		const signatureBytes = decodeBase64Exact(signatureBase64);
		if (bytes === null || signatureBytes === null) {
			return protocolFail(`${schema}: noncanonical signed base64`);
		}
		const json = strictJsonOf(bytes, schema);
		if (!json.ok) return json;
		if (
			sha256HexOfBytes(bytesOfCanonical(json.value)) !== sha256HexOfBytes(bytes)
		) {
			return protocolFail(`${schema}: record is not canonically encoded`);
		}
		const sigJson = strictJsonOf(signatureBytes, `${schema} signature`);
		if (!sigJson.ok) return sigJson;
		const signature = parseMacReceiptSignature(sigJson.value);
		if (!signature.ok) return signature;
		if (signature.value.signedSchema !== schema) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				`Mac signature covers ${signature.value.signedSchema}, not ${schema}`,
			);
		}
		const checked = verifyMacReceiptSignature({
			stagedMacPublicRaw32: this.stagedMacPublicRaw32,
			signedBytes: bytes,
			signature: signature.value,
		});
		if (!checked.ok) return checked;
		return {
			ok: true,
			value: { bytes, signatureBytes, signature: signature.value },
		};
	}

	// -- Phase-A: MAC_EXECUTION_OPEN -----------------------------------------

	/**
	 * Offer the canonical draft; the binary chooses the ordinal, mints the
	 * measurement grant and signs `mac-execution-grant-receipt/v1`. Every
	 * binding on the way back is checked against the bytes this channel sent.
	 */
	async openExecution(
		executionDraftBytes: Uint8Array,
	): Promise<ProtocolResult<MacExecutionOpenedV1>> {
		if (this.openedValue !== null)
			return protocolFail("execution already opened");
		const draftBase64 = base64OfBytes(executionDraftBytes);
		const draftSha256 = sha256HexOfBytes(executionDraftBytes);
		const answered = await this.request<MacExecutionOpenedAckV1>(
			{
				schema: "mac-open-execution-request/v1",
				executionDraftSha256: draftSha256,
				executionDraftBase64: draftBase64,
			},
			"mac-execution-opened-ack/v1",
		);
		if (!answered.ok) return answered;
		const ack = answered.value.ack;
		if (ack.executionDraftBase64 !== draftBase64) {
			return this.fail(
				macFail("CROSS_SUPERVISOR_MISMATCH", "Mac changed the execution draft"),
			);
		}
		const grantBytes = decodeBase64Exact(ack.measurementGrantBase64);
		if (grantBytes === null) {
			return this.fail(protocolFail("measurement grant base64"));
		}
		const grantJson = strictJsonOf(grantBytes, "measurement grant");
		if (!grantJson.ok) return this.fail(grantJson);
		const grant = parseMeasurementGrant(grantJson.value);
		if (!grant.ok) {
			return this.fail(protocolFail(`measurement grant: ${grant.code}`));
		}
		const signed = this.signedRecord(
			ack.macExecutionGrantReceiptBase64,
			ack.macExecutionGrantSignatureBase64,
			"mac-execution-grant-receipt/v1",
		);
		if (!signed.ok) return this.fail(signed);
		const receiptJson = strictJsonOf(
			signed.value.bytes,
			"execution grant receipt",
		);
		if (!receiptJson.ok) return this.fail(receiptJson);
		const receipt = parseMacExecutionGrantReceipt(receiptJson.value);
		if (!receipt.ok) return this.fail(receipt);
		const executionBytes = bytesOfCanonical(receipt.value.execution);
		const executionSha256 = sha256HexOfBytes(executionBytes);
		const measurementGrantSha256 = sha256HexOfBytes(grantBytes);
		if (
			receipt.value.executionSha256 !== executionSha256 ||
			ack.executionSha256 !== executionSha256 ||
			receipt.value.execution.draftSha256 !== draftSha256 ||
			receipt.value.measurementGrantSha256 !== measurementGrantSha256 ||
			receipt.value.execution.measurementGrantSha256 !== measurementGrantSha256
		) {
			return this.fail(
				macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					"execution grant receipt is not joined to the draft and grant it carries",
				),
			);
		}
		this.executionSha = executionSha256;
		this.budget.openExecution(executionSha256);
		const opened: MacExecutionOpenedV1 = Object.freeze({
			ack,
			ackPayloadBytes: answered.value.ackPayloadBytes,
			executionSha256,
			execution: receipt.value.execution,
			executionBytes,
			measurementGrantBytes: grantBytes,
			measurementGrantSha256,
			receipt: receipt.value,
			receiptBytes: signed.value.bytes,
			receiptSignature: signed.value.signature,
			receiptSignatureBytes: signed.value.signatureBytes,
		});
		this.openedValue = opened;
		return { ok: true, value: opened };
	}

	// -- Phase-A: MAC_JOIN ----------------------------------------------------

	/**
	 * Present the rig graph and take back the two admissions. The frame
	 * carries records, never digests, so the binary recomputes every digest
	 * it binds; this side verifies both returned signatures under the staged
	 * key and hands the exact bytes up. Whether a null cohort half is
	 * acceptable is the caller's question: a cohort execution refuses it.
	 */
	async presentRigObservation(
		presentation: MacRigObservationPresentationV1,
	): Promise<ProtocolResult<MacMeasurementAdmissionIssuedV1>> {
		if (this.executionSha === null) {
			return notReadyFail("no execution is open on this Mac channel");
		}
		const answered = await this.request<MacMeasurementAdmissionIssuedAckV1>(
			{
				schema: "mac-present-rig-observation-request/v1",
				executionSha256: this.executionSha,
				rigExecutionAcceptanceBase64: base64OfBytes(
					presentation.rigExecutionAcceptanceBytes,
				),
				rigExecutionAcceptanceSignatureBase64: base64OfBytes(
					presentation.rigExecutionAcceptanceSignatureBytes,
				),
				rigMeasureStartAckBase64: base64OfBytes(
					presentation.rigMeasureStartAckBytes,
				),
				rigMeasureStartAckSignatureBase64: base64OfBytes(
					presentation.rigMeasureStartAckSignatureBytes,
				),
				rigBarrierAcceptanceBase64: base64OrNull(
					presentation.rigBarrierAcceptanceBytes,
				),
				rigBarrierAcceptanceSignatureBase64: base64OrNull(
					presentation.rigBarrierAcceptanceSignatureBytes,
				),
				serverWarmupDrainedBase64: base64OrNull(
					presentation.serverWarmupDrainedBytes,
				),
				serverStartBarrierAcceptedBase64: base64OrNull(
					presentation.serverStartBarrierAcceptedBytes,
				),
				snapshotFrameBase64: base64OfBytes(presentation.snapshotFrameBytes),
				rigServerSnapshotReceiptBase64: base64OfBytes(
					presentation.rigServerSnapshotReceiptBytes,
				),
				rigServerSnapshotReceiptSignatureBase64: base64OfBytes(
					presentation.rigServerSnapshotReceiptSignatureBytes,
				),
				linuxRelayObservationBase64: base64OrNull(
					presentation.linuxRelayObservationBytes,
				),
				rigRelayObservationReceiptBase64: base64OrNull(
					presentation.rigRelayObservationReceiptBytes,
				),
				rigRelayObservationReceiptSignatureBase64: base64OrNull(
					presentation.rigRelayObservationReceiptSignatureBytes,
				),
				orderedPartialManifestBase64: base64OrNull(
					presentation.orderedPartialManifestBytes,
				),
				observedProcessProofBase64: base64OrNull(
					presentation.observedProcessProofBytes,
				),
				cohortRateSeriesBase64: base64OrNull(
					presentation.cohortRateSeriesBytes,
				),
				cohortLedgerBase64: base64OrNull(presentation.cohortLedgerBytes),
				cohortCapacityBase64: base64OrNull(presentation.cohortCapacityBytes),
			},
			"mac-measurement-admission-issued-ack/v1",
		);
		if (!answered.ok) return answered;
		const ack = answered.value.ack;
		const admission = this.signedRecord(
			ack.macMeasurementAdmissionReceiptBase64,
			ack.macMeasurementAdmissionSignatureBase64,
			"mac-measurement-admission/v1",
		);
		if (!admission.ok) return this.fail(admission);
		const admissionJson = strictJsonOf(
			admission.value.bytes,
			"measurement admission",
		);
		if (!admissionJson.ok) return this.fail(admissionJson);
		const admissionRecord = admissionJson.value as {
			readonly [key: string]: unknown;
		};
		if (
			admissionRecord.schema !== "mac-measurement-admission/v1" ||
			admissionRecord.executionSha256 !== this.executionSha
		) {
			return this.fail(
				macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					"measurement admission names another execution",
				),
			);
		}
		let cohortAdmission: MacSignedRecordV1 | null = null;
		if (
			(ack.cohortAdmissionReceiptBase64 === null) !==
			(ack.cohortAdmissionSignatureBase64 === null)
		) {
			return this.fail(
				protocolFail(
					"cohort admission receipt and signature must be null together",
				),
			);
		}
		if (
			ack.cohortAdmissionReceiptBase64 !== null &&
			ack.cohortAdmissionSignatureBase64 !== null
		) {
			const signed = this.signedRecord(
				ack.cohortAdmissionReceiptBase64,
				ack.cohortAdmissionSignatureBase64,
				"cohort-admission-receipt/v1",
			);
			if (!signed.ok) return this.fail(signed);
			cohortAdmission = signed.value;
		}
		return {
			ok: true,
			value: {
				ack,
				ackPayloadBytes: answered.value.ackPayloadBytes,
				macMeasurementAdmission: admission.value,
				cohortAdmission,
			},
		};
	}

	// -- the terminal export ---------------------------------------------------

	/**
	 * The one terminal frame. The raw child-origin bundle travels here under
	 * plan 529's 9 MiB decoded / 14 MiB encoded pair, charged against the
	 * execution budget before it is encoded; the eight-field ack that comes
	 * back is verified against the C3 seven-field transcript under the staged
	 * Mac key. The channel is terminal afterwards whatever the outcome.
	 */
	async exportCohortEvidence(args: {
		readonly cohortAdmissionReceiptSha256: Sha256Hex;
		readonly roleChildEvidenceBundleBytes: Uint8Array;
	}): Promise<ProtocolResult<MacCohortEvidenceExportV1>> {
		if (this.executionSha === null) {
			return notReadyFail("no execution is open on this Mac channel");
		}
		if (
			args.roleChildEvidenceBundleBytes.byteLength >
			COHORT_EVIDENCE_EXPORT_MAX_DECODED_BYTES
		) {
			return macFail(
				"RUNTIME_RESOURCE_EXHAUSTION",
				"role child evidence bundle exceeds its 9 MiB decoded cap",
			);
		}
		const bundleBase64 = base64OfBytes(args.roleChildEvidenceBundleBytes);
		if (bundleBase64.length > COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES) {
			return macFail(
				"RUNTIME_RESOURCE_EXHAUSTION",
				"role child evidence bundle exceeds its 14 MiB encoded cap",
			);
		}
		const answered = await this.request<MacCohortEvidenceExportedAckV1>(
			{
				schema: "mac-export-cohort-evidence-request/v1",
				executionSha256: this.executionSha,
				cohortAdmissionReceiptSha256: args.cohortAdmissionReceiptSha256,
				roleChildEvidenceBundleBase64: bundleBase64,
			},
			"mac-cohort-evidence-exported-ack/v1",
		);
		if (!answered.ok) return answered;
		if (
			!verifyCohortExportAckSignature(
				answered.value.ack,
				this.stagedMacPublicRaw32,
			)
		) {
			return macFail(
				"MAC_SIGNING_KEY_MISMATCH",
				"terminal export ack signature does not verify under the staged Mac key",
			);
		}
		return {
			ok: true,
			value: {
				ack: answered.value.ack,
				ackPayloadBytes: answered.value.ackPayloadBytes,
			},
		};
	}
}

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

/**
 * What the controller mints for one attempt: tokens, the leaf manifest and the
 * non-secret topology (C1). No grant -- the authoritative `cohort-grant/v1`
 * exists only as the binary's signed bytes on `mac-cohort-opened-ack/v1`.
 */
export interface MacMintedCohortV1 {
	readonly tokens: MacCohortTokenMaterial;
	readonly leafManifestBytes: Uint8Array;
	readonly publishers: readonly PublisherRoleGrantV1[];
	readonly subscriberShards: readonly SubscriberShardV1[];
}

/**
 * Mint one attempt's token material. The supervisor -- not the caller -- owns
 * the attempt counter, the nonce and the cardinalities it hands in, and it
 * checks that the binary's grant carries what came back.
 */
export type MacCohortMinter = (args: {
	readonly cohortAttempt: number;
	readonly grantNonceSha256: Sha256Hex;
	readonly executionSha256: Sha256Hex;
	readonly publisherCount: number;
	readonly subscriberCount: number;
}) => MacMintedCohortV1;

/**
 * Registry edit (e): the child-origin retained records the Mac supervisor
 * process does not already hold, as one canonical bundle on
 * `mac-export-cohort-evidence-request/v1`. Records, not digests; the binary
 * recomputes every digest it binds and assembles the complete observation.
 */
export const ROLE_CHILD_EVIDENCE_BUNDLE_SCHEMA =
	"role-child-evidence-bundle/v1" as const;

export interface RoleChildEvidenceBundleV1 {
	readonly schema: typeof ROLE_CHILD_EVIDENCE_BUNDLE_SCHEMA;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	/**
	 * The admission the export is bound to (`ROLE_CHILD_EVIDENCE_BUNDLE_FIELDS`
	 * in secure_fs.rs): the same digest the request itself states, and the one
	 * the binary compares with the admission it retained.
	 */
	readonly cohortAdmissionReceiptSha256: Sha256Hex;
	/** Publisher children ascending, then workers 0..7. */
	readonly roleWarmupCompletes: readonly RetainedCanonicalBytesV1[];
	readonly publisherPartials: readonly RetainedCanonicalBytesV1[];
	readonly workerPartials: readonly RetainedCanonicalBytesV1[];
	readonly orderedPartialManifest: RetainedCanonicalBytesV1;
	readonly observedProcessProof: RetainedCanonicalBytesV1;
}

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

/**
 * The Phase-A joins the cohort graph is bound to. Read off the channel's opened
 * execution -- the binary's signed receipt -- never stated by a caller.
 */
export interface MacFanoutExecutionJoinsV1 {
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
}

export interface MacFanoutSupervisorConfig {
	readonly scenario: MacFanoutScenario;
	readonly subscriberCount: number;
	readonly executionSha256: Sha256Hex;
	/** The bounded client of the Mac supervisor process; the only Mac signer. */
	readonly channel: MacCohortChannel;
	readonly workloadRolePlanInputBytes: Uint8Array;
	readonly scenarioHash: Sha256Hex;
	readonly rolePlanHash: Sha256Hex;
	readonly stagedRigPublicRaw32: Uint8Array;
	/**
	 * Transitional cross-check only (residual R8). The clock every Mac record
	 * is compared against is bound from the binary's own signed barrier, the
	 * first record the binary states its clock in: `secure_fs.rs` mints
	 * `macClockId` from `MacIdentity::mac_clock_id()`, which
	 * `comparison-supervisor.rs`' `install_production_mac_cohort_runtime`
	 * fills from the process's own `observe_clock_identity()`. A controller
	 * value here can only refuse: present and different from the barrier's
	 * refuses the barrier; it never stands in for the bound clock. Drop it
	 * once the controller stops observing the sysctl.
	 */
	readonly macClockId?: string;
	readonly runtimeDir: string;
	readonly mintCohort: MacCohortMinter;
	readonly spawnChild: MacFanoutChildSpawner;
	readonly processControl: MacFanoutProcessControl;
	readonly ledger: ReplayLedger;
	readonly stagedCapabilityNotAfterMs: number;
	/** Staged binary digests recorded in every observed-child record. */
	readonly bunSha256: Sha256Hex;
	readonly entrypointSha256: Sha256Hex;
	/**
	 * Told, once per child, when a pre-readiness replacement retires the
	 * cohort, so whatever holds the children's control pipes can move them out
	 * of its live set before the replacement re-spawns the same ids.
	 *
	 * Optional because the supervisor's own correctness does not depend on it;
	 * production supplies `MacFanoutRoleChildHost.retireChild`, which is what
	 * makes plan 2210's second `spawnRoleChildren` possible at all.
	 */
	readonly retireChild?: (childId: string) => void;
}

/** What the supervisor keeps of one presented or minted record. */
interface RetainedRecord {
	readonly retained: RetainedCanonicalBytesV1;
	readonly bytes: Uint8Array;
}

/** Plan section 4.3: at most one pre-readiness replacement; a second is fatal. */
export const MAC_FANOUT_MAX_PRE_READY_REPLACEMENTS = 1;

/**
 * The retention a pre-readiness replacement abandons with the attempt that
 * produced it.
 *
 * Plan 2210: "replacement invalidates all ready state". The two campaign-scoped
 * inputs a replacement re-presents unchanged -- the workload role-plan input and
 * the freshly minted leaf manifest -- are deliberately absent, because
 * `mintAttempt` re-retains both from the frame it just sent.
 */
const MAC_FANOUT_COHORT_SCOPED_RETENTION: readonly string[] = [
	"cohortGrant",
	"cohortGrantSignature",
	"rigCohortAcceptance",
	"rigCohortAcceptanceSignature",
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
];

/**
 * Bind the cohort's Mac clock from the record the binary states it in.
 *
 * The barrier is the first signed record carrying `macClockId`
 * (`crates/native/src/secure_fs.rs`, the `cohort-start-barrier/v1` mint reads
 * `self.identity.mac_clock_id()`; no earlier Mac mint states it: the grant
 * receipts carry the instance nonce and key only). It counts as the binary's
 * own observation only if the same binary instance issued it: the barrier's
 * `macSupervisorInstanceNonce` must be the nonce on the signed execution
 * grant receipt that opened this execution, and its stated key the staged
 * one. A controller-supplied clock is at most a cross-check: present and
 * different refuses, and it is never the value returned.
 */
export function bindBarrierClockId(args: {
	readonly barrier: Pick<
		CohortStartBarrierV1,
		"macClockId" | "macSupervisorInstanceNonce" | "signingPublicKeySha256"
	>;
	readonly openedInstanceNonce: Sha256Hex;
	readonly stagedMacPublicKeySha256: Sha256Hex;
	readonly controllerClockId?: string;
}): ProtocolResult<string> {
	if (args.barrier.signingPublicKeySha256 !== args.stagedMacPublicKeySha256) {
		return macFail(
			"MAC_SIGNING_KEY_MISMATCH",
			"start barrier names another signing key",
		);
	}
	if (args.barrier.macSupervisorInstanceNonce !== args.openedInstanceNonce) {
		return macFail(
			"CROSS_SUPERVISOR_MISMATCH",
			"start barrier was issued by another Mac supervisor instance than the one that opened this execution",
		);
	}
	if (
		args.controllerClockId !== undefined &&
		args.controllerClockId !== args.barrier.macClockId
	) {
		return protocolFail(
			"the controller's clock id is not the clock the Mac binary stamped its barrier with",
		);
	}
	return { ok: true, value: args.barrier.macClockId };
}

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
	/** The binary's clock, bound from its signed barrier; null until issued. */
	private boundClockId: string | null = null;

	private receiptSequence = 0;
	private exported = false;
	private admissionValue: {
		readonly receipt: CohortAdmissionReceiptV1;
		readonly receiptSha256: Sha256Hex;
		readonly issued: MacMeasurementAdmissionIssuedV1;
	} | null = null;
	private teardownResult: MacFanoutTeardownResultV1 | null = null;
	/**
	 * Plan 2210's "a second failure is terminal", made true rather than said.
	 *
	 * The bound was already honoured -- the second pre-readiness replacement
	 * was refused -- but the refusal changed nothing: the supervisor went on
	 * answering, so a caller could spawn a fresh cohort on the very attempt it
	 * had just declared unrecoverable. Latched here, every later cohort
	 * transition answers with the same closed section-7 code, and only the
	 * teardown -- the terminal path itself -- still runs.
	 */
	private terminalRefusal: {
		readonly code: string;
		readonly message: string;
	} | null = null;

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

	/** The closed code this supervisor became terminal under, or null. */
	get terminalRefusalCode(): string | null {
		return this.terminalRefusal?.code ?? null;
	}

	/**
	 * The Mac clock every later record is checked against. It is the binary's
	 * own observation, read off the signed start barrier, and no configuration
	 * value ever replaces it.
	 */
	get macClockId(): string | null {
		return this.boundClockId;
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

	/**
	 * The latched terminal refusal, restated as this call's answer, or null
	 * when this supervisor still has a cohort to run.
	 */
	private refusedAsTerminal<T>(): ProtocolResult<T> | null {
		const terminal = this.terminalRefusal;
		if (terminal === null) return null;
		return macFail(terminal.code, terminal.message) as ProtocolResult<T>;
	}

	/** Latch the first terminal refusal; later ones do not overwrite it. */
	private becomeTerminal(code: string, message: string): void {
		this.terminalRefusal ??= { code, message };
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
	async openCohort(): Promise<
		ProtocolResult<{
			readonly grant: CohortGrantV1;
			readonly grantBytes: Uint8Array;
			readonly grantSha256: Sha256Hex;
			readonly grantSignature: MacReceiptSignatureV1;
			readonly cohortAttempt: number;
		}>
	> {
		if (this.attempt !== 0) {
			return protocolFail("cohort was already opened");
		}
		return this.mintAttempt(1);
	}

	private async mintAttempt(attempt: number): Promise<
		ProtocolResult<{
			readonly grant: CohortGrantV1;
			readonly grantBytes: Uint8Array;
			readonly grantSha256: Sha256Hex;
			readonly grantSignature: MacReceiptSignatureV1;
			readonly cohortAttempt: number;
		}>
	> {
		const terminal = this.refusedAsTerminal<{
			readonly grant: CohortGrantV1;
			readonly grantBytes: Uint8Array;
			readonly grantSha256: Sha256Hex;
			readonly grantSignature: MacReceiptSignatureV1;
			readonly cohortAttempt: number;
		}>();
		if (terminal !== null) return terminal;
		const previousRoot =
			this.tokensValue?.roleTokenCommitmentRootSha256 ?? null;
		const opened = this.config.channel.openedExecution;
		if (
			opened === null ||
			opened.executionSha256 !== this.config.executionSha256
		) {
			return notReadyFail("the Mac channel has not opened this execution");
		}
		// The attempt nonce is derived from the binary's own instance nonce, read
		// off its signed execution receipt, so a replacement cannot land on the
		// nonce it just abandoned and no controller value stands in for it.
		const grantNonceSha256 = sha256CanonicalRecord({
			executionSha256: this.config.executionSha256,
			macSupervisorInstanceNonce: opened.receipt.macSupervisorInstanceNonce,
			cohortAttempt: attempt,
		});
		if (grantNonceSha256 === this.grantNonce) {
			return protocolFail("a replacement attempt reused the abandoned nonce");
		}
		const minted = this.config.mintCohort({
			cohortAttempt: attempt,
			grantNonceSha256,
			executionSha256: this.config.executionSha256,
			publisherCount: this.topology.publisherCount,
			subscriberCount: this.topology.subscriberCount,
		});
		const publishersBytes = bytesOfCanonical(minted.publishers);
		const subscriberShardsBytes = bytesOfCanonical(minted.subscriberShards);
		const answered = await this.config.channel.request<MacCohortOpenedAckV1>(
			{
				schema: "mac-open-cohort-request/v1",
				executionSha256: this.config.executionSha256,
				scenarioHash: this.config.scenarioHash,
				rolePlanHash: this.config.rolePlanHash,
				workloadRolePlanInputBase64: Buffer.from(
					this.config.workloadRolePlanInputBytes,
				).toString("base64"),
				workloadRolePlanInputSha256: sha256HexOfBytes(
					this.config.workloadRolePlanInputBytes,
				),
				workloadRolePlanInputSize:
					this.config.workloadRolePlanInputBytes.byteLength,
				tokenCommitmentLeafManifestBase64: Buffer.from(
					minted.leafManifestBytes,
				).toString("base64"),
				tokenCommitmentLeafManifestSha256: sha256HexOfBytes(
					minted.leafManifestBytes,
				),
				publishersBase64: Buffer.from(publishersBytes).toString("base64"),
				subscriberShardsBase64: Buffer.from(subscriberShardsBytes).toString(
					"base64",
				),
			},
			"mac-cohort-opened-ack/v1",
		);
		if (!answered.ok) return answered;
		const ack = answered.value.ack;
		const signed = this.config.channel.signedRecord(
			ack.cohortGrantBase64,
			ack.cohortGrantSignatureBase64,
			"cohort-grant/v1",
		);
		if (!signed.ok) return signed;
		if (sha256HexOfBytes(signed.value.bytes) !== ack.cohortGrantSha256) {
			return protocolFail(
				"the opened ack's grant digest is not its grant bytes",
			);
		}
		const grantJson = parseStrictJsonBytes(signed.value.bytes);
		if (!grantJson.ok)
			return protocolFail("binary grant is not canonical JSON");
		const grant = parseCohortGrant(grantJson.value);
		if (!grant.ok) return grant;
		if (grant.value.executionSha256 !== this.config.executionSha256) {
			return protocolFail("minted grant names another execution");
		}
		if (
			sha256HexOfBytes(bytesOfCanonical(grant.value.execution)) !==
				opened.executionSha256 ||
			grant.value.macExecutionGrantReceiptSha256 !==
				sha256HexOfBytes(opened.receiptBytes) ||
			grant.value.approvedPlanSha256 !== opened.execution.approvedPlanSha256 ||
			grant.value.approvalRecordSha256 !== opened.execution.approvalRecordSha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"minted grant is not joined to the opened execution receipt",
			);
		}
		if (
			grant.value.scenarioHash !== this.config.scenarioHash ||
			grant.value.rolePlanHash !== this.config.rolePlanHash ||
			grant.value.workloadRolePlanInputSha256 !==
				sha256HexOfBytes(this.config.workloadRolePlanInputBytes) ||
			grant.value.tokenCommitmentLeafManifestSha256 !==
				sha256HexOfBytes(minted.leafManifestBytes)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"minted grant does not commit to the presented plan and manifest",
			);
		}
		if (
			sha256HexOfBytes(bytesOfCanonical(grant.value.publishers)) !==
				sha256HexOfBytes(publishersBytes) ||
			sha256HexOfBytes(bytesOfCanonical(grant.value.subscriberShards)) !==
				sha256HexOfBytes(subscriberShardsBytes)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"minted grant does not embed the presented topology arrays",
			);
		}
		if (
			grant.value.signingPublicKeySha256 !==
			sha256HexOfBytes(this.config.channel.stagedMacPublicRaw32)
		) {
			return macFail(
				"MAC_SIGNING_KEY_MISMATCH",
				"minted grant names another signing key",
			);
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

		const grantBytes = signed.value.bytes;
		const grantSha256 = sha256HexOfBytes(grantBytes);
		const grantSignature = signed.value.signature;

		this.attempt = attempt;
		this.grantNonce = grantNonceSha256;
		this.tokensValue = minted.tokens;
		this.grantValue = grant.value;
		this.grantSha256Value = grantSha256;
		this.retain("cohortGrant", grantBytes);
		this.retain("cohortGrantSignature", signed.value.signatureBytes);
		this.retain(
			"workloadRolePlanInput",
			this.config.workloadRolePlanInputBytes,
		);
		this.retain("tokenCommitmentLeafManifest", minted.leafManifestBytes);
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
		const terminal = this.refusedAsTerminal<readonly MacFanoutChildStateV1[]>();
		if (terminal !== null) return terminal;
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
		// descriptor to raw tokens beyond the spawn it was needed for, and
		// nothing to release again at teardown.
		for (const sealed of this.sealedFds) sealed.close();
		this.sealedFds.length = 0;
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
	async replaceCohortBeforeReadiness(args: {
		readonly reason: string;
	}): Promise<
		ProtocolResult<{
			readonly cohortAttempt: number;
			readonly grantNonceSha256: Sha256Hex;
			readonly grant: CohortGrantV1;
			/**
			 * The binary's own canonical grant bytes. The caller transfers these
			 * to the rig; `openCohort` has always returned them and the
			 * replacement did not, which forced the one caller there is to
			 * re-canonicalise a record the binary signed.
			 */
			readonly grantBytes: Uint8Array;
			readonly grantSha256: Sha256Hex;
			readonly grantSignature: MacReceiptSignatureV1;
			readonly reaped: MacFanoutTeardownResultV1;
			readonly retiredTokenCommitmentRootSha256: Sha256Hex;
		}>
	> {
		const terminal = this.refusedAsTerminal<{
			readonly cohortAttempt: number;
			readonly grantNonceSha256: Sha256Hex;
			readonly grant: CohortGrantV1;
			readonly grantBytes: Uint8Array;
			readonly grantSha256: Sha256Hex;
			readonly grantSignature: MacReceiptSignatureV1;
			readonly reaped: MacFanoutTeardownResultV1;
			readonly retiredTokenCommitmentRootSha256: Sha256Hex;
		}>();
		if (terminal !== null) return terminal;
		if (this.grantValue === null) return notReadyFail("no cohort to replace");
		if (this.anyChildReady) {
			return macFail(
				"CHILD_LIFECYCLE",
				`replacement after readiness is forbidden (${args.reason})`,
			);
		}
		if (this.replacements >= MAC_FANOUT_MAX_PRE_READY_REPLACEMENTS) {
			const message = `a second pre-readiness replacement is terminal (${args.reason})`;
			this.becomeTerminal("CHILD_LIFECYCLE", message);
			return macFail("CHILD_LIFECYCLE", message);
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
		// The host that holds the control pipes must forget these ids before the
		// replacement asks for them again; it closes nothing here (see
		// `MacFanoutRoleChildHost.retireChild`).
		const retireChild = this.config.retireChild;
		if (retireChild !== undefined) {
			for (const child of this.children.values()) {
				retireChild(child.plan.childId);
			}
		}
		this.children.clear();
		for (const sealed of this.sealedFds) sealed.close();
		this.sealedFds.length = 0;
		// Nothing of the retired attempt survives into the replacement. The
		// binary drops the retired session's rig retention with the session and
		// answers `COHORT_PROTOCOL` / "retired cohort grant" to any later frame
		// naming the superseded grant, so a supervisor that kept attempt 1's
		// acceptance would present a digest the binary has already refused.
		for (const key of MAC_FANOUT_COHORT_SCOPED_RETENTION) {
			this.retained.delete(key);
		}
		this.warmupCompletes.clear();
		// Nothing past the acceptance is cleared here and nothing needs to be: a
		// replacement is legal only before readiness, and the barrier, the bound
		// clock and every partial are minted after it. In particular
		// `boundClockId` is written in exactly one place -- from the binder's
		// result -- and `the_supervisor_compares_no_mac_record_against_a_
		// configured_clock` is the check that keeps it that way.

		this.replacements += 1;
		const minted = await this.mintAttempt(this.attempt + 1);
		if (!minted.ok) {
			// The allowance is spent and the replacement did not land: there is
			// no cohort left to run and no second replacement to try.
			this.becomeTerminal(
				minted.code,
				`the pre-readiness replacement was refused (${args.reason}): ${minted.message}`,
			);
			return minted;
		}
		return {
			ok: true,
			value: {
				cohortAttempt: minted.value.cohortAttempt,
				grantNonceSha256: this.grantNonce as Sha256Hex,
				grant: minted.value.grant,
				grantBytes: minted.value.grantBytes,
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

	async presentRigCohortAcceptance(args: {
		readonly acceptance: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): Promise<ProtocolResult<MacRigCohortAcceptanceAckV1>> {
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
		const answered =
			await this.config.channel.request<MacRigCohortAcceptanceAckV1>(
				{
					schema: "mac-present-rig-cohort-acceptance-request/v1",
					executionSha256: this.config.executionSha256,
					rigCohortAcceptanceBase64: Buffer.from(
						bytesOfCanonical(acceptance.value),
					).toString("base64"),
					rigCohortAcceptanceSignatureBase64: Buffer.from(
						admitted.value.signatureBytes,
					).toString("base64"),
				},
				"mac-rig-cohort-acceptance-ack/v1",
			);
		if (!answered.ok) return answered;
		if (
			answered.value.ack.rigCohortAcceptanceSha256 !==
			admitted.value.retained.sha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the Mac supervisor acknowledged another rig cohort acceptance",
			);
		}
		return { ok: true, value: answered.value.ack };
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
	async issueWarmupEpoch(): Promise<ProtocolResult<MacWarmupEpochIssuedAckV1>> {
		const acceptance = this.required("rigCohortAcceptance");
		if (acceptance === null || this.grantSha256Value === null) {
			return notReadyFail("no accepted cohort");
		}
		if (this.required("cohortWarmupEpoch") !== null) {
			return protocolFail("the warmup epoch was already issued");
		}
		const answered =
			await this.config.channel.request<MacWarmupEpochIssuedAckV1>(
				{
					schema: "mac-issue-warmup-epoch-request/v1",
					executionSha256: this.config.executionSha256,
					cohortGrantSha256: this.grantSha256Value,
					rigCohortAcceptanceSha256: acceptance.retained.sha256,
				},
				"mac-warmup-epoch-issued-ack/v1",
			);
		if (!answered.ok) return answered;
		const ack = answered.value.ack;
		const signed = this.config.channel.signedRecord(
			ack.cohortWarmupEpochBase64,
			ack.cohortWarmupEpochSignatureBase64,
			"cohort-warmup-epoch/v1",
		);
		if (!signed.ok) return signed;
		const json = parseStrictJsonBytes(signed.value.bytes);
		if (!json.ok) return protocolFail("warmup epoch is not canonical JSON");
		const parsed = parseCohortWarmupEpoch(json.value);
		if (!parsed.ok) return parsed;
		const joined = this.requireCohortJoin(parsed.value);
		if (!joined.ok) return joined;
		const grant = this.grantValue as CohortGrantV1;
		if (
			parsed.value.cohortId !== grant.cohortId ||
			parsed.value.expectedWarmupIngress !==
				expectedWarmupIngress(this.topology.publisherCount) ||
			parsed.value.expectedWarmupDeliveries !==
				expectedWarmupDeliveries(
					this.topology.publisherCount,
					this.topology.subscriberCount,
				)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup epoch does not describe this cohort",
			);
		}
		this.retain("cohortWarmupEpoch", signed.value.bytes);
		this.retain("cohortWarmupEpochSignature", signed.value.signatureBytes);
		return { ok: true, value: ack };
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
	async issueRoleWarmupCompletionManifest(): Promise<
		ProtocolResult<MacWarmupCompletionManifestExportedAckV1>
	> {
		const epoch = this.required("cohortWarmupEpoch");
		if (epoch === null) return notReadyFail("no warmup epoch was issued");
		if (this.required("roleWarmupCompletionManifest") !== null) {
			return protocolFail("the warmup completion manifest was already issued");
		}
		const roleWarmupCompletesBase64: Base64[] = [];
		for (const childId of this.orderedChildIds()) {
			const retained = this.warmupCompletes.get(childId);
			if (retained === undefined) {
				return notReadyFail(`${childId} never reported warmup completion`);
			}
			roleWarmupCompletesBase64.push(retained.retained.bytesBase64);
		}
		const answered =
			await this.config.channel.request<MacWarmupCompletionManifestExportedAckV1>(
				{
					schema: "mac-export-warmup-completion-manifest-request/v1",
					executionSha256: this.config.executionSha256,
					cohortWarmupEpochSha256: epoch.retained.sha256,
					roleWarmupCompletesBase64,
				},
				"mac-warmup-completion-manifest-exported-ack/v1",
			);
		if (!answered.ok) return answered;
		const ack = answered.value.ack;
		const signed = this.config.channel.signedRecord(
			ack.roleWarmupCompletionManifestBase64,
			ack.roleWarmupCompletionManifestSignatureBase64,
			"role-warmup-completion-manifest/v1",
		);
		if (!signed.ok) return signed;
		if (
			ack.cohortWarmupEpochSha256 !== epoch.retained.sha256 ||
			ack.roleWarmupCompletionManifestSha256 !==
				sha256HexOfBytes(signed.value.bytes) ||
			ack.roleWarmupCompletionManifestSize !== signed.value.bytes.byteLength ||
			ack.roleWarmupCompletionManifestSignatureSha256 !==
				sha256HexOfBytes(signed.value.signatureBytes)
		) {
			return protocolFail("warmup manifest ack digests are not its own bytes");
		}
		const json = parseStrictJsonBytes(signed.value.bytes);
		if (!json.ok) return protocolFail("warmup manifest is not canonical JSON");
		const parsed = parseRoleWarmupCompletionManifest(json.value);
		if (!parsed.ok) return parsed;
		if (ack.entryCount !== parsed.value.entries.length) {
			return protocolFail(
				"warmup manifest ack entry count is not the manifest's",
			);
		}
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
		this.retain("roleWarmupCompletionManifest", signed.value.bytes);
		this.retain(
			"roleWarmupCompletionManifestSignature",
			signed.value.signatureBytes,
		);
		return { ok: true, value: ack };
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
	async issueStartBarrier(): Promise<
		ProtocolResult<MacStartBarrierIssuedAckV1>
	> {
		if (this.required("cohortStartBarrier") !== null) {
			return protocolFail("the start barrier was already issued");
		}
		if (!this.allChildrenReady) {
			return notReadyFail("a start barrier may not be minted before readiness");
		}
		const acceptance = this.required("rigCohortAcceptance");
		const manifest = this.required("roleWarmupCompletionManifest");
		const manifestSignature = this.required(
			"roleWarmupCompletionManifestSignature",
		);
		const warmupReceipt = this.required("rigWarmupDrainedReceipt");
		const warmupReceiptSignature = this.required(
			"rigWarmupDrainedReceiptSignature",
		);
		const measureStartAck = this.required("rigMeasureStartAck");
		const measureStartAckSignature = this.required(
			"rigMeasureStartAckSignature",
		);
		if (
			acceptance === null ||
			manifest === null ||
			manifestSignature === null ||
			warmupReceipt === null ||
			warmupReceiptSignature === null ||
			measureStartAck === null ||
			measureStartAckSignature === null ||
			this.grantSha256Value === null
		) {
			return notReadyFail("barrier preconditions are not all retained");
		}
		// The barrier's clock is bound to the binary instance that issued the
		// execution grant receipt (R8): its instance nonce is the join.
		const opened = this.config.channel.openedExecution;
		if (
			opened === null ||
			opened.executionSha256 !== this.config.executionSha256
		) {
			return notReadyFail("the Mac channel has not opened this execution");
		}
		const answered =
			await this.config.channel.request<MacStartBarrierIssuedAckV1>(
				{
					schema: "mac-issue-start-barrier-request/v1",
					executionSha256: this.config.executionSha256,
					cohortGrantSha256: this.grantSha256Value,
					rigWarmupDrainedReceiptBase64: warmupReceipt.retained.bytesBase64,
					rigWarmupDrainedReceiptSignatureBase64:
						warmupReceiptSignature.retained.bytesBase64,
					rigMeasureStartAckBase64: measureStartAck.retained.bytesBase64,
					rigMeasureStartAckSignatureBase64:
						measureStartAckSignature.retained.bytesBase64,
				},
				"mac-start-barrier-issued-ack/v1",
			);
		if (!answered.ok) return answered;
		const ack = answered.value.ack;
		const signed = this.config.channel.signedRecord(
			ack.cohortStartBarrierBase64,
			ack.cohortStartBarrierSignatureBase64,
			"cohort-start-barrier/v1",
		);
		if (!signed.ok) return signed;
		const barrierJson = parseStrictJsonBytes(signed.value.bytes);
		if (!barrierJson.ok)
			return protocolFail("start barrier is not canonical JSON");
		const barrier: unknown = barrierJson.value;
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
		const bound = bindBarrierClockId({
			barrier: parsed.value,
			openedInstanceNonce: opened.receipt.macSupervisorInstanceNonce,
			stagedMacPublicKeySha256: sha256HexOfBytes(
				this.config.channel.stagedMacPublicRaw32,
			),
			controllerClockId: this.config.macClockId,
		});
		if (!bound.ok) return bound;
		if (sha256HexOfBytes(signed.value.bytes) !== ack.cohortStartBarrierSha256) {
			return protocolFail("the barrier ack's digest is not its barrier bytes");
		}
		if (parsed.value.cohortId !== (this.grantValue as CohortGrantV1).cohortId) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"start barrier names another cohort ID",
			);
		}
		this.barrierRecord = parsed.value;
		this.boundClockId = bound.value;
		this.retain("cohortStartBarrier", signed.value.bytes);
		this.retain("cohortStartBarrierSignature", signed.value.signatureBytes);
		return { ok: true, value: ack };
	}

	async presentRigBarrierAcceptance(args: {
		readonly serverStartBarrierAcceptedBytes: Uint8Array;
		readonly acceptance: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): Promise<ProtocolResult<MacRigBarrierAcceptanceAckV1>> {
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
		const answered =
			await this.config.channel.request<MacRigBarrierAcceptanceAckV1>(
				{
					schema: "mac-present-rig-barrier-acceptance-request/v1",
					executionSha256: this.config.executionSha256,
					rigBarrierAcceptanceBase64: Buffer.from(
						bytesOfCanonical(acceptance.value),
					).toString("base64"),
					rigBarrierAcceptanceSignatureBase64: Buffer.from(
						admitted.value.signatureBytes,
					).toString("base64"),
				},
				"mac-rig-barrier-acceptance-ack/v1",
			);
		if (!answered.ok) return answered;
		if (
			answered.value.ack.rigBarrierAcceptanceSha256 !==
			admitted.value.retained.sha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the Mac supervisor acknowledged another rig barrier acceptance",
			);
		}
		return { ok: true, value: answered.value.ack };
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
			readonly macClockId: string;
		},
		child: MacFanoutChildStateV1,
	): ProtocolResult<true> {
		const barrier = this.required("cohortStartBarrier");
		if (barrier === null || this.boundClockId === null)
			return notReadyFail("no barrier to bind a partial to");
		if (partial.macClockId !== this.boundClockId) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"partial was stamped by another Mac clock than the barrier's",
			);
		}
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

	// -- 6b. MAC_JOIN: the binary mints both admissions; this side presents ----

	/**
	 * Present the rig graph to the Mac supervisor process and take back the two
	 * admissions it signed (design §2.9 row 7, amendment C2).
	 *
	 * Five rig records travel on the frame; the other two -- the cohort
	 * acceptance and the drained receipt -- were presented earlier on this
	 * channel and the binary retains them itself. The five derived cohort
	 * records travel as records, not digests, so the binary recomputes every
	 * digest it binds. What comes back is checked here field by field against
	 * the bytes this supervisor retained: a receipt that binds any other digest
	 * is a receipt for some other cohort.
	 */
	async presentRigObservation(args: {
		readonly rigExecutionAcceptanceBytes: Uint8Array;
		readonly rigExecutionAcceptanceSignatureBytes: Uint8Array;
		readonly snapshotFrameBytes: Uint8Array;
		readonly rigServerSnapshotReceiptBytes: Uint8Array;
		readonly rigServerSnapshotReceiptSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<MacMeasurementAdmissionIssuedV1>> {
		if (this.admissionValue !== null) {
			return protocolFail("the cohort admission was already issued");
		}
		const grant = this.grantValue;
		if (grant === null) return notReadyFail("no cohort grant");
		const opened = this.config.channel.openedExecution;
		if (
			opened === null ||
			opened.executionSha256 !== this.config.executionSha256
		) {
			return notReadyFail("the Mac channel has not opened this execution");
		}
		const derived = this.ensureDerivedRecords();
		if (!derived.ok) return derived;
		const need = (key: string): RetainedRecord | null => this.required(key);
		const required = [
			"rigMeasureStartAck",
			"rigMeasureStartAckSignature",
			"rigBarrierAcceptance",
			"rigBarrierAcceptanceSignature",
			"serverWarmupDrained",
			"serverStartBarrierAccepted",
			"linuxRelayObservation",
			"rigRelayObservationReceipt",
			"rigRelayObservationReceiptSignature",
			"orderedPartialManifest",
			"observedProcessProof",
			"rateSeries",
			"ledger",
			"capacity",
		] as const;
		const have = new Map<string, RetainedRecord>();
		for (const key of required) {
			const record = need(key);
			if (record === null) return notReadyFail(`${key} is not retained`);
			have.set(key, record);
		}
		const bytesOf = (key: string): Uint8Array =>
			(have.get(key) as RetainedRecord).bytes;
		const issued = await this.config.channel.presentRigObservation({
			rigExecutionAcceptanceBytes: args.rigExecutionAcceptanceBytes,
			rigExecutionAcceptanceSignatureBytes:
				args.rigExecutionAcceptanceSignatureBytes,
			rigMeasureStartAckBytes: bytesOf("rigMeasureStartAck"),
			rigMeasureStartAckSignatureBytes: bytesOf("rigMeasureStartAckSignature"),
			rigBarrierAcceptanceBytes: bytesOf("rigBarrierAcceptance"),
			rigBarrierAcceptanceSignatureBytes: bytesOf(
				"rigBarrierAcceptanceSignature",
			),
			serverWarmupDrainedBytes: bytesOf("serverWarmupDrained"),
			serverStartBarrierAcceptedBytes: bytesOf("serverStartBarrierAccepted"),
			snapshotFrameBytes: args.snapshotFrameBytes,
			rigServerSnapshotReceiptBytes: args.rigServerSnapshotReceiptBytes,
			rigServerSnapshotReceiptSignatureBytes:
				args.rigServerSnapshotReceiptSignatureBytes,
			linuxRelayObservationBytes: bytesOf("linuxRelayObservation"),
			rigRelayObservationReceiptBytes: bytesOf("rigRelayObservationReceipt"),
			rigRelayObservationReceiptSignatureBytes: bytesOf(
				"rigRelayObservationReceiptSignature",
			),
			orderedPartialManifestBytes: bytesOf("orderedPartialManifest"),
			observedProcessProofBytes: bytesOf("observedProcessProof"),
			cohortRateSeriesBytes: bytesOf("rateSeries"),
			cohortLedgerBytes: bytesOf("ledger"),
			cohortCapacityBytes: bytesOf("capacity"),
		});
		if (!issued.ok) return issued;
		// §2.9(2f) rows 32-33: a cohort execution with a null cohort half is a
		// refusal at the point of receipt, never a shorter evidence graph.
		if (issued.value.cohortAdmission === null) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the Mac supervisor issued no cohort admission receipt for a cohort execution",
			);
		}
		const receiptJson = parseStrictJsonBytes(
			issued.value.cohortAdmission.bytes,
		);
		if (!receiptJson.ok) {
			return protocolFail("cohort admission receipt is not canonical JSON");
		}
		const receipt = parseCohortAdmissionReceipt(receiptJson.value);
		if (!receipt.ok) return receipt;
		const joined = this.requireCohortJoin(receipt.value);
		if (!joined.ok) return joined;
		const digestOf = (key: string): Sha256Hex | null =>
			this.retained.get(key)?.retained.sha256 ?? null;
		const bound: readonly (readonly [
			keyof CohortAdmissionReceiptV1,
			Sha256Hex | null,
		])[] = [
			["measurementGrantSha256", opened.measurementGrantSha256],
			["macExecutionGrantReceiptSha256", sha256HexOfBytes(opened.receiptBytes)],
			["cohortGrantSignatureSha256", digestOf("cohortGrantSignature")],
			["rigCohortAcceptanceSha256", digestOf("rigCohortAcceptance")],
			[
				"rigCohortAcceptanceSignatureSha256",
				digestOf("rigCohortAcceptanceSignature"),
			],
			[
				"tokenCommitmentLeafManifestSha256",
				digestOf("tokenCommitmentLeafManifest"),
			],
			["cohortWarmupEpochSha256", digestOf("cohortWarmupEpoch")],
			[
				"cohortWarmupEpochSignatureSha256",
				digestOf("cohortWarmupEpochSignature"),
			],
			[
				"roleWarmupCompletionManifestSha256",
				digestOf("roleWarmupCompletionManifest"),
			],
			[
				"roleWarmupCompletionManifestSignatureSha256",
				digestOf("roleWarmupCompletionManifestSignature"),
			],
			["serverWarmupDrainedSha256", digestOf("serverWarmupDrained")],
			["rigWarmupDrainedReceiptSha256", digestOf("rigWarmupDrainedReceipt")],
			[
				"rigWarmupDrainedReceiptSignatureSha256",
				digestOf("rigWarmupDrainedReceiptSignature"),
			],
			["rigMeasureStartAckSha256", digestOf("rigMeasureStartAck")],
			[
				"rigMeasureStartAckSignatureSha256",
				digestOf("rigMeasureStartAckSignature"),
			],
			["cohortStartBarrierSha256", digestOf("cohortStartBarrier")],
			[
				"cohortStartBarrierSignatureSha256",
				digestOf("cohortStartBarrierSignature"),
			],
			["rigBarrierAcceptanceSha256", digestOf("rigBarrierAcceptance")],
			[
				"rigBarrierAcceptanceSignatureSha256",
				digestOf("rigBarrierAcceptanceSignature"),
			],
			[
				"serverStartBarrierAcceptedSha256",
				digestOf("serverStartBarrierAccepted"),
			],
			["orderedPartialManifestSha256", digestOf("orderedPartialManifest")],
			["observedProcessProofSha256", digestOf("observedProcessProof")],
			["linuxRelayObservationSha256", digestOf("linuxRelayObservation")],
			[
				"rigRelayObservationReceiptSha256",
				digestOf("rigRelayObservationReceipt"),
			],
			[
				"rigRelayObservationReceiptSignatureSha256",
				digestOf("rigRelayObservationReceiptSignature"),
			],
			[
				"rigServerSnapshotReceiptSha256",
				sha256HexOfBytes(args.rigServerSnapshotReceiptBytes),
			],
			[
				"rigServerSnapshotReceiptSignatureSha256",
				sha256HexOfBytes(args.rigServerSnapshotReceiptSignatureBytes),
			],
			[
				"macMeasurementAdmissionReceiptSha256",
				sha256HexOfBytes(issued.value.macMeasurementAdmission.bytes),
			],
			[
				"macMeasurementAdmissionSignatureSha256",
				sha256HexOfBytes(issued.value.macMeasurementAdmission.signatureBytes),
			],
			["rateSeriesSha256", digestOf("rateSeries")],
			["ledgerSha256", digestOf("ledger")],
			["capacitySha256", digestOf("capacity")],
			["approvedPlanSha256", grant.approvedPlanSha256],
			["approvalRecordSha256", grant.approvalRecordSha256],
		];
		for (const [field, expected] of bound) {
			if (expected === null || receipt.value[field] !== expected) {
				return macFail(
					"CROSS_SUPERVISOR_MISMATCH",
					`cohort admission receipt binds another ${field}`,
				);
			}
		}
		const ledger = derived.value.ledger;
		if (
			receipt.value.publisherCount !== this.topology.publisherCount ||
			receipt.value.workerCount !== COHORT_WORKER_COUNT ||
			receipt.value.subscriberCount !== this.topology.subscriberCount ||
			receipt.value.offeredIngress !== ledger.offeredIngress ||
			receipt.value.serverAcceptedIngress !== ledger.serverAcceptedIngress ||
			receipt.value.linuxRelayWritesCompleted !==
				ledger.linuxRelayWritesCompleted ||
			receipt.value.delivered !== ledger.delivered
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"cohort admission receipt totals are not the recomputed ledger",
			);
		}
		if (
			receipt.value.signingPublicKeySha256 !==
			sha256HexOfBytes(this.config.channel.stagedMacPublicRaw32)
		) {
			return macFail(
				"MAC_SIGNING_KEY_MISMATCH",
				"cohort admission receipt names another signing key",
			);
		}
		this.retain("rigExecutionAcceptance", args.rigExecutionAcceptanceBytes);
		this.retain(
			"rigExecutionAcceptanceSignature",
			args.rigExecutionAcceptanceSignatureBytes,
		);
		this.retain("snapshotFrame", args.snapshotFrameBytes);
		this.retain("rigServerSnapshotReceipt", args.rigServerSnapshotReceiptBytes);
		this.retain(
			"rigServerSnapshotReceiptSignature",
			args.rigServerSnapshotReceiptSignatureBytes,
		);
		this.retain(
			"macMeasurementAdmissionReceipt",
			issued.value.macMeasurementAdmission.bytes,
		);
		this.retain(
			"macMeasurementAdmissionSignature",
			issued.value.macMeasurementAdmission.signatureBytes,
		);
		this.retain("cohortAdmissionReceipt", issued.value.cohortAdmission.bytes);
		this.retain(
			"cohortAdmissionSignature",
			issued.value.cohortAdmission.signatureBytes,
		);
		this.admissionValue = {
			receipt: receipt.value,
			receiptSha256: sha256HexOfBytes(issued.value.cohortAdmission.bytes),
			issued: issued.value,
		};
		return issued;
	}

	/** The binary-minted cohort admission, once MAC_JOIN has issued it. */
	get cohortAdmission(): {
		readonly receipt: CohortAdmissionReceiptV1;
		readonly receiptSha256: Sha256Hex;
		readonly issued: MacMeasurementAdmissionIssuedV1;
	} | null {
		return this.admissionValue;
	}

	// -- 6c. the one terminal export ------------------------------------------

	/**
	 * The sole terminal raw-evidence egress (design §2.9 row 8, amendment C3).
	 *
	 * The child-origin retained records the binary does not already hold travel
	 * up as one canonical bundle; the binary assembles and digests the complete
	 * 33-field observation and signs the seven-field ack transcript. This side
	 * reassembles the same observation from its own retained bytes and refuses
	 * unless size and digest are the ones the binary signed -- so the artifact
	 * retains bytes the binary actually digested, or nothing. It runs once.
	 */
	async exportCohortEvidence(): Promise<
		ProtocolResult<{
			readonly ack: MacCohortEvidenceExportedAckV1;
			readonly ackPayloadBytes: Uint8Array;
			readonly observation: CohortObservationEvidenceV1;
			readonly observationBytes: Uint8Array;
		}>
	> {
		if (this.exported) {
			return protocolFail("cohort evidence was already exported");
		}
		const admission = this.admissionValue;
		if (admission === null) {
			return notReadyFail("no cohort admission receipt has been issued");
		}
		const bundle = this.buildRoleChildEvidenceBundle();
		if (!bundle.ok) return bundle;
		const assembled = this.assembleEvidence();
		if (!assembled.ok) return assembled;
		const observationBytes = bytesOfCanonical(assembled.value);
		if (
			observationBytes.byteLength >
			COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES
		) {
			return protocolFail(
				"cohort observation evidence exceeds its decoded cap",
			);
		}
		this.exported = true;
		const exported = await this.config.channel.exportCohortEvidence({
			cohortAdmissionReceiptSha256: admission.receiptSha256,
			roleChildEvidenceBundleBytes: bytesOfCanonical(bundle.value),
		});
		if (!exported.ok) return exported;
		const ack = exported.value.ack;
		if (
			ack.cohortObservationEvidenceSize !== observationBytes.byteLength ||
			ack.cohortObservationEvidenceSha256 !== sha256HexOfBytes(observationBytes)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the Mac supervisor digested an observation this supervisor cannot reassemble",
			);
		}
		return {
			ok: true,
			value: {
				ack,
				ackPayloadBytes: exported.value.ackPayloadBytes,
				observation: assembled.value,
				observationBytes,
			},
		};
	}

	/**
	 * Derive the manifest, process proof, series, ledger and capacity, and retain
	 * their exact bytes. Idempotent, so MAC_JOIN may present them and the export
	 * may reassemble them from the same retained bytes.
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

	/** The child-origin records the binary does not hold, as one bundle. */
	private buildRoleChildEvidenceBundle(): ProtocolResult<RoleChildEvidenceBundleV1> {
		const admission = this.admissionValue;
		const manifest = this.required("orderedPartialManifest");
		const proof = this.required("observedProcessProof");
		if (admission === null || manifest === null || proof === null) {
			return notReadyFail(
				"the bundle needs the admission receipt and the derived records",
			);
		}
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
		return {
			ok: true,
			value: {
				schema: ROLE_CHILD_EVIDENCE_BUNDLE_SCHEMA,
				executionSha256: this.config.executionSha256,
				cohortGrantSha256: this.grantSha256Value as Sha256Hex,
				cohortAdmissionReceiptSha256: admission.receiptSha256,
				roleWarmupCompletes: warmupCompletes,
				publisherPartials: ordered.value
					.filter((item) => item.kind === "publisher")
					.map((item) => item.retained.retained),
				workerPartials: ordered.value
					.filter((item) => item.kind === "worker")
					.map((item) => item.retained.retained),
				orderedPartialManifest: manifest.retained,
				observedProcessProof: proof.retained,
			},
		};
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

// ---------------------------------------------------------------------------
// The controller ↔ rig cohort channel (plan §3.3 rig frames, §3.5 discipline)
//
// `MacFanoutSupervisor` above is the Mac half of Phase B: it mints the grant,
// the warmup epoch and the start barrier, and it admits rig-signed records.
// Nothing was carrying those records between the controller and the rig -- the
// Mac-side presentation methods existed, but no code put a rig frame on a wire
// or took one off it, so every `presentRig*` call had to be handed a record by
// a test.
//
// This is that wire. It is deliberately a *client*: the rig supervisor owns the
// server child and the signing key, and the controller may only ask. Every ack
// is decoded at the registered bound for the kind its own header declares,
// exact-key parsed, joined to the exact bytes this channel sent, and checked
// against the staged rig public key before any of it reaches the Mac side. A
// receipt this channel cannot verify never becomes evidence: the call refuses
// and the lifecycle stops, because a record that arrived over a wire and was
// not checked is indistinguishable from one the controller invented.
// ---------------------------------------------------------------------------

/** §3.5: EOF is legal only after the terminal ack, never before one. */
export type CohortRigStage =
	| "opened"
	| "execution-accepted"
	| "cohort-accepted"
	| "server-ready"
	| "warmup-open"
	| "warmup-drained"
	| "baseline-taken"
	| "barrier-accepted"
	| "captured"
	| "server-stopped";

const COHORT_RIG_STAGE_ORDER: readonly CohortRigStage[] = [
	"opened",
	"execution-accepted",
	"cohort-accepted",
	"server-ready",
	"warmup-open",
	"warmup-drained",
	"baseline-taken",
	"barrier-accepted",
	"captured",
	"server-stopped",
];

/**
 * The ordinary A5 arm's stages: the same §5 lifecycle with no cohort in it.
 *
 * Amendment C4 line 76 puts ordinary traffic on the base plan's signed server
 * lifecycle, and the base plan's own frames already carry the nulls that takes
 * (`cohortGrantSha256: Sha256Hex | null` on the spawn, all three joins
 * nullable on the baseline, the barrier nullable on the capture). What an
 * ordinary arm does *not* have is a grant to accept, a warmup to drain or a
 * barrier to present, so those four stages are absent here rather than
 * skipped: `advance` moves one stage at a time along whichever order the arm
 * is on, and the arm is fixed by the spawn (`spawnServer`), not chosen twice.
 */
const ORDINARY_RIG_STAGE_ORDER: readonly CohortRigStage[] = [
	"opened",
	"execution-accepted",
	"server-ready",
	"baseline-taken",
	"captured",
	"server-stopped",
];

/**
 * §5 TEARDOWN (plan 2191) is asked of a rig that holds a server child: from
 * `server-ready` until the child is stopped. The rig's own legality rule is
 * narrower (`teardown_server`: `Measuring | Captured`); a request it refuses
 * is answered with `remote-supervisor-refusal/v1` and the rig closes the arm,
 * reaping the child either way, so the controller asks whenever a child exists
 * rather than deciding for the rig which stage it is in.
 */
const COHORT_RIG_TEARDOWN_STAGES: readonly CohortRigStage[] = [
	"server-ready",
	"warmup-open",
	"warmup-drained",
	"baseline-taken",
	"barrier-accepted",
	"captured",
];

/** Every deadline §3.5 puts on this channel. None of them has a default. */
export interface CohortRigChannelDeadlinesV1 {
	/** "Any remote frame write/read": 5,000 ms in the frozen table. */
	readonly frameMs: number;
	/** "Rig child spawn + ready": the cell readiness deadline in Phase B. */
	readonly serverReadyMs: number;
	/** In-repetition warmup: 5,000 ms of wire plus the 1 s ack grace. */
	readonly warmupDrainMs: number;
	/** Relay drain/session close plus the snapshot/receipt window. */
	readonly captureMs: number;
	/** "Graceful child teardown": 10,000 ms in the frozen table (plan 1209). */
	readonly teardownMs: number;
}

export interface CohortRigChannelConfig {
	readonly controllerToRig: Writable;
	readonly rigToController: Readable;
	/**
	 * The rig spawn's view of the ssh child, or `undefined` for a channel
	 * driven over scripted pipes with no process behind them.
	 *
	 * Required, not optional: a production site that wires the two pipes and
	 * forgets this is exactly what made four arms report a bare five-second
	 * read timeout for a supervisor that had already exited 69, so the
	 * compiler asks every call site rather than defaulting the answer.
	 */
	readonly childDiagnostics: SupervisorChildDiagnostics | undefined;
	readonly executionSha256: Sha256Hex;
	/** The rig public key the campaign staged; not one an ack names. */
	readonly stagedRigPublicRaw32: Uint8Array;
	readonly deadlines: CohortRigChannelDeadlinesV1;
}

export interface RigCohortAcceptanceBundleV1 {
	readonly acceptance: RigCohortAcceptanceV1;
	readonly acceptanceBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
	readonly signatureBytes: Uint8Array;
}

/** §5 RIG_EXECUTION_ACCEPTED as the rig answered it: exact bytes, exact signature. */
export interface RigExecutionAcceptanceBundleV1 {
	readonly acceptance: RigExecutionAcceptanceV1;
	readonly acceptanceBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
	readonly signatureBytes: Uint8Array;
}

export interface RigServerReadyV1 {
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly serverReadyFrameSha256: Sha256Hex;
}

/** §5 TEARDOWN as the rig answered it: the child is gone, and how it went. */
export interface RigServerStoppedV1 {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

export interface RigWarmupDrainedBundleV1 {
	readonly serverWarmupDrainedBytes: Uint8Array;
	readonly receipt: RigWarmupDrainedReceiptV1;
	readonly receiptBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
	readonly signatureBytes: Uint8Array;
}

export interface RigMeasureStartAckBundleV1 {
	readonly ackBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
	readonly signatureBytes: Uint8Array;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

export interface RigBarrierAcceptanceBundleV1 {
	readonly serverStartBarrierAcceptedBytes: Uint8Array;
	readonly acceptance: RigBarrierAcceptanceV1;
	readonly acceptanceBytes: Uint8Array;
	readonly signature: RigReceiptSignatureV1;
	readonly signatureBytes: Uint8Array;
}

export interface RigCaptureBundleV1 {
	readonly snapshotFrameBytes: Uint8Array;
	readonly snapshotReceiptBytes: Uint8Array;
	readonly snapshotSignature: RigReceiptSignatureV1;
	readonly snapshotSignatureBytes: Uint8Array;
	readonly linuxRelayObservationBytes: Uint8Array | null;
	readonly relayObservationReceipt: RigRelayObservationReceiptV1 | null;
	readonly relayObservationReceiptBytes: Uint8Array | null;
	readonly relayObservationSignature: RigReceiptSignatureV1 | null;
	readonly relayObservationSignatureBytes: Uint8Array | null;
}

/** The server identity the staged launch record already fixed. */
export interface CohortRigSpawnServerRequestV1 {
	/**
	 * The grant this channel delivered, or `null` on the ordinary A5 arm,
	 * which spawns the same signed server under no cohort (plan 795 types the
	 * wire field `Sha256Hex | null`; amendment C4 line 76).
	 */
	readonly cohortGrantSha256: Sha256Hex | null;
	readonly serverEntrypointSha256: Sha256Hex;
	readonly bunSha256: Sha256Hex;
	readonly addonSha256: Sha256Hex;
	readonly stagedServerLaunchRecordBytes: Uint8Array;
	readonly bindPort: number;
	readonly transport: "ws" | "wt";
	readonly serverArgv: readonly string[];
}

function rigFail(message: string) {
	return macFail(COHORT_PROTOCOL_FAILURE_CODE, message);
}

/**
 * §7's index code for one code the rig may put on this wire.
 *
 * The rig speaks two refusal vocabularies and both are legitimate. A refused
 * *transition* is answered in the frozen `remote-supervisor-refusal/v1` shape,
 * whose codes are already §7 literals. A protocol violation goes out through
 * the binary's `terminate`, which writes the Phase-A `admission-refusal` frame
 * carrying `measurement-refusal/v1` -- and that record's codes are the
 * supervisor's own `TRUST_RECORD_*` / `TRUST_CHILD_*` family, which §7 does not
 * publish. Mapping them here is not a widening: §7's row for "malformed,
 * unknown-key, oversize, sequence, EOF, digest, cross-run/transport/cohort
 * protocol" is `FAIL/TRUST_PROTOCOL`, and every code in that family is one of
 * those. What must not happen -- and did -- is the controller reporting a
 * decode failure and never naming the rig's code at all.
 */
export function mapRigRefusalCodeToIndexCode(
	code: string,
): CampaignFailureCode {
	if (isCampaignFailureCode(code)) return code;
	switch (code) {
		case "TRUST_RECORD_MALFORMED":
		case "TRUST_RECORD_DUPLICATE_FIELD":
		case "TRUST_RECORD_UNKNOWN_FIELD":
		case "TRUST_RECORD_MISSING_FIELD":
		case "TRUST_RECORD_SCHEMA_INVALID":
		case "TRUST_RECORD_BINDING_MISMATCH":
		case "TRUST_CHILD_FRAME_INVALID":
		case "FRAME_SESSION_LIMIT":
			return "TRUST_PROTOCOL";
		default:
			// An unpublished code is still the rig failing to speak the
			// protocol, and the caller keeps the literal in its message.
			return "TRUST_PROTOCOL";
	}
}

/**
 * The rig's code out of whichever refusal shape it used, or null when the
 * frame is not a refusal at all.
 *
 * `admission-refusal` frames are read from their own payload rather than
 * through `decodeRegisteredRemotePayload`, because that decoder resolves its
 * bound from the header kind and `admission-refusal` is not a registered
 * remote kind -- which is exactly why the crossing used to be reported as
 * "unregistered remote kind" instead of the rig's code.
 */
function rigRefusalCodeFromFrame(args: {
	readonly headerKind: string;
	readonly frameBytes: Uint8Array;
}): string | null {
	if (args.headerKind !== ADMISSION_REFUSAL_KIND) return null;
	const decoded = decodeSupervisorFrame(
		args.frameBytes,
		SUPERVISOR_RUN_COMMAND_MAX_BYTES,
	);
	if (!decoded.ok) return "TRUST_PROTOCOL";
	const parsed = parseStrictJsonBytes(decoded.value.frame.payload);
	if (!parsed.ok) return "TRUST_PROTOCOL";
	const record = parsed.value;
	if (
		typeof record !== "object" ||
		record === null ||
		Array.isArray(record) ||
		(record as { schema?: unknown }).schema !== "measurement-refusal/v1"
	) {
		return "TRUST_PROTOCOL";
	}
	const code = (record as { code?: unknown }).code;
	return typeof code === "string" && code.length > 0 ? code : "TRUST_PROTOCOL";
}

function decodeBase64Exact(value: string): Uint8Array | null {
	const bytes = new Uint8Array(Buffer.from(value, "base64"));
	if (Buffer.from(bytes).toString("base64") !== value) return null;
	return bytes;
}

export class CohortRigChannel {
	private readonly config: CohortRigChannelConfig;
	private readonly sequence: RemoteSequenceState;
	private stageValue: CohortRigStage = "opened";
	/**
	 * Which §5 order this channel is walking. Both start at `opened`; the
	 * spawn is where the two part, and nothing moves it afterwards.
	 */
	private stageOrder: readonly CohortRigStage[] = COHORT_RIG_STAGE_ORDER;
	private executionAcceptanceValue: RigExecutionAcceptanceBundleV1 | null =
		null;
	private cohortGrantSha256Value: Sha256Hex | null = null;
	private rigMeasureStartAckSha256Value: Sha256Hex | null = null;
	private cohortStartBarrierSha256Value: Sha256Hex | null = null;

	constructor(config: CohortRigChannelConfig) {
		if (config.stagedRigPublicRaw32.byteLength !== 32) {
			throw new RangeError("staged rig public key must be 32 raw bytes");
		}
		for (const [name, value] of Object.entries(config.deadlines)) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new RangeError(`deadline ${name} must be a positive integer`);
			}
		}
		this.config = config;
		this.sequence = createRemoteSequenceState();
	}

	get stage(): CohortRigStage {
		return this.stageValue;
	}

	/** The digest of the grant this channel actually delivered to the rig. */
	get cohortGrantSha256(): Sha256Hex | null {
		return this.cohortGrantSha256Value;
	}

	/** The rig's acceptance of this execution, exactly as it came off the wire. */
	get executionAcceptance(): RigExecutionAcceptanceBundleV1 | null {
		return this.executionAcceptanceValue;
	}

	/** The rig child's post-mortem as a message suffix, or "". */
	private postMortem(): string {
		const described = describeSupervisorChildDeath(
			this.config.childDiagnostics,
		);
		return described === "" ? "" : ` (${described})`;
	}

	private requireStage(expected: CohortRigStage, what: string) {
		if (this.stageValue !== expected) {
			return notReadyFail(
				`${what} is legal only at stage ${expected}, not ${this.stageValue}`,
			);
		}
		return null;
	}

	/**
	 * A transition only a fanout arm has.
	 *
	 * Two of the ordinary arm's stages share a name with a cohort stage --
	 * `server-ready` is where `beginWarmup` starts and `baseline-taken` is
	 * where `presentStartBarrier` does -- so the stage guard alone would let a
	 * cohort step run on an arm that has no cohort. It would then reach
	 * `advance`, which throws on a stage that is not in this arm's order: a
	 * thrown error rather than the named refusal §7 wants.
	 */
	private requireCohortArm(what: string) {
		if (this.stageOrder === ORDINARY_RIG_STAGE_ORDER) {
			return notReadyFail(
				`${what} is a cohort transition; this channel spawned an ordinary A5 arm`,
			);
		}
		return null;
	}

	private advance(to: CohortRigStage): void {
		const from = this.stageOrder.indexOf(this.stageValue);
		const next = this.stageOrder.indexOf(to);
		if (next !== from + 1) {
			throw new Error(`illegal cohort rig stage ${this.stageValue} -> ${to}`);
		}
		this.stageValue = to;
	}

	/**
	 * One request, one ack. The request seq is taken from the shared sequence
	 * state and the ack must echo it: a rig that answers a frame this channel
	 * did not just send is refused before its payload is looked at.
	 */
	private async exchange<S extends string>(
		request: Record<string, unknown> & { readonly schema: string },
		expectedSchema: S,
		deadlineMs: number,
	): Promise<ProtocolResult<Record<string, unknown>>> {
		const bound = remotePayloadBoundForSchema(expectedSchema);
		if (bound === null) {
			return rigFail(`${expectedSchema} is not a registered remote kind`);
		}
		const diagnostics = this.config.childDiagnostics;
		const encoded = encodeRegisteredRemotePayload(request);
		if (!encoded.ok) {
			return rigFail(`encode ${request.schema}: ${encoded.code}`);
		}
		try {
			// Bounded by the caller's own deadline, the way the Mac channel
			// bounds its write: a control pipe that accepts bytes and never
			// completes the write is a hang with no other end.
			await withWriteDeadline(
				writeAll(this.config.controllerToRig, encoded.value),
				deadlineMs,
				`write ${request.schema}`,
			);
		} catch (error) {
			return rigFail(
				`write ${request.schema}: ${(error as Error).message}${this.postMortem()}`,
			);
		}
		const framed = await readControlFrame(
			this.config.rigToController,
			bound,
			deadlineMs,
			{
				...(diagnostics === undefined ? {} : { childDiagnostics: diagnostics }),
			},
		);
		if (!framed.ok) {
			return rigFail(`${expectedSchema}: ${framed.code} ${framed.message}`);
		}
		// The rig's Phase-A refusal shape is read before the registered decoder
		// runs, because `admission-refusal` is not a registered remote kind and
		// the decoder would report an unregistered-kind failure over the top of
		// the code the rig is trying to state.
		const measurementRefusal = rigRefusalCodeFromFrame({
			headerKind: framed.kind,
			frameBytes: framed.frameBytes,
		});
		if (measurementRefusal !== null) {
			return macFail(
				mapRigRefusalCodeToIndexCode(measurementRefusal),
				`rig refused ${request.schema} with ${measurementRefusal}`,
			);
		}
		const decoded = decodeRegisteredRemotePayload(framed.frameBytes);
		if (!decoded.ok) {
			return rigFail(`${expectedSchema} decode: ${decoded.code}`);
		}
		const payload = decoded.value.payload;
		if (payload.schema === "remote-supervisor-refusal/v1") {
			const refusal = parseRemoteSupervisorRefusal(payload);
			if (!refusal.ok) return rigFail("rig sent an unparsable refusal");
			return macFail(
				refusal.value.code,
				`rig refused ${request.schema} with ${refusal.value.code}`,
			);
		}
		if (decoded.value.headerKind !== expectedSchema.slice(0, -3)) {
			return rigFail(
				`expected ${expectedSchema}, got ${decoded.value.headerKind}`,
			);
		}
		const seq = assertRemoteResponseSeq(
			this.sequence,
			payload.responseSeq as number,
			payload.ackRequestSeq as number,
		);
		if (!seq.ok) return seq;
		if (payload.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				`${expectedSchema} names another execution`,
			);
		}
		return { ok: true, value: payload };
	}

	private nextRequestSeq(): ProtocolResult<number> {
		return takeRemoteRequestSeq(this.sequence);
	}

	/**
	 * Decode one carried record: exact base64, canonical JSON, and the exact
	 * bytes the digest of which everything downstream is joined to. The record
	 * is re-serialized and compared, so a rig cannot send a semantically equal
	 * but differently-encoded record and have the Mac side sign a digest of
	 * bytes nobody checked.
	 */
	private carried(
		base64: unknown,
		what: string,
	): ProtocolResult<{ bytes: Uint8Array; value: unknown }> {
		if (typeof base64 !== "string") return rigFail(`${what} is not a string`);
		const bytes = decodeBase64Exact(base64);
		if (bytes === null) return rigFail(`${what} is not exact base64`);
		const json = parseStrictJsonBytes(bytes);
		if (!json.ok) return rigFail(`${what} is not canonical JSON`);
		if (
			sha256HexOfBytes(bytesOfCanonical(json.value)) !== sha256HexOfBytes(bytes)
		) {
			return rigFail(`${what} is not canonically encoded`);
		}
		return { ok: true, value: { bytes, value: json.value } };
	}

	/**
	 * Verify one rig signature against the *staged* key. `signedSchema` is
	 * checked here rather than trusted, so a genuine rig signature over some
	 * other record cannot be replayed into this slot; the byte joins at each
	 * call site then pin it to the exact records this channel sent, and the
	 * stage machine admits each signed schema exactly once per execution.
	 */
	private verifyRigRecord(args: {
		readonly signedSchema: RigReceiptSignatureV1["signedSchema"];
		readonly signedBytes: Uint8Array;
		readonly signatureBase64: unknown;
	}): ProtocolResult<{
		signature: RigReceiptSignatureV1;
		signatureBytes: Uint8Array;
	}> {
		const carried = this.carried(
			args.signatureBase64,
			`${args.signedSchema} signature`,
		);
		if (!carried.ok) return carried;
		const parsed = parseRigReceiptSignature(carried.value.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.signedSchema !== args.signedSchema) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				`signature covers ${parsed.value.signedSchema}, not ${args.signedSchema}`,
			);
		}
		const verified = verifyRigReceiptSignature({
			stagedRigPublicRaw32: this.config.stagedRigPublicRaw32,
			signedBytes: args.signedBytes,
			signature: parsed.value,
		});
		if (!verified.ok) return verified;
		return {
			ok: true,
			value: { signature: parsed.value, signatureBytes: carried.value.bytes },
		};
	}

	// -- 0. RIG_EXECUTION_ACCEPTED: the Phase-A open on the rig ---------------

	/**
	 * §5 RIG_EXECUTION_ACCEPTED. The controller transfers the Mac's grant, the
	 * Mac's execution receipt and the Mac signature record over it -- three
	 * exact byte strings the Mac binary wrote -- and the rig authenticates them
	 * itself and signs its own acceptance. Every digest the acceptance states
	 * is checked here against the bytes this channel sent, so a rig cannot
	 * accept some other execution under this execution's name.
	 */
	async acceptExecution(args: {
		readonly measurementGrantBytes: Uint8Array;
		readonly receiptBytes: Uint8Array;
		readonly receiptSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<RigExecutionAcceptanceBundleV1>> {
		const stage = this.requireStage("opened", "acceptExecution");
		if (stage !== null) return stage;
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-accept-execution-request/v1",
				requestSeq: seq.value,
				measurementGrantBase64: Buffer.from(
					args.measurementGrantBytes,
				).toString("base64"),
				macExecutionGrantReceiptBase64: Buffer.from(args.receiptBytes).toString(
					"base64",
				),
				macExecutionGrantSignatureBase64: Buffer.from(
					args.receiptSignatureBytes,
				).toString("base64"),
			},
			"rig-execution-accepted-ack/v1",
			this.config.deadlines.frameMs,
		);
		if (!ack.ok) return ack;
		const parsedAck = parsePhaseARigRemotePayload(ack.value);
		if (!parsedAck.ok) return parsedAck;
		if (parsedAck.value.schema !== "rig-execution-accepted-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		const carried = this.carried(
			parsedAck.value.rigExecutionAcceptanceBase64,
			"rig execution acceptance",
		);
		if (!carried.ok) return carried;
		const acceptance = parseRigExecutionAcceptance(carried.value.value);
		if (!acceptance.ok) return acceptance;
		const record = acceptance.value;
		if (record.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"execution acceptance names another execution",
			);
		}
		if (
			record.measurementGrantSha256 !==
				sha256HexOfBytes(args.measurementGrantBytes) ||
			record.macExecutionGrantReceiptSha256 !==
				sha256HexOfBytes(args.receiptBytes) ||
			record.macReceiptSignatureSha256 !==
				sha256HexOfBytes(args.receiptSignatureBytes)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"execution acceptance is not joined to the grant and receipt this channel delivered",
			);
		}
		if (record.notAfterMs <= record.issuedAtMs) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"execution acceptance states an empty validity window",
			);
		}
		const signed = this.verifyRigRecord({
			signedSchema: "rig-execution-acceptance/v1",
			signedBytes: carried.value.bytes,
			signatureBase64: parsedAck.value.rigExecutionAcceptanceSignatureBase64,
		});
		if (!signed.ok) return signed;
		const bundle: RigExecutionAcceptanceBundleV1 = {
			acceptance: record,
			acceptanceBytes: carried.value.bytes,
			signature: signed.value.signature,
			signatureBytes: signed.value.signatureBytes,
		};
		this.executionAcceptanceValue = bundle;
		this.advance("execution-accepted");
		return { ok: true, value: bundle };
	}

	// -- 1. COHORT_GRANTED: the exact grant and its Mac signature ------------

	/**
	 * §5 COHORT_GRANTED. The controller transfers the exact grant bytes and the
	 * Mac signature over them; the rig authenticates that pair itself and signs
	 * its acceptance. This channel never re-mints, re-encodes, or summarises the
	 * grant: what the Mac signed is what goes on the wire.
	 */
	async acceptCohort(args: {
		readonly cohortGrantBytes: Uint8Array;
		readonly cohortGrantSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<RigCohortAcceptanceBundleV1>> {
		const stage = this.requireStage("execution-accepted", "acceptCohort");
		if (stage !== null) return stage;
		// §2.13: the frame carries this execution's acceptance -- the one the
		// rig answered `acceptExecution` with, byte for byte, never a record
		// the caller supplies.
		const executionAcceptance = this.executionAcceptanceValue;
		if (executionAcceptance === null) {
			return notReadyFail("no execution acceptance is retained");
		}
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const grantSha256 = sha256HexOfBytes(args.cohortGrantBytes);
		const signatureSha256 = sha256HexOfBytes(args.cohortGrantSignatureBytes);
		const ack = await this.exchange(
			{
				schema: "rig-accept-cohort-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				cohortGrantBase64: Buffer.from(args.cohortGrantBytes).toString(
					"base64",
				),
				cohortGrantSignatureBase64: Buffer.from(
					args.cohortGrantSignatureBytes,
				).toString("base64"),
				rigExecutionAcceptanceBase64: Buffer.from(
					executionAcceptance.acceptanceBytes,
				).toString("base64"),
				rigExecutionAcceptanceSignatureBase64: Buffer.from(
					executionAcceptance.signatureBytes,
				).toString("base64"),
			},
			"rig-cohort-accepted-ack/v1",
			this.config.deadlines.frameMs,
		);
		if (!ack.ok) return ack;
		const parsedAck = parseCohortRemotePayload(ack.value);
		if (!parsedAck.ok) return parsedAck;
		if (parsedAck.value.schema !== "rig-cohort-accepted-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		if (parsedAck.value.cohortGrantSha256 !== grantSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the rig accepted a different cohort grant",
			);
		}
		const carried = this.carried(
			parsedAck.value.rigCohortAcceptanceBase64,
			"rig cohort acceptance",
		);
		if (!carried.ok) return carried;
		const acceptance = parseRigCohortAcceptance(carried.value.value);
		if (!acceptance.ok) return acceptance;
		if (acceptance.value.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"acceptance names another execution",
			);
		}
		if (
			acceptance.value.cohortGrantSha256 !== grantSha256 ||
			acceptance.value.cohortGrantSignatureSha256 !== signatureSha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"acceptance is not joined to the grant this channel delivered",
			);
		}
		const signed = this.verifyRigRecord({
			signedSchema: "rig-cohort-acceptance/v1",
			signedBytes: carried.value.bytes,
			signatureBase64: parsedAck.value.rigCohortAcceptanceSignatureBase64,
		});
		if (!signed.ok) return signed;
		this.cohortGrantSha256Value = grantSha256;
		this.advance("cohort-accepted");
		return {
			ok: true,
			value: {
				acceptance: acceptance.value,
				acceptanceBytes: carried.value.bytes,
				signature: signed.value.signature,
				signatureBytes: signed.value.signatureBytes,
			},
		};
	}

	// -- 2. the server child, which exists only under an accepted grant ------

	/**
	 * §3.4: the staged launch record travels as bytes inside the 64 KiB cap, not
	 * as a path the rig would have to look up. `cohortGrantSha256` is this
	 * channel's own record of what it delivered, never the caller's claim.
	 */
	async spawnServer(
		request: CohortRigSpawnServerRequestV1,
	): Promise<ProtocolResult<RigServerReadyV1>> {
		// The one place the two arms part. A fanout spawn follows the grant
		// this channel delivered; an ordinary one follows the execution
		// acceptance and names no grant, which is the null plan 795 types.
		// Neither is the caller's to choose: the grant the request names must
		// be the grant this channel actually delivered, and that is what picks
		// the stage and the order.
		const ordinary = request.cohortGrantSha256 === null;
		const stage = this.requireStage(
			ordinary ? "execution-accepted" : "cohort-accepted",
			"spawnServer",
		);
		if (stage !== null) return stage;
		if (request.cohortGrantSha256 !== this.cohortGrantSha256Value) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"spawn names a grant this channel did not deliver",
			);
		}
		if (
			request.stagedServerLaunchRecordBytes.byteLength >
			RIG_SPAWN_SERVER_REQUEST_MAX_BYTES
		) {
			return rigFail("staged launch record exceeds the 64 KiB spawn cap");
		}
		// The endpoint the request states is the one the carried record froze
		// (bind == advertised == the stage profile's host, design §3.1): a
		// local-acceptance record binds loopback and a physical one the cable
		// address, and this frame must not restate either as a literal.
		let launchJson: unknown;
		try {
			launchJson = JSON.parse(
				new TextDecoder().decode(request.stagedServerLaunchRecordBytes),
			);
		} catch {
			return rigFail("staged launch record is not JSON");
		}
		const launch = parseStagedServerLaunchRecord(launchJson);
		if (!launch.ok) {
			return rigFail(`staged launch record: ${launch.message}`);
		}
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-spawn-server-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				cohortGrantSha256: request.cohortGrantSha256,
				serverEntrypointSha256: request.serverEntrypointSha256,
				bunSha256: request.bunSha256,
				addonSha256: request.addonSha256,
				stagedServerLaunchRecordBase64: Buffer.from(
					request.stagedServerLaunchRecordBytes,
				).toString("base64"),
				stagedServerLaunchRecordSha256: sha256HexOfBytes(
					request.stagedServerLaunchRecordBytes,
				),
				stagedServerLaunchRecordSize:
					request.stagedServerLaunchRecordBytes.byteLength,
				bindAddress: launch.value.bindAddress,
				bindPort: request.bindPort,
				advertisedHost: launch.value.advertisedHost,
				tlsServerName: launch.value.tlsServerName,
				transport: request.transport,
				serverArgv: [...request.serverArgv],
			},
			"rig-server-ready-ack/v1",
			this.config.deadlines.serverReadyMs,
		);
		if (!ack.ok) return ack;
		const parsed = parsePhaseARigRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-server-ready-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		// The arm is fixed by the spawn that *happened*, not by one that was
		// refused: a spawn that never reached a server child leaves the channel
		// where it was, with both orders still open to it. Set here, one
		// statement before the stage it belongs to, so no refusal path can
		// leave the two disagreeing -- `advance` throws on a stage outside the
		// arm's order, and `acceptCohort` is still legal at `execution-accepted`.
		if (ordinary) {
			this.stageOrder = ORDINARY_RIG_STAGE_ORDER;
		}
		this.advance("server-ready");
		return {
			ok: true,
			value: {
				childPid: parsed.value.childPid,
				childPgid: parsed.value.childPgid,
				childInstanceNonce: parsed.value.childInstanceNonce,
				serverReadyFrameSha256: parsed.value.serverReadyFrameSha256,
			},
		};
	}

	// -- 3. IN_REPETITION_WARMUP ---------------------------------------------

	/** Deliver the Mac-signed warmup epoch; the rig opens its warmup window. */
	async beginWarmup(args: {
		readonly cohortWarmupEpochBytes: Uint8Array;
		readonly cohortWarmupEpochSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<{ readonly serverWarmupReadySha256: Sha256Hex }>> {
		const arm = this.requireCohortArm("beginWarmup");
		if (arm !== null) return arm;
		const stage = this.requireStage("server-ready", "beginWarmup");
		if (stage !== null) return stage;
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-begin-warmup-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				cohortWarmupEpochBase64: Buffer.from(
					args.cohortWarmupEpochBytes,
				).toString("base64"),
				cohortWarmupEpochSignatureBase64: Buffer.from(
					args.cohortWarmupEpochSignatureBytes,
				).toString("base64"),
			},
			"rig-warmup-ready-ack/v1",
			this.config.deadlines.frameMs,
		);
		if (!ack.ok) return ack;
		const parsed = parseCohortRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-warmup-ready-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		this.advance("warmup-open");
		return {
			ok: true,
			value: { serverWarmupReadySha256: parsed.value.serverWarmupReadySha256 },
		};
	}

	/**
	 * Deliver the one Mac-signed completion manifest and take the rig's drained
	 * receipt. §3.3 forbids a controller-reconstructed manifest, so the exact
	 * exported bytes are what this sends and what the receipt must name.
	 */
	async finishWarmup(args: {
		readonly cohortWarmupEpochBytes: Uint8Array;
		readonly cohortWarmupEpochSignatureBytes: Uint8Array;
		readonly roleWarmupCompletionManifestBytes: Uint8Array;
		readonly roleWarmupCompletionManifestSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<RigWarmupDrainedBundleV1>> {
		const arm = this.requireCohortArm("finishWarmup");
		if (arm !== null) return arm;
		const stage = this.requireStage("warmup-open", "finishWarmup");
		if (stage !== null) return stage;
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-finish-warmup-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				roleWarmupCompletionManifestBase64: Buffer.from(
					args.roleWarmupCompletionManifestBytes,
				).toString("base64"),
				roleWarmupCompletionManifestSignatureBase64: Buffer.from(
					args.roleWarmupCompletionManifestSignatureBytes,
				).toString("base64"),
			},
			"rig-warmup-drained-ack/v1",
			this.config.deadlines.warmupDrainMs,
		);
		if (!ack.ok) return ack;
		const parsed = parseCohortRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-warmup-drained-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		const drained = this.carried(
			parsed.value.serverWarmupDrainedBase64,
			"server warmup drained frame",
		);
		if (!drained.ok) return drained;
		const drainedSha256 = sha256HexOfBytes(drained.value.bytes);
		if (
			parsed.value.serverWarmupDrainedSha256 !== drainedSha256 ||
			parsed.value.serverWarmupDrainedSize !== drained.value.bytes.byteLength
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the ack's declared drained digest/size is not the frame it carried",
			);
		}
		const carried = this.carried(
			parsed.value.rigWarmupDrainedReceiptBase64,
			"rig warmup drained receipt",
		);
		if (!carried.ok) return carried;
		const receipt = parseRigWarmupDrainedReceipt(carried.value.value);
		if (!receipt.ok) return receipt;
		if (
			receipt.value.executionSha256 !== this.config.executionSha256 ||
			receipt.value.cohortGrantSha256 !== this.cohortGrantSha256Value
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup receipt names another execution or cohort",
			);
		}
		if (
			receipt.value.serverWarmupDrainedSha256 !== drainedSha256 ||
			receipt.value.cohortWarmupEpochSha256 !==
				sha256HexOfBytes(args.cohortWarmupEpochBytes) ||
			receipt.value.cohortWarmupEpochSignatureSha256 !==
				sha256HexOfBytes(args.cohortWarmupEpochSignatureBytes) ||
			receipt.value.roleWarmupCompletionManifestSha256 !==
				sha256HexOfBytes(args.roleWarmupCompletionManifestBytes) ||
			receipt.value.roleWarmupCompletionManifestSignatureSha256 !==
				sha256HexOfBytes(args.roleWarmupCompletionManifestSignatureBytes)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"warmup receipt is joined to warmup records this channel did not send",
			);
		}
		const signed = this.verifyRigRecord({
			signedSchema: "rig-warmup-drained-receipt/v1",
			signedBytes: carried.value.bytes,
			signatureBase64: parsed.value.rigWarmupDrainedReceiptSignatureBase64,
		});
		if (!signed.ok) return signed;
		this.advance("warmup-drained");
		return {
			ok: true,
			value: {
				serverWarmupDrainedBytes: drained.value.bytes,
				receipt: receipt.value,
				receiptBytes: carried.value.bytes,
				signature: signed.value.signature,
				signatureBytes: signed.value.signatureBytes,
			},
		};
	}

	// -- 4. LINUX_BASELINE ---------------------------------------------------

	/**
	 * §5 LINUX_BASELINE: no measured traffic is legal before this ack. The ack
	 * record itself is a Phase-A rig schema, so it is admitted as signed bytes
	 * whose execution join is checked here and re-checked by the Mac side.
	 */
	async measureStart(args: {
		readonly warmupCompleteSha256: Sha256Hex | null;
		readonly rigWarmupDrainedReceiptSha256: Sha256Hex | null;
	}): Promise<ProtocolResult<RigMeasureStartAckBundleV1>> {
		// A fanout baseline is the drain's, and follows it; an ordinary one is
		// read at the instant measured traffic becomes legal, which is the
		// frame after the server child is up. The arm the spawn fixed decides
		// which, and the joins must match it: a fanout baseline names its
		// drain, an ordinary one names nothing.
		const ordinary = this.stageOrder === ORDINARY_RIG_STAGE_ORDER;
		const stage = this.requireStage(
			ordinary ? "server-ready" : "warmup-drained",
			"measureStart",
		);
		if (stage !== null) return stage;
		if (
			ordinary !==
			(args.warmupCompleteSha256 === null &&
				args.rigWarmupDrainedReceiptSha256 === null)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the baseline's warmup joins do not match the arm this channel spawned",
			);
		}
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-measure-start-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				cohortGrantSha256: this.cohortGrantSha256Value,
				warmupCompleteSha256: args.warmupCompleteSha256,
				rigWarmupDrainedReceiptSha256: args.rigWarmupDrainedReceiptSha256,
			},
			"rig-measure-started-ack/v1",
			this.config.deadlines.frameMs,
		);
		if (!ack.ok) return ack;
		const parsed = parsePhaseARigRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-measure-started-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		const carried = this.carried(
			parsed.value.rigMeasureStartAckBase64,
			"rig measure-start ack",
		);
		if (!carried.ok) return carried;
		if (
			carried.value.bytes.byteLength > RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES
		) {
			return rigFail("rig measure-start ack exceeds its cap");
		}
		const record = carried.value.value as Record<string, unknown>;
		if (record.schema !== "rig-measure-start-ack/v1") {
			return rigFail("carried record is not a rig measure-start ack");
		}
		if (record.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"measure-start ack names another execution",
			);
		}
		if (
			record.rigWarmupDrainedReceiptSha256 !==
			args.rigWarmupDrainedReceiptSha256
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"measure-start ack does not name the drained receipt it was asked for",
			);
		}
		const issuedAtMs = record.issuedAtMs;
		const notAfterMs = record.notAfterMs;
		if (
			typeof issuedAtMs !== "number" ||
			!Number.isSafeInteger(issuedAtMs) ||
			issuedAtMs < 0 ||
			typeof notAfterMs !== "number" ||
			!Number.isSafeInteger(notAfterMs) ||
			notAfterMs < issuedAtMs
		) {
			return rigFail("measure-start ack carries no usable validity window");
		}
		const signed = this.verifyRigRecord({
			signedSchema: "rig-measure-start-ack/v1",
			signedBytes: carried.value.bytes,
			signatureBase64: parsed.value.rigMeasureStartAckSignatureBase64,
		});
		if (!signed.ok) return signed;
		this.rigMeasureStartAckSha256Value = sha256HexOfBytes(carried.value.bytes);
		this.advance("baseline-taken");
		return {
			ok: true,
			value: {
				ackBytes: carried.value.bytes,
				signature: signed.value.signature,
				signatureBytes: signed.value.signatureBytes,
				issuedAtMs,
				notAfterMs,
			},
		};
	}

	// -- 5. the start barrier the Mac minted over that baseline --------------

	async presentStartBarrier(args: {
		readonly cohortStartBarrierBytes: Uint8Array;
		readonly cohortStartBarrierSignatureBytes: Uint8Array;
	}): Promise<ProtocolResult<RigBarrierAcceptanceBundleV1>> {
		const arm = this.requireCohortArm("presentStartBarrier");
		if (arm !== null) return arm;
		const stage = this.requireStage("baseline-taken", "presentStartBarrier");
		if (stage !== null) return stage;
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const barrierSha256 = sha256HexOfBytes(args.cohortStartBarrierBytes);
		const barrierSignatureSha256 = sha256HexOfBytes(
			args.cohortStartBarrierSignatureBytes,
		);
		const ack = await this.exchange(
			{
				schema: "rig-present-start-barrier-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				cohortStartBarrierBase64: Buffer.from(
					args.cohortStartBarrierBytes,
				).toString("base64"),
				cohortStartBarrierSignatureBase64: Buffer.from(
					args.cohortStartBarrierSignatureBytes,
				).toString("base64"),
			},
			"rig-barrier-accepted-ack/v1",
			this.config.deadlines.frameMs,
		);
		if (!ack.ok) return ack;
		const parsed = parseCohortRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-barrier-accepted-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		const server = this.carried(
			parsed.value.serverStartBarrierAcceptedBase64,
			"server start-barrier accepted frame",
		);
		if (!server.ok) return server;
		const serverSha256 = sha256HexOfBytes(server.value.bytes);
		if (
			parsed.value.serverStartBarrierAcceptedSha256 !== serverSha256 ||
			parsed.value.serverStartBarrierAcceptedSize !==
				server.value.bytes.byteLength
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"the ack's declared accepted digest/size is not the frame it carried",
			);
		}
		const carried = this.carried(
			parsed.value.rigBarrierAcceptanceBase64,
			"rig barrier acceptance",
		);
		if (!carried.ok) return carried;
		const acceptance = parseRigBarrierAcceptance(carried.value.value);
		if (!acceptance.ok) return acceptance;
		if (
			acceptance.value.executionSha256 !== this.config.executionSha256 ||
			acceptance.value.cohortGrantSha256 !== this.cohortGrantSha256Value
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"barrier acceptance names another execution or cohort",
			);
		}
		if (
			acceptance.value.cohortStartBarrierSha256 !== barrierSha256 ||
			acceptance.value.cohortStartBarrierSignatureSha256 !==
				barrierSignatureSha256 ||
			acceptance.value.serverStartBarrierAcceptedSha256 !== serverSha256 ||
			acceptance.value.rigMeasureStartAckSha256 !==
				this.rigMeasureStartAckSha256Value
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"barrier acceptance is joined to records this channel did not send",
			);
		}
		const signed = this.verifyRigRecord({
			signedSchema: "rig-barrier-acceptance/v1",
			signedBytes: carried.value.bytes,
			signatureBase64: parsed.value.rigBarrierAcceptanceSignatureBase64,
		});
		if (!signed.ok) return signed;
		this.cohortStartBarrierSha256Value = barrierSha256;
		this.advance("barrier-accepted");
		return {
			ok: true,
			value: {
				serverStartBarrierAcceptedBytes: server.value.bytes,
				acceptance: acceptance.value,
				acceptanceBytes: carried.value.bytes,
				signature: signed.value.signature,
				signatureBytes: signed.value.signatureBytes,
			},
		};
	}

	// -- 6. DRAINING: the snapshot and the Linux observation -----------------

	/**
	 * The relay observation triple is all-present or all-absent. A snapshot
	 * with an observation but no receipt, or a receipt with no observation, is
	 * a half-signed fact and is refused rather than carried forward as one.
	 */
	async stopAndCapture(args: {
		readonly macStopIssuedAtNs: NsString;
		readonly drainDeadlineMs: number;
	}): Promise<ProtocolResult<RigCaptureBundleV1>> {
		// The barrier is what makes measured traffic legal on a fanout arm;
		// on an ordinary one the baseline is, so the capture follows whichever
		// of the two this arm actually has.
		const stage = this.requireStage(
			this.stageOrder === ORDINARY_RIG_STAGE_ORDER
				? "baseline-taken"
				: "barrier-accepted",
			"stopAndCapture",
		);
		if (stage !== null) return stage;
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-stop-and-capture-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
				cohortStartBarrierSha256: this.cohortStartBarrierSha256Value,
				macStopIssuedAtNs: args.macStopIssuedAtNs,
				drainDeadlineMs: args.drainDeadlineMs,
			},
			"rig-capture-complete-ack/v1",
			this.config.deadlines.captureMs,
		);
		if (!ack.ok) return ack;
		const parsed = parsePhaseARigRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-capture-complete-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		const snapshot = this.carried(
			parsed.value.snapshotFrameBase64,
			"server snapshot frame",
		);
		if (!snapshot.ok) return snapshot;
		const snapshotReceipt = this.carried(
			parsed.value.rigServerSnapshotReceiptBase64,
			"rig server snapshot receipt",
		);
		if (!snapshotReceipt.ok) return snapshotReceipt;
		const snapshotRecord = snapshotReceipt.value.value as Record<
			string,
			unknown
		>;
		if (snapshotRecord.schema !== "rig-server-snapshot-receipt/v1") {
			return rigFail("carried record is not a rig server snapshot receipt");
		}
		if (snapshotRecord.executionSha256 !== this.config.executionSha256) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"snapshot receipt names another execution",
			);
		}
		const snapshotSigned = this.verifyRigRecord({
			signedSchema: "rig-server-snapshot-receipt/v1",
			signedBytes: snapshotReceipt.value.bytes,
			signatureBase64: parsed.value.rigServerSnapshotReceiptSignatureBase64,
		});
		if (!snapshotSigned.ok) return snapshotSigned;

		const relayParts = [
			parsed.value.linuxRelayObservationBase64,
			parsed.value.rigRelayObservationReceiptBase64,
			parsed.value.rigRelayObservationReceiptSignatureBase64,
		];
		const presentCount = relayParts.filter((part) => part !== null).length;
		if (presentCount !== 0 && presentCount !== relayParts.length) {
			return rigFail(
				"the relay observation triple is neither wholly present nor wholly absent",
			);
		}
		if (presentCount === 0) {
			this.advance("captured");
			return {
				ok: true,
				value: {
					snapshotFrameBytes: snapshot.value.bytes,
					snapshotReceiptBytes: snapshotReceipt.value.bytes,
					snapshotSignature: snapshotSigned.value.signature,
					snapshotSignatureBytes: snapshotSigned.value.signatureBytes,
					linuxRelayObservationBytes: null,
					relayObservationReceipt: null,
					relayObservationReceiptBytes: null,
					relayObservationSignature: null,
					relayObservationSignatureBytes: null,
				},
			};
		}
		const observation = this.carried(
			parsed.value.linuxRelayObservationBase64,
			"linux relay observation",
		);
		if (!observation.ok) return observation;
		if (
			observation.value.bytes.byteLength > LINUX_RELAY_OBSERVATION_MAX_BYTES
		) {
			return rigFail("linux relay observation exceeds its cap");
		}
		const relayCarried = this.carried(
			parsed.value.rigRelayObservationReceiptBase64,
			"rig relay observation receipt",
		);
		if (!relayCarried.ok) return relayCarried;
		const relayReceipt = parseRigRelayObservationReceipt(
			relayCarried.value.value,
		);
		if (!relayReceipt.ok) return relayReceipt;
		if (
			relayReceipt.value.executionSha256 !== this.config.executionSha256 ||
			relayReceipt.value.cohortGrantSha256 !== this.cohortGrantSha256Value ||
			relayReceipt.value.cohortStartBarrierSha256 !==
				this.cohortStartBarrierSha256Value
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"relay receipt names another execution, cohort or barrier",
			);
		}
		if (
			relayReceipt.value.linuxRelayObservationSha256 !==
			sha256HexOfBytes(observation.value.bytes)
		) {
			return macFail(
				"CROSS_SUPERVISOR_MISMATCH",
				"relay receipt does not cover the observation it was carried with",
			);
		}
		const relaySigned = this.verifyRigRecord({
			signedSchema: "rig-relay-observation-receipt/v1",
			signedBytes: relayCarried.value.bytes,
			signatureBase64: parsed.value.rigRelayObservationReceiptSignatureBase64,
		});
		if (!relaySigned.ok) return relaySigned;
		this.advance("captured");
		return {
			ok: true,
			value: {
				snapshotFrameBytes: snapshot.value.bytes,
				snapshotReceiptBytes: snapshotReceipt.value.bytes,
				snapshotSignature: snapshotSigned.value.signature,
				snapshotSignatureBytes: snapshotSigned.value.signatureBytes,
				linuxRelayObservationBytes: observation.value.bytes,
				relayObservationReceipt: relayReceipt.value,
				relayObservationReceiptBytes: relayCarried.value.bytes,
				relayObservationSignature: relaySigned.value.signature,
				relayObservationSignatureBytes: relaySigned.value.signatureBytes,
			},
		};
	}

	// -- 7. TEARDOWN: the server child, reaped ---------------------------------

	/** Whether this channel has a server child to tear down. */
	get serverChildLive(): boolean {
		return COHORT_RIG_TEARDOWN_STAGES.includes(this.stageValue);
	}

	/**
	 * §5 step 16 (plan 2191): stop the rig's server child and take the rig's
	 * verdict that it was reaped. `reaped: true` is the ack's whole point and
	 * the registered shape admits no other value; a rig that could not bound
	 * its child answers with a refusal, never with this ack.
	 */
	async teardownServer(): Promise<ProtocolResult<RigServerStoppedV1>> {
		if (!this.serverChildLive) {
			return notReadyFail(
				`teardownServer is legal only while the rig holds a server child, not at stage ${this.stageValue}`,
			);
		}
		const seq = this.nextRequestSeq();
		if (!seq.ok) return seq;
		const ack = await this.exchange(
			{
				schema: "rig-teardown-server-request/v1",
				requestSeq: seq.value,
				executionSha256: this.config.executionSha256,
			},
			"rig-server-stopped-ack/v1",
			this.config.deadlines.teardownMs,
		);
		if (!ack.ok) return ack;
		const parsed = parsePhaseARigRemotePayload(ack.value);
		if (!parsed.ok) return parsed;
		if (parsed.value.schema !== "rig-server-stopped-ack/v1") {
			return rigFail("ack schema moved after the header was read");
		}
		// Teardown is legal from several stages, so this is not one
		// `advance` step: the child is stopped whichever stage it was at.
		this.stageValue = "server-stopped";
		return {
			ok: true,
			value: { exitCode: parsed.value.exitCode, signal: parsed.value.signal },
		};
	}
}

// ---------------------------------------------------------------------------
// The production Mac role-child host (plan sections 4.3 and 3.4)
//
// `MacFanoutSupervisorConfig` names three seams -- `MacCohortMinter`,
// `MacFanoutChildSpawner` and `MacFanoutProcessControl` -- and until now every
// implementer of them lived in a test file, so `createCohortArmRuntimeProvider`
// refused `COHORT_NOT_READY` naming exactly those three. The host below is the
// production implementer of all three, plus the thing the spawner is useless
// without: the supervisor half of the role-child control pipe.
//
// The three seams are deliberately produced by one object rather than three
// free functions. A spawner that does not own the control pipes cannot hand
// anyone a reader for them, and a process control that does not know which
// spawn produced which PGID cannot reap the group it started. Splitting them
// would mean a second registry keyed by child ID, maintained by the caller,
// which is exactly the bookkeeping that goes wrong quietly.
// ---------------------------------------------------------------------------

/** How often `waitPgid` re-checks a group it is waiting on. */
export const MAC_ROLE_CHILD_REAP_POLL_MS = 20;

/**
 * Sleep the calling thread without a timer callback.
 *
 * `waitPgid` is synchronous by contract -- `MacFanoutSupervisor.teardown` calls
 * it inside a loop that must finish before it returns a reap record -- so this
 * cannot be a promise. `Atomics.wait` on a never-notified word is the sleep
 * that does not need a runtime-specific helper.
 */
function sleepSyncMs(ms: number): void {
	if (ms <= 0) return;
	const word = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(word, 0, 0, ms);
}

/**
 * True while `pgid` still holds a process this host could signal.
 *
 * Both failure codes mean the group is finished, and the second one is the
 * non-obvious half. `kill(2)` against a process group whose every member is a
 * zombie returns `EPERM` on Darwin -- for signal 0 as well as for a real
 * signal, because an exited process no longer carries the credentials the
 * permission check reads. Measured, not assumed: a `sleep` spawned detached and
 * left unreaped answers `EPERM` to `kill(-pgid, 0)`, `SIGCONT` and `SIGKILL`
 * alike while `ps` reports it `Z <defunct>`.
 *
 * Reading `EPERM` as "still running" is what makes a bounded reap unbounded:
 * `waitPgid` is synchronous, so while it polls, this process cannot run the
 * `SIGCHLD` handler that would turn the zombie into a reaped child, and the
 * group would stay `EPERM` until the deadline every single time. Every PGID
 * this control is ever addressed at was created by the host beside it, so
 * `EPERM` cannot mean "a stranger's group" here.
 */
function processGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EPERM";
	}
}

/**
 * The real `kill(2)`/`waitpid` pair, addressed at the process *group*.
 *
 * Every role child is spawned into its own session, so the group is exactly one
 * child and its descendants; signalling `-pgid` is what makes a child that
 * forked a helper unable to outlive its own teardown.
 */
export function createMacFanoutProcessControl(options?: {
	readonly pollIntervalMs?: number;
	/** Injected only so a test can watch the signals without a real group. */
	readonly kill?: (target: number, signal: number | string) => void;
	readonly alive?: (pgid: number) => boolean;
	readonly nowMs?: () => number;
	readonly sleepMs?: (ms: number) => void;
}): MacFanoutProcessControl {
	const pollIntervalMs = options?.pollIntervalMs ?? MAC_ROLE_CHILD_REAP_POLL_MS;
	const kill =
		options?.kill ??
		((target: number, signal: number | string): void => {
			process.kill(target, signal as NodeJS.Signals);
		});
	const alive = options?.alive ?? processGroupAlive;
	const nowMs = options?.nowMs ?? (() => Date.now());
	const sleepMs = options?.sleepMs ?? sleepSyncMs;
	return {
		killPgid: (pgid, signal) => {
			try {
				kill(-pgid, signal);
			} catch (error: unknown) {
				const code = (error as NodeJS.ErrnoException).code;
				// A group that is already gone (`ESRCH`) or holds only zombies
				// (`EPERM`, see `processGroupAlive`) is the outcome the caller
				// wanted; anything else is a fault the teardown must not swallow.
				if (code !== "ESRCH" && code !== "EPERM") throw error;
			}
		},
		waitPgid: (pgid, deadlineMs) => {
			const until = nowMs() + Math.max(0, deadlineMs);
			for (;;) {
				if (!alive(pgid)) return true;
				if (nowMs() >= until) return false;
				sleepMs(pollIntervalMs);
			}
		},
	};
}

// -- the supervisor half of the role-child control pipe ---------------------

/** Why a role-child control channel refused, before the record layer sees it. */
export type MacRoleChildChannelRefusal = {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
};

/** One accepted child -> supervisor frame: the record and the bytes it came in. */
export interface MacRoleChildInboundFrame {
	readonly record: Record<string, unknown>;
	/** The canonical JSON payload, with the `u32be` length prefix removed. */
	readonly bytes: Uint8Array;
}

export interface MacRoleChildControlChannelConfig {
	readonly childId: string;
	/** Section 3.4: `2 * assignedSessionCount + 64`, per direction. */
	readonly maxFramesPerDirection: number;
	/** Parent end of the child's FD 4 (child -> supervisor). */
	readonly readFd: number;
	/** Parent end of the child's FD 3 (supervisor -> child). */
	readonly writeFd: number;
	/** Bounded wait for one inbound frame. */
	readonly receiveDeadlineMs: number;
	readonly read?: MacRoleChildPipeRead;
	readonly write?: MacRoleChildPipeWrite;
}

export type MacRoleChildPipeRead = (fd: number) => Promise<Uint8Array | null>;
export type MacRoleChildPipeWrite = (
	fd: number,
	bytes: Uint8Array,
) => Promise<void>;

function readChunkFromFd(fd: number): Promise<Uint8Array | null> {
	return new Promise((resolve, reject) => {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		nodeFsRead(fd, buffer, 0, buffer.byteLength, null, (error, read) => {
			if (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// A child that exited closed its write end; that is EOF, not a fault.
				if (code === "EOF" || code === "EBADF") resolve(null);
				else reject(error);
				return;
			}
			resolve(read === 0 ? null : new Uint8Array(buffer.subarray(0, read)));
		});
	});
}

function writeAllToFd(fd: number, bytes: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		let written = 0;
		const step = (): void => {
			nodeFsWrite(
				fd,
				bytes,
				written,
				bytes.byteLength - written,
				null,
				(error, count) => {
					if (error) {
						reject(error);
						return;
					}
					written += count;
					if (written >= bytes.byteLength) resolve();
					else step();
				},
			);
		};
		step();
	});
}

/**
 * One role child's control pipe, from the supervisor's side.
 *
 * This is blocker 9 of the B3.5 deviation record: `role-warmup-complete/v1` and
 * `role-partial/v1` had parsers and a producer (the child writes both) and no
 * consumer anywhere, so `runWarmupWire` and `runMeasuredWindow` could only
 * refuse. The framing is section 3.4's exactly: `u32be length || canonical
 * JSON`, one independent sequence per direction, and a per-direction ceiling
 * that scales with the child's assigned sessions.
 *
 * Three properties are worth stating because they are what make the reader safe
 * rather than merely working:
 *
 * - a frame whose schema is not the one the lifecycle expects is refused
 *   (`STATE_INVALID`) rather than buffered for later, so a child cannot
 *   reorder the lifecycle by sending its partial early;
 * - the length prefix is bounded before a byte is buffered for it, by
 *   `RoleChildFrameReader`, so an oversize declaration cannot make the
 *   supervisor allocate;
 * - a channel that refuses once is poisoned. Recovering would mean reading the
 *   rest of a stream whose framing is already known to be untrustworthy.
 */
export class MacRoleChildControlChannel {
	readonly childId: string;
	private readonly config: MacRoleChildControlChannelConfig;
	private readonly sequence: ChildSequenceState = createChildSequenceState();
	private readonly reader: RoleChildFrameReader;
	private readonly ready: Uint8Array[] = [];
	private readonly read: MacRoleChildPipeRead;
	private readonly write: MacRoleChildPipeWrite;
	private poisoned: string | null = null;
	private closed = false;

	constructor(config: MacRoleChildControlChannelConfig) {
		if (
			!Number.isSafeInteger(config.maxFramesPerDirection) ||
			config.maxFramesPerDirection <= 0
		) {
			throw new RangeError("maxFramesPerDirection must be a positive integer");
		}
		this.childId = config.childId;
		this.config = config;
		this.reader = new RoleChildFrameReader();
		this.read = config.read ?? readChunkFromFd;
		this.write = config.write ?? writeAllToFd;
	}

	/** Frames the supervisor has sent on this channel so far. */
	get sentCount(): number {
		return this.sequence.outbound;
	}

	/** Frames the supervisor has accepted from this child so far. */
	get receivedCount(): number {
		return this.sequence.inbound;
	}

	get refusal(): string | null {
		return this.poisoned;
	}

	private poison(code: string, message: string): MacRoleChildChannelRefusal {
		this.poisoned ??= `${code}: ${message}`;
		return { ok: false, code, message: `${this.childId}: ${message}` };
	}

	/** Stamp, encode and write one supervisor -> child frame. */
	async send<T extends { readonly schema: string }>(
		payload: T,
	): Promise<ProtocolResult<number>> {
		if (this.poisoned !== null) {
			return protocolFail(
				`${this.childId} channel is poisoned: ${this.poisoned}`,
			);
		}
		if (this.closed) return protocolFail(`${this.childId} channel is closed`);
		const sequence = this.sequence.outbound;
		const bounded = assertChildOutboundSequence(
			this.sequence,
			sequence,
			this.config.maxFramesPerDirection,
		);
		if (!bounded.ok) {
			return this.poison(bounded.code, bounded.message ?? "outbound sequence");
		}
		const encoded = encodeRoleChildFrame({
			...(payload as Record<string, unknown>),
			schema: payload.schema,
			sequence,
		});
		if (!encoded.ok) {
			return this.poison(encoded.code, encoded.message ?? "encode");
		}
		try {
			await this.write(this.config.writeFd, encoded.value);
		} catch (error: unknown) {
			return this.poison("CHILD_LIFECYCLE", `write failed: ${String(error)}`);
		}
		return { ok: true, value: sequence };
	}

	/**
	 * Read the next child -> supervisor frame and require it to be
	 * `expectedSchema`.
	 *
	 * The deadline is the caller's: a child that never answers is
	 * `READY_DEADLINE_EXCEEDED` / `WARMUP_DEADLINE_EXCEEDED` /
	 * `MEASURE_DEADLINE_EXCEEDED` depending on where the lifecycle was, and the
	 * caller is the only one that knows which. This method reports
	 * `deadlineCode` and poisons the channel.
	 */
	async receive(
		expectedSchema: string,
		options?: { readonly deadlineMs?: number; readonly deadlineCode?: string },
	): Promise<ProtocolResult<MacRoleChildInboundFrame>> {
		if (this.poisoned !== null) {
			return protocolFail(
				`${this.childId} channel is poisoned: ${this.poisoned}`,
			);
		}
		if (this.closed) return protocolFail(`${this.childId} channel is closed`);
		const deadlineMs = options?.deadlineMs ?? this.config.receiveDeadlineMs;
		const deadlineCode = options?.deadlineCode ?? "CHILD_LIFECYCLE";
		const until = Date.now() + Math.max(0, deadlineMs);

		for (;;) {
			const framed = this.ready.shift();
			if (framed !== undefined) {
				const decoded = decodeRoleChildFrame(framed, expectedSchema);
				if (!decoded.ok) {
					return this.poison(decoded.code, decoded.message ?? "frame");
				}
				const inbound = assertChildInboundSequence(
					this.sequence,
					decoded.value.sequence as number,
					this.config.maxFramesPerDirection,
				);
				if (!inbound.ok) {
					return this.poison(
						inbound.code,
						inbound.message ?? "inbound sequence",
					);
				}
				// The payload bytes, not a re-encode: `retainRoleWarmupComplete` and
				// `acceptRolePartial` digest exactly what the child wrote, and a
				// re-encode of the parsed record is a different byte string the
				// moment anything about canonical form drifts.
				return {
					ok: true,
					value: { record: decoded.value, bytes: framed.slice(4) },
				};
			}
			const remaining = until - Date.now();
			if (remaining <= 0) {
				return this.poison(
					deadlineCode,
					`no ${expectedSchema} within ${deadlineMs}ms`,
				);
			}
			let chunk: Uint8Array | null | undefined;
			try {
				chunk = await Promise.race([
					this.read(this.config.readFd),
					new Promise<"timeout">((resolve) => {
						const timer = setTimeout(() => resolve("timeout"), remaining);
						if (typeof timer.unref === "function") timer.unref();
					}).then(() => "timeout" as const),
				]).then((value) => (value === "timeout" ? undefined : value));
			} catch (error: unknown) {
				return this.poison("CHILD_LIFECYCLE", `read failed: ${String(error)}`);
			}
			if (chunk === undefined) continue;
			if (chunk === null) {
				return this.poison(
					"UNEXPECTED_EOF",
					`control pipe ended before ${expectedSchema}`,
				);
			}
			const pushed = this.reader.push(chunk);
			if (!pushed.ok) {
				return this.poison(pushed.code, pushed.message ?? "framing");
			}
			this.ready.push(...pushed.value);
		}
	}

	/** Close both parent ends. Idempotent; a closed channel refuses. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		safeClose(this.config.readFd);
		safeClose(this.config.writeFd);
	}
}

// -- the spawner and the host that owns it ----------------------------------

/**
 * The two facts a spawned role child cannot learn from a frame it has not read
 * yet: which staged Mac key its spawn config must name, and what the token
 * descriptor looked like on the parent's side before the child existed.
 *
 * They are environment variables and not frames on purpose. The child checks
 * FD 5 *before* it will read a spawn config, so a spawn-time observation
 * delivered on the control pipe would arrive after the check it exists for.
 */
export const MAC_ROLE_CHILD_STAGED_KEY_ENV = "WT_COMPARE_STAGED_MAC_KEY_SHA256";
export const MAC_ROLE_CHILD_TOKEN_FD_OBSERVATION_ENV =
	"WT_COMPARE_TOKEN_FD_OBSERVATION";

export interface MacFanoutRoleChildHostConfig {
	/** The staged Bun that runs the role entrypoint. */
	readonly bunExecutablePath: string;
	/** Absolute path to the staged `bin/fanout-role.ts`. */
	readonly roleEntrypointPath: string;
	readonly transport: "ws" | "wt";
	/** The digest the child requires its spawn config's Mac key to match. */
	readonly stagedMacSigningPublicKeySha256: Sha256Hex;
	/** Bounded wait for one inbound frame on any child's control pipe. */
	readonly receiveDeadlineMs: number;
	/** Extra environment for the child; the two host variables always win. */
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	/** Called with whatever a child writes to stderr, line-buffered by chunk. */
	readonly onChildStderr?: (childId: string, text: string) => void;
	/** Injected only so a test can spawn something other than a role child. */
	readonly spawn?: MacRoleChildProcessSpawn;
}

/** What the host needs back from whatever actually forks. */
export interface MacRoleChildProcessHandle {
	readonly pid: number;
	readonly onStderr: (listener: (text: string) => void) => void;
	readonly exited: Promise<number>;
}

export type MacRoleChildProcessSpawn = (args: {
	readonly command: string;
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string | undefined;
	/** Child slots 3, 4, 5 in order; the host has already opened all three. */
	readonly inheritedFds: readonly [number, number, number];
}) => MacRoleChildProcessHandle;

export interface MacFanoutRoleChildHost {
	/** The `MacFanoutSupervisorConfig.spawnChild` seam. */
	readonly spawnChild: MacFanoutChildSpawner;
	/** The `MacFanoutSupervisorConfig.processControl` seam. */
	readonly processControl: MacFanoutProcessControl;
	/** The control pipe of one spawned child, or undefined before its spawn. */
	channel(childId: string): MacRoleChildControlChannel | undefined;
	readonly channels: ReadonlyMap<string, MacRoleChildControlChannel>;
	/** Every child this host started, in spawn order. */
	readonly spawned: readonly {
		readonly childId: string;
		readonly pid: number;
		readonly pgid: number;
	}[];
	/**
	 * Move one child's control channel out of the live set, closing nothing.
	 *
	 * Plan 2210's pre-readiness replacement re-spawns the same child ids
	 * (`publisher-child-${index}` / `subscriber-worker-${worker}` carry no
	 * attempt), and `spawnChild` refuses a childId already in `channels`, so
	 * without this the replacement could never spawn attempt 2 -- proved by
	 * execution in `.scratch/2026-09-05-cohort-completion/notes/reliability-gate.md`
	 * section 3.
	 *
	 * It closes nothing on purpose. The parent-held read end of a retired
	 * child's pipe may have a blocking `fs.read` pending on Bun's thread pool
	 * (the ramp fails on one child while its seventeen siblings are still in
	 * `registerRolePeers`), and closing a descriptor out from under an
	 * in-flight read is the double-close/EBADF family. The retired channel is
	 * kept and closed by `closeAll` with the live ones.
	 *
	 * Returns whether a live channel by that id was retired.
	 */
	retireChild(childId: string): boolean;
	/** Channels retired by `retireChild`, still open, in retirement order. */
	readonly retired: readonly MacRoleChildControlChannel[];
	/** Close every parent-held pipe end, live and retired. Safe to repeat. */
	closeAll(): void;
}

/**
 * Spawn real `bin/fanout-role.ts` children with exactly the three descriptors
 * section 3.4 allows, each in its own session.
 *
 * The FD mapping is the whole point. `node:child_process` is used rather than
 * `Bun.spawn` for the same reason `spawnMacSupervisor` uses it: numbers in the
 * `stdio` array are `dup2`'d onto the child's slots in order, so slot 3 is the
 * control read end, slot 4 is the control write end and slot 5 is the sealed
 * token descriptor -- exactly the layout `MacFanoutChildPlanV1` declares and the
 * child asserts. `dup2` clears `FD_CLOEXEC` on the copy, which is how the
 * `O_CLOEXEC` descriptor `sealTokenBundleFd` opened reaches the child without
 * the supervisor ever clearing the flag on its own copy.
 *
 * `detached: true` is `setsid(2)`: the child's PGID equals its PID and no role
 * child shares a group with another, which is what makes `killPgid` able to
 * take down a child and anything it forked without touching its siblings.
 */
/**
 * The ambient keys a role child may inherit: the executable search path the
 * staged launch record allows, and the two Bun needs to run at all without
 * touching a home directory it must not have.
 */
const ROLE_CHILD_INHERITED_ENV_KEYS = ["PATH", "HOME", "TMPDIR"] as const;

export function closedRoleChildEnvironment(
	ambient: NodeJS.ProcessEnv,
): Record<string, string> {
	const closed: Record<string, string> = {};
	for (const key of ROLE_CHILD_INHERITED_ENV_KEYS) {
		const value = ambient[key];
		if (typeof value === "string" && value.length > 0) closed[key] = value;
	}
	return closed;
}

export function createMacFanoutRoleChildHost(
	config: MacFanoutRoleChildHostConfig,
): MacFanoutRoleChildHost {
	const channels = new Map<string, MacRoleChildControlChannel>();
	const retired: MacRoleChildControlChannel[] = [];
	const spawned: {
		readonly childId: string;
		readonly pid: number;
		readonly pgid: number;
	}[] = [];

	const spawn: MacRoleChildProcessSpawn =
		config.spawn ??
		((args) => {
			const child = nodeSpawn(args.command, [...args.argv], {
				stdio: [
					"ignore",
					"ignore",
					"pipe",
					args.inheritedFds[0],
					args.inheritedFds[1],
					args.inheritedFds[2],
				],
				detached: true,
				env: { ...args.env },
				...(args.cwd === undefined ? {} : { cwd: args.cwd }),
			}) as ChildProcessWithoutNullStreams;
			return {
				pid: child.pid ?? -1,
				onStderr: (listener) => {
					child.stderr?.on("data", (chunk: Buffer) => {
						listener(chunk.toString("utf8"));
					});
				},
				exited: new Promise<number>((resolve) => {
					child.once("exit", (code) => resolve(code ?? -1));
				}),
			};
		});

	const spawnChild: MacFanoutChildSpawner = (request) => {
		if (
			request.inheritedChildFds.length !== 3 ||
			request.inheritedChildFds[0] !== MAC_FANOUT_CONTROL_READ_FD ||
			request.inheritedChildFds[1] !== MAC_FANOUT_CONTROL_WRITE_FD ||
			request.inheritedChildFds[2] !== TOKEN_BUNDLE_FD
		) {
			return protocolFail(
				`a role child inherits exactly FDs ${MAC_FANOUT_CONTROL_READ_FD}, ${MAC_FANOUT_CONTROL_WRITE_FD} and ${TOKEN_BUNDLE_FD}`,
			);
		}
		if (channels.has(request.plan.childId)) {
			return protocolFail(`${request.plan.childId} was already spawned`);
		}

		// The observation is taken here, of the descriptor this host is about to
		// hand over, rather than restated from the seal: the child compares it
		// against what it measures on FD 5, and a spawn-side claim that was not
		// measured on the spawn side would make that comparison vacuous.
		let observation: TokenBundleFdObservationV1;
		try {
			const stat = fstatSync(request.tokenBundleReadFd);
			observation = {
				schema: "token-bundle-fd-observation/v1",
				fd: TOKEN_BUNDLE_FD,
				fileKind: stat.isFile() ? "regular" : "fifo",
				accessMode: "read-only",
				appendMode: false,
				hardLinkCount: stat.nlink,
				deviceId: stat.dev.toString(),
				inode: stat.ino.toString(),
				byteSize: request.tokenBundleSize,
				contentSha256: request.tokenBundleSha256,
			};
		} catch (error: unknown) {
			return protocolFail(
				`token descriptor for ${request.plan.childId} is not observable: ${String(error)}`,
			);
		}
		if (
			observation.byteSize !== Number(fstatSync(request.tokenBundleReadFd).size)
		) {
			return protocolFail(
				`${request.plan.childId}'s sealed bundle is not the size the spawn request states`,
			);
		}
		const validated = parseTokenBundleFdObservation(observation);
		if (!validated.ok) return validated;

		const inbound = createCloexecPipe({ parentKeeps: "write" });
		if (!inbound.ok) return protocolFail(inbound.message);
		const outbound = createCloexecPipe({ parentKeeps: "read" });
		if (!outbound.ok) {
			safeClose(inbound.pipe.childFd);
			safeClose(inbound.pipe.parentFd);
			return protocolFail(outbound.message);
		}

		let handle: MacRoleChildProcessHandle;
		try {
			handle = spawn({
				command: config.bunExecutablePath,
				argv: [config.roleEntrypointPath, `--transport=${config.transport}`],
				// A closed environment: the staged launch record allows PATH and
				// nothing else ambient, and a role child that inherited the
				// controller's environment would inherit every path-shaped knob
				// the controller's shell happened to carry (the package's
				// WEBTRANSPORT_NATIVE_ADDON_PATH override among them). What the
				// child needs is stated by the host config, one key at a time.
				env: {
					...closedRoleChildEnvironment(process.env),
					...config.env,
					[MAC_ROLE_CHILD_STAGED_KEY_ENV]:
						config.stagedMacSigningPublicKeySha256,
					[MAC_ROLE_CHILD_TOKEN_FD_OBSERVATION_ENV]:
						JSON.stringify(observation),
				} as Record<string, string>,
				cwd: config.cwd,
				inheritedFds: [
					inbound.pipe.childFd,
					outbound.pipe.childFd,
					request.tokenBundleReadFd,
				],
			});
		} catch (error: unknown) {
			safeClose(inbound.pipe.childFd);
			safeClose(inbound.pipe.parentFd);
			safeClose(outbound.pipe.childFd);
			safeClose(outbound.pipe.parentFd);
			return protocolFail(
				`spawning ${request.plan.childId} failed: ${String(error)}`,
			);
		}
		// The child owns its ends now; a parent that kept them would never see
		// EOF when the child exits.
		safeClose(inbound.pipe.childFd);
		safeClose(outbound.pipe.childFd);

		if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1) {
			safeClose(inbound.pipe.parentFd);
			safeClose(outbound.pipe.parentFd);
			return protocolFail(
				`${request.plan.childId} spawned without a usable pid (${handle.pid})`,
			);
		}
		if (config.onChildStderr !== undefined) {
			const onStderr = config.onChildStderr;
			handle.onStderr((text) => onStderr(request.plan.childId, text));
		}

		channels.set(
			request.plan.childId,
			new MacRoleChildControlChannel({
				childId: request.plan.childId,
				maxFramesPerDirection: roleChildMaxFramesPerDirection(
					request.plan.assignedGlobalOrdinals.length,
				),
				readFd: outbound.pipe.parentFd,
				writeFd: inbound.pipe.parentFd,
				receiveDeadlineMs: config.receiveDeadlineMs,
			}),
		);
		// `setsid` makes the session leader's PGID its own PID; asserting the
		// identity here is what lets `killPgid` address the group by the number
		// the supervisor recorded.
		spawned.push({
			childId: request.plan.childId,
			pid: handle.pid,
			pgid: handle.pid,
		});
		return { ok: true, value: { pid: handle.pid, pgid: handle.pid } };
	};

	return {
		spawnChild,
		processControl: createMacFanoutProcessControl(),
		channel: (childId) => channels.get(childId),
		channels,
		spawned,
		retired,
		retireChild: (childId) => {
			const channel = channels.get(childId);
			if (channel === undefined) return false;
			channels.delete(childId);
			retired.push(channel);
			return true;
		},
		closeAll: () => {
			for (const channel of channels.values()) channel.close();
			for (const channel of retired) channel.close();
		},
	};
}

// -- the production cohort minter -------------------------------------------

/**
 * Where one attempt's token material comes from.
 *
 * Injected rather than computed here, and required rather than defaulted, for
 * one reason: section 4.1 says the supervisor mints tokens with 32 *random*
 * bytes, and the only builder in the tree that produces a complete leaf set,
 * Merkle root, per-role proofs and shards -- `buildFanoutCohortFixture` in
 * `scenarios/fanout-relay.ts` -- derives each token from `sha256(cohortId ||
 * roleId)`. That derivation is deterministic in a value the *grant carries*, so
 * anyone holding the grant can recompute every raw token. Defaulting to it here
 * would ship that property as the production minting rule with no one having
 * decided to.
 *
 * The minter therefore takes the material and validates it. Closing the gap is
 * a one-parameter change to `buildFanoutCohortFixture` (an optional
 * `tokenFor(roleId)` source, defaulting to today's derivation so no existing
 * caller moves); it is recorded in `.scratch/b35r2-notes/mac-child-host.md`
 * because that file is not in this slice.
 */
export type MacCohortTokenMaterialSource = (args: {
	readonly cohortId: string;
	readonly cohortAttempt: number;
	readonly publisherCount: number;
	readonly subscriberCount: number;
}) => MacProductionCohortTokenMaterialV1;

/** The token facts a grant has to be built from, in one shape. */
export interface MacProductionCohortTokenMaterialV1 {
	readonly publishers: readonly PublisherRoleGrantV1[];
	readonly subscriberShards: readonly SubscriberShardV1[];
	readonly leaves: readonly TokenCommitmentLeafV1[];
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly roleTokenCommitmentCount: number;
	readonly tokenBase64ByRoleId: ReadonlyMap<string, Base64>;
	readonly tokenSha256ByRoleId: ReadonlyMap<string, Sha256Hex>;
	readonly commitmentIndexByRoleId: ReadonlyMap<string, number>;
	readonly proofByRoleId: ReadonlyMap<string, readonly Sha256Hex[]>;
	readonly workerIndexByRoleId: ReadonlyMap<string, number | null>;
}

/**
 * What the production minter needs: the token source and two optional
 * choices. Every grant-only input the earlier spec carried is gone with the
 * TypeScript grant constructor (design §2.9(2g)); the execution digest and the
 * cardinalities arrive per attempt from the supervisor that owns them.
 */
export interface MacProductionCohortMintSpec {
	readonly tokenMaterial: MacCohortTokenMaterialSource;
	/**
	 * The cohort ID for an attempt. It must differ per attempt -- the supervisor
	 * refuses a replacement whose token root repeats -- and the default binds it
	 * to the supervisor's own grant nonce, which is derived from the execution,
	 * the supervisor instance nonce and the attempt.
	 */
	readonly cohortIdFor?: (args: {
		readonly cohortAttempt: number;
		readonly grantNonceSha256: Sha256Hex;
	}) => string;
	/**
	 * Called with each attempt's leaf manifest and material. `driveCohortArm`
	 * has to hand the supervisor the exact manifest bytes the grant commits to,
	 * and the minter is the only place that knows them.
	 */
	readonly onMinted?: (minted: {
		readonly cohortAttempt: number;
		readonly cohortId: string;
		readonly material: MacProductionCohortTokenMaterialV1;
		readonly leafManifest: TokenCommitmentLeafManifestV1;
		readonly leafManifestBytes: Uint8Array;
	}) => void;
}

/**
 * The production `MacCohortMinter`.
 *
 * `MacFanoutSupervisor.openCohort` already re-checks nearly everything this
 * builds -- the execution digest, the attempt, all four cardinalities, the
 * token root, and that a replacement reused neither the nonce nor the root --
 * so the minter's job is to state the grant once, from the spec, and never to
 * carry a value the supervisor cannot check. The two derived quantities are
 * derived rather than passed for exactly that reason:
 * `expectedExpandedDeliveries` is the fanout identity, and the leaf manifest
 * digest is the digest of the manifest this minter itself built.
 */
export function createMacProductionCohortMinter(
	spec: MacProductionCohortMintSpec,
): MacCohortMinter {
	return ({
		cohortAttempt,
		grantNonceSha256,
		executionSha256,
		publisherCount,
		subscriberCount,
	}) => {
		const cohortId =
			spec.cohortIdFor?.({ cohortAttempt, grantNonceSha256 }) ??
			`cohort-${grantNonceSha256.slice(0, 32)}-${cohortAttempt}`;
		const material = spec.tokenMaterial({
			cohortId,
			cohortAttempt,
			publisherCount,
			subscriberCount,
		});
		const leafManifest: TokenCommitmentLeafManifestV1 = {
			schema: "token-commitment-leaf-manifest/v1",
			executionSha256,
			cohortId,
			leafCount: material.leaves.length,
			leaves: [...material.leaves],
			roleTokenCommitmentRootSha256: material.roleTokenCommitmentRootSha256,
		};
		const leafManifestBytes = bytesOfCanonical(leafManifest);

		spec.onMinted?.({
			cohortAttempt,
			cohortId,
			material,
			leafManifest,
			leafManifestBytes,
		});
		return {
			tokens: {
				roleTokenCommitmentRootSha256: material.roleTokenCommitmentRootSha256,
				roleTokenCommitmentCount: material.roleTokenCommitmentCount,
				tokenSha256ByRoleId: material.tokenSha256ByRoleId,
				workerIndexByRoleId: material.workerIndexByRoleId,
			},
			leafManifestBytes,
			publishers: material.publishers,
			subscriberShards: material.subscriberShards,
		};
	};
}

/**
 * The bundle one planned child is handed on FD 5, built from minted material.
 *
 * The supervisor seals whatever this returns and never sees the tokens again;
 * building it here rather than in the caller is what keeps the entry order and
 * the proof arrays tied to the same material the grant committed to.
 */
export function macTokenBundleForPlan(args: {
	readonly plan: MacFanoutChildPlanV1;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly material: MacProductionCohortTokenMaterialV1;
}): ProtocolResult<TokenBundleV1> {
	const entries: TokenBundleEntryV1[] = [];
	for (const roleId of args.plan.assignedRoleIds) {
		const tokenBase64 = args.material.tokenBase64ByRoleId.get(roleId);
		const tokenSha256 = args.material.tokenSha256ByRoleId.get(roleId);
		const tokenCommitmentIndex =
			args.material.commitmentIndexByRoleId.get(roleId);
		const proof = args.material.proofByRoleId.get(roleId);
		if (
			tokenBase64 === undefined ||
			tokenSha256 === undefined ||
			tokenCommitmentIndex === undefined ||
			proof === undefined
		) {
			return protocolFail(
				`minted material has no token for ${roleId}, assigned to ${args.plan.childId}`,
			);
		}
		entries.push({
			schema: "token-bundle-entry/v1",
			role: args.plan.role === "publisher" ? "publisher" : "subscriber",
			roleId,
			workerIndex: args.material.workerIndexByRoleId.get(roleId) ?? null,
			tokenBase64,
			tokenSha256,
			tokenCommitmentIndex,
			tokenMerkleProofSha256: [...proof],
		});
	}
	const bundle: TokenBundleV1 = {
		schema: "token-bundle/v1",
		executionSha256: args.executionSha256,
		cohortGrantSha256: args.cohortGrantSha256,
		childId: args.plan.childId,
		entryCount: entries.length,
		entries,
	};
	return parseTokenBundle(bundle);
}
