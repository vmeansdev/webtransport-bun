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
	spawn as nodeSpawn,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseMeasurementGrant } from "./evidence.ts";
import { canonicalRecordBytes } from "./secure-fs.ts";
import {
	decodeSupervisorFrame,
	encodeSupervisorFrame,
	type MeasurementGrantV1,
} from "./supervisor-client.ts";
import {
	measurementPayloadBytes,
	type MeasurementSeries,
} from "./supervisor-protocol.ts";

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
		writable.write(bytes, (error) => {
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
