/**
 * Task 6: Netem and qdisc controls.
 *
 * Safety rules:
 * - Netem is applied ONLY to Linux eno1.
 * - The root qdisc MUST be `fq` before netem can be installed.
 * - A remote supervisor holds the flock and watches a lease; on lease expiry
 *   it kills the PGID, restores `fq`, writes cleanup status, and releases.
 * - A failed post-execution restoration is evidenceStatus: FAIL.
 * - A missing precondition (not fq, no sudo) is BLOCKED.
 *
 * This module contains only pure tc argument builders and validators.
 * Subprocess execution lives in remote.ts.
 */

export interface QdiscState {
	/** The qdisc kind, e.g. "fq", "netem", "pfifo_fast". */
	readonly kind: string;
	/** The network interface. */
	readonly dev: string;
	/** Whether this is the root qdisc. */
	readonly isRoot: boolean;
	/** Raw tc qdisc show output. */
	readonly raw: string;
}

export interface NetemProfile {
	/** Packet loss percentage (0 = no loss). */
	readonly loss: number;
	/** Delay in milliseconds. */
	readonly delayMs: number;
	/**
	 * The netem queue depth, in packets.  netem defaults to 1000, which a
	 * delayed high-bandwidth arm overruns — and an overrun queue tail-drops,
	 * which is an undisclosed second loss source on top of the requested
	 * `loss`.  Size it with `netemLimitPackets`.
	 */
	readonly limitPackets: number;
	/** Direction (always "egress" for tc netem). */
	readonly direction: "egress";
}

/**
 * The queue depth a bandwidth-delay product needs, plus the headroom a burst
 * costs.  Below this netem drops packets the profile never asked it to drop,
 * and the two arms lose different byte volumes because they hand the qdisc
 * differently sized skbs.
 */
export function netemLimitPackets(
	bandwidthMbps: number,
	delayMs: number,
	mtuBytes: number,
): number {
	const bytesInFlight = (bandwidthMbps * 1_000_000 * delayMs) / 1000 / 8;
	const packets = Math.ceil(bytesInFlight / mtuBytes);
	// Two BDPs of headroom, and never below netem's own default.
	return Math.max(1000, packets * 2);
}

/** The offload state netem's per-skb loss model makes load-bearing. */
export interface OffloadState {
	readonly tso: boolean;
	readonly gso: boolean;
	readonly gro: boolean;
}

/**
 * `ethtool -k <iface>` is the only way to observe segmentation offload, and
 * offload decides how many packets a byte stream becomes — which decides what
 * a per-skb loss percentage actually costs each arm.
 */
export function buildOffloadQueryArgs(iface: string): string[] {
	return ["-k", iface];
}

/** Parse the `ethtool -k` lines that matter to a per-skb loss model. */
export function parseOffloadState(raw: string): OffloadState {
	const on = (key: string): boolean =>
		new RegExp(`^${key}:\\s*on`, "m").test(raw);
	return {
		tso: on("tcp-segmentation-offload"),
		gso: on("generic-segmentation-offload"),
		gro: on("generic-receive-offload"),
	};
}

export interface NetemValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

const REQUIRED_QDISC = "fq";
const REQUIRED_INTERFACE = "eno1";

/**
 * Parse the output of `tc qdisc show dev <iface>` and extract state.
 *
 * Expected format (from fixture):
 *   qdisc fq 1: dev eno1 root ...
 */
export function parseQdisc(raw: string): QdiscState {
	const firstLine = raw.split("\n")[0] ?? "";

	// Match: qdisc <kind> <handle>: dev <iface> root
	const kindMatch = firstLine.match(/^qdisc\s+(\S+)/);
	const devMatch = firstLine.match(/\bdev\s+(\S+)/);
	const isRoot = firstLine.includes("root");

	return {
		kind: kindMatch?.[1]?.trim() ?? "",
		dev: devMatch?.[1]?.trim() ?? "",
		isRoot,
		raw,
	};
}

/** Returns true iff the qdisc state represents the expected fq root qdisc. */
export function isExpectedFq(state: QdiscState): boolean {
	return state.kind === REQUIRED_QDISC && state.isRoot;
}

/**
 * Validate that netem can be safely installed on the given interface.
 * The root qdisc must be `fq` before netem is applied.
 */
export function validateNetemPrecondition(
	current: QdiscState,
	_profile: NetemProfile,
): NetemValidationResult {
	if (!isExpectedFq(current)) {
		return {
			valid: false,
			reason:
				`netem precondition failed: expected root qdisc 'fq', ` +
				`got '${current.kind}' on ${current.dev}; netem cannot be safely installed`,
		};
	}
	return { valid: true };
}

/**
 * Build the tc command arguments for applying netem to an interface.
 * Returns an array of arguments suitable for passing to a subprocess.
 *
 * Caller is responsible for verifying preconditions before executing.
 */
export function buildNetemInstallArgs(
	iface: string,
	profile: NetemProfile,
): string[] {
	// tc qdisc add dev <iface> root netem delay <delayMs>ms [loss <loss>%]
	const args = ["qdisc", "add", "dev", iface, "root", "netem"];

	if (profile.delayMs > 0) {
		args.push("delay", `${profile.delayMs}ms`);
	}

	if (profile.loss > 0) {
		args.push("loss", `${profile.loss}%`);
	}

	// Always explicit.  Relying on netem's 1000-packet default is how the
	// impairment acquires a second, undisclosed loss source.
	args.push("limit", `${profile.limitPackets}`);

	return args;
}

/**
 * Build the tc command arguments for removing netem from an interface,
 * restoring the original `fq` root qdisc.
 */
export function buildNetemRestoreArgs(iface: string): string[] {
	// tc qdisc del dev <iface> root && tc qdisc add dev <iface> root fq
	// Expressed as two separate arg arrays; caller runs them in sequence.
	return ["qdisc", "del", "dev", iface, "root"];
}

/**
 * Build the tc command arguments for restoring the fq root qdisc.
 */
export function buildFqRestoreArgs(iface: string): string[] {
	return ["qdisc", "add", "dev", iface, "root", "fq"];
}
