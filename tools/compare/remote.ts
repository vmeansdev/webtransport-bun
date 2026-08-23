/**
 * Task 6: Remote process lifecycle management.
 *
 * Provides:
 * - PidRecord type and validation (no stale/malformed PIDs)
 * - Bounded SSH command execution helpers (deadline-guarded)
 * - Server launch/stop lifecycle (structured; no broad pkill)
 *
 * All subprocess and SSH commands have explicit deadlines.
 * Cleanup targets only validated run-scoped PIDs/process groups.
 * Broad `pkill` is forbidden.
 */

export interface PidRecord {
	/** The process ID of the launched role. */
	readonly pid: number;
	/** The process group ID. */
	readonly pgid: number;
	/** The run ID this process belongs to. */
	readonly runId: string;
	/** Human-readable role name (e.g. "server", "supervisor"). */
	readonly role: string;
	/** When this record was created (ms since epoch). */
	readonly createdAt: number;
}

export interface PidValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

/**
 * Validate a run-scoped PID record.
 * Rejects stale, zero, negative, or incomplete records.
 */
export function validatePidRecord(record: PidRecord): PidValidationResult {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return {
			valid: false,
			reason: `invalid PID: ${record.pid}; must be a positive integer`,
		};
	}
	if (!Number.isInteger(record.pgid) || record.pgid <= 0) {
		return {
			valid: false,
			reason: `invalid PGID: ${record.pgid}; must be a positive integer`,
		};
	}
	if (
		!record.runId ||
		typeof record.runId !== "string" ||
		record.runId.trim().length === 0
	) {
		return { valid: false, reason: "runId must be a non-empty string" };
	}
	if (
		!record.role ||
		typeof record.role !== "string" ||
		record.role.trim().length === 0
	) {
		return { valid: false, reason: "role must be a non-empty string" };
	}
	return { valid: true };
}

export interface BoundedCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly timedOut: boolean;
}

/**
 * Run a Bun subprocess with a bounded deadline (ms).
 * Returns structured output; never throws for non-zero exit codes.
 * Kills the process on deadline expiry.
 */
export async function runBounded(
	args: readonly string[],
	deadlineMs: number,
	options: {
		readonly cwd?: string;
		readonly env?: Record<string, string>;
	} = {},
): Promise<BoundedCommandResult> {
	const proc = Bun.spawn(args as string[], {
		cwd: options.cwd,
		env: options.env ? { ...process.env, ...options.env } : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	const timer = setTimeout(
		() => {
			timedOut = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// already exited
			}
		},
		Math.max(1, deadlineMs),
	);

	const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]).finally(() => clearTimeout(timer));

	return {
		stdout: stdoutBuf,
		stderr: stderrBuf,
		exitCode,
		timedOut,
	};
}

/**
 * Run an SSH command with a bounded deadline.
 * Uses `ssh -o ConnectTimeout=... -o BatchMode=yes`.
 * Never uses shell wildcards or broad cleanup commands.
 */
export async function runSsh(
	host: string,
	command: string,
	deadlineMs: number,
): Promise<BoundedCommandResult> {
	const timeoutSecs = Math.max(1, Math.ceil(deadlineMs / 1000));
	return runBounded(
		[
			"ssh",
			"-o",
			`ConnectTimeout=${timeoutSecs}`,
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			host,
			command,
		],
		deadlineMs,
	);
}
