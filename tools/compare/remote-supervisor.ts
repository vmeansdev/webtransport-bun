/**
 * Task 6: Remote supervisor.
 *
 * The supervisor runs on Linux and:
 * - Acquires /tmp/bench.lock via flock (exclusive, non-blocking)
 * - Owns the server PGID so cleanup targets only that group
 * - Watches a controller heartbeat lease
 * - On lease expiry: kills the owned PGID, restores fq, writes cleanup artifact,
 *   releases the lock
 *
 * The supervisor is a separate process, not part of the server process group.
 * The Mac controller also performs bounded shutdown and an independent recovery
 * command before the next run.
 *
 * This module provides the supervisor state machine and lease management types.
 * Actual process spawning uses remote.ts helpers.
 */

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
