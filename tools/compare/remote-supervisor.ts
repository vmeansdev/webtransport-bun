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
 * The Mac-side `spawnMacSupervisor` uses `Bun.spawn` directly, so the
 * trust-bootstrap FDs the controller opens are inherited across
 * fork+exec (standard Unix FD inheritance). The rig-side
 * `spawnRigSupervisor` opens an SSH session whose stdin/stdout ARE the
 * supervisor's `--control-in-fd 0` / `--control-out-fd 1`, and the
 * wrapper script opens the four trust-bootstrap files on the rig at
 * their known paths and exec's the supervisor with the FD numbers in
 * argv. No SCM_RIGHTS, no Node-FFI addon: the whole mechanism is
 * standard Unix process plumbing.
 *
 * host-sidecar.ts is *not* where this lives. It is a pure FD/port
 * validator, classified `controllerOnlyTs`, and adding `Bun.spawn` to it
 * would shift a parser into a process-management role no caller outside
 * `compare-controller.ts` would expect. The supervisors' spawn lives
 * here because `remote-supervisor.ts` already owns lease/lock/PGID
 * lifecycle and is where anyone reading the supervisor's story looks.
 */

import { existsSync, openSync, closeSync } from "node:fs";

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

	// The script opens four files for read and two directories, gets their
	// FD numbers, exec's the supervisor with those FDs in argv. FDs 0/1/2
	// are reserved for stdin/stdout/stderr so the bootstrap FDs start at 3.
	const script = `#!/bin/sh
set -eu
authority_fd=3
authority_digest_fd=4
campaign_root_fd=5
staging_root_fd=6
exec 3<${shellQuote(options.rigPaths.authorityFile)}
exec 4<${shellQuote(options.rigPaths.authorityDigestFile)}
exec 5>${shellQuote(options.rigPaths.campaignRootDir)} 2>/dev/null || exec 5<&-
# campaign-root-fd must be a directory FD; opening the path with O_DIRECTORY
# is implied by \`<dir\` in sh, but not on every sh. Use a portable form.
exec 5<&-
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
// pipe direction.
// ---------------------------------------------------------------------------

/** A spawned supervisor and the channels that talk to it. */
export interface SupervisorHandle {
	/** The OS PID the supervisor's process started at. */
	readonly pid: number;
	/** Which host this supervisor lives on. */
	readonly host: "mac" | "rig";
	/** The Bun subprocess handle (kept for stopSupervisor). */
	readonly subprocess: import("bun").Subprocess;
	/** The four bootstrap FDs the parent opened; closed on stopSupervisor. */
	readonly bootstrapFds: readonly number[];
}

/** Refusal from the live spawn helpers. */
export type LiveSpawnRefusal =
	| SpawnRefusal
	| {
			readonly ok: false;
			readonly code: "SPAWN_BINARY_OPEN_FAILED";
			readonly message: string;
	  };

/**
 * Spawn the Mac-resident supervisor locally. Opens the four trust-bootstrap
 * files at the supplied paths in the parent, builds the argv, and calls
 * `Bun.spawn`. The bootstrap FDs are inherited by the child via fork+exec.
 *
 * Returns a `SupervisorHandle` the caller stores; `stopSupervisor(handle)`
 * closes the parent's bootstrap FDs and kills the child.
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
		/** Where the supervisor's stdout should land (defaults to inherited). */
		readonly stdoutPath?: string;
		/** Where the supervisor's stderr should land (defaults to inherited). */
		readonly stderrPath?: string;
	},
): Promise<
	{ readonly ok: true; readonly handle: SupervisorHandle } | LiveSpawnRefusal
> {
	const fdCheck = assertDistinctFds(options);
	if (!fdCheck.ok) return fdCheck;

	let authorityFd: number;
	let authorityDigestFd: number;
	let campaignRootFd: number;
	let stagingRootFd: number;
	try {
		authorityFd = openSync(options.localPaths.authorityFile, "r");
		authorityDigestFd = openSync(options.localPaths.authorityDigestFile, "r");
		// The campaign-root-fd and staging-root-fd must be directory FDs.
		// `openSync(path, "r")` opens a directory for reading on POSIX; Bun
		// preserves the O_DIRECTORY flag.
		campaignRootFd = openSync(options.localPaths.campaignRootDir, "r");
		stagingRootFd = openSync(options.localPaths.stagingRootDir, "r");
	} catch (error) {
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `cannot open trust-bootstrap file: ${(error as Error).message}`,
		};
	}

	const argv: string[] = [
		options.binaryPath,
		"--authority-fd",
		String(authorityFd),
		"--authority-digest-fd",
		String(authorityDigestFd),
		"--campaign-root-fd",
		String(campaignRootFd),
		"--staging-root-fd",
		String(stagingRootFd),
	];
	if (options.control !== undefined) {
		argv.push(
			"--control-in-fd",
			String(options.control.controlIn.fd),
			"--control-out-fd",
			String(options.control.controlOut.fd),
		);
	}

	let proc: import("bun").Subprocess;
	try {
		const stdoutTarget: "inherit" | "pipe" = "pipe";
		proc = Bun.spawn(argv, {
			stdin: options.control !== undefined ? "pipe" : "inherit",
			stdout: stdoutTarget,
			stderr: stdoutTarget,
			env: {
				...process.env,
				COMPARISON_SUPERVISOR_BUN_PATH: options.bunExecutablePath,
			},
		});
	} catch (error) {
		// Close the FDs we opened in the parent; the child never inherited
		// them because fork+exec failed.
		safeClose(authorityFd);
		safeClose(authorityDigestFd);
		safeClose(campaignRootFd);
		safeClose(stagingRootFd);
		return {
			ok: false,
			code: "SPAWN_BINARY_OPEN_FAILED",
			message: `Bun.spawn failed: ${(error as Error).message}`,
		};
	}

	return {
		ok: true,
		handle: {
			pid: proc.pid,
			host: "mac",
			subprocess: proc,
			bootstrapFds: [
				authorityFd,
				authorityDigestFd,
				campaignRootFd,
				stagingRootFd,
			],
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
		"sh",
		"-s", // read script from stdin
	];
	return { ok: true, sshArgv, wrapperScript: wrapper.script };
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
	const proc = handle.subprocess;
	try {
		proc.kill("SIGTERM");
	} catch {
		// already exited; close FDs and report
		for (const fd of handle.bootstrapFds) safeClose(fd);
		return { ok: true, exitCode: 0 };
	}
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			for (const fd of handle.bootstrapFds) safeClose(fd);
			return { ok: true, exitCode: proc.exitCode };
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		// ignore
	}
	for (const fd of handle.bootstrapFds) safeClose(fd);
	return { ok: true, exitCode: proc.exitCode ?? -1 };
}

function safeClose(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// already closed or invalid; ignore
	}
}
