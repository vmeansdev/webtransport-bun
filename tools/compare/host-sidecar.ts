/**
 * Task 6: Host sidecar probes and capacity validation.
 *
 * Validates:
 * - RLIMIT_NOFILE soft/hard limits and effective child limit (≥65536 required)
 * - Mac ephemeral port range and free-port headroom for connection-scale arms
 *
 * No persistent host settings are changed. The launcher raises only the
 * run-scoped child soft limit within the recorded hard cap.
 */

export interface FdCapacity {
	/** Observed soft limit (e.g. from /proc/1/limits or ulimit -Sn). */
	readonly soft: number;
	/** Observed hard limit (e.g. from /proc/1/limits or ulimit -Hn). */
	readonly hard: number;
	/** The effective child soft limit after raising (min(hard, 65536)). */
	readonly effectiveChildLimit: number;
	/** Source description for evidence. */
	readonly source: string;
}

export interface FdValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

export interface PortCapacity {
	/** First ephemeral port (e.g. net.inet.ip.portrange.first = 49152). */
	readonly first: number;
	/** Last ephemeral port (e.g. net.inet.ip.portrange.last = 65535). */
	readonly last: number;
	/** Number of currently occupied ports in the ephemeral range. */
	readonly occupied: number;
	/** Free ephemeral ports: (last - first + 1) - occupied. */
	readonly free: number;
	/** Raw source for evidence. */
	readonly source: string;
}

export interface PortValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

const REQUIRED_CHILD_LIMIT = 65536;

/**
 * Parse /proc/1/limits or shell `ulimit` output for Max open files.
 *
 * Linux /proc/<pid>/limits format:
 *   Max open files            1024                524288               files
 */
export function parseRlimit(raw: string): { soft: number; hard: number } {
	// Match "Max open files <soft> <hard>"
	const m = raw.match(/Max open files\s+(\d+)\s+(\d+)/i);
	if (!m) {
		throw new Error(
			`parseRlimit: could not find 'Max open files' in: ${raw.slice(0, 120)}`,
		);
	}
	const soft = parseInt(m[1] ?? "0", 10);
	const hard = parseInt(m[2] ?? "0", 10);
	return { soft, hard };
}

/**
 * Validate that the effective child FD limit meets the minimum requirement.
 */
export function validateFdLimits(cap: FdCapacity): FdValidationResult {
	if (cap.effectiveChildLimit < REQUIRED_CHILD_LIMIT) {
		return {
			valid: false,
			reason:
				`effective child limit ${cap.effectiveChildLimit} is below the required ${REQUIRED_CHILD_LIMIT}; ` +
				`hard limit is ${cap.hard}; adjust only the run-scoped child limit`,
		};
	}
	return { valid: true };
}

/**
 * Validate that sufficient free ephemeral ports exist for the target live-set.
 *
 * Required headroom:
 * - 10,000-client arm: 12,500 free ports (live-set + 25%)
 * - 5,000-client arm: 6,250 free ports
 * - Other arms: no port constraint
 */
export function validatePortHeadroom(
	cap: PortCapacity,
	clientCount: number,
): PortValidationResult {
	const required = Math.ceil(clientCount * 1.25);
	if (cap.free < required) {
		return {
			valid: false,
			reason:
				`insufficient free ephemeral ports for ${clientCount}-client arm: ` +
				`required ${required}, available ${cap.free}; ` +
				`range [${cap.first}–${cap.last}], occupied ${cap.occupied}`,
		};
	}
	return { valid: true };
}
