/**
 * Arm W of the stream-throughput axis: the flow-control window sweep's math and
 * verdict rules, separated from the harness that drives it so they can be tested
 * without a runner.
 *
 * The contract is Amendment 2 of docs/research/preregistrations/stream-throughput.md.
 * Everything here was fixed before the first dispatch: the knee rule, the
 * retention falsifier and both STOP conditions. Nothing in this file looks at a
 * number to decide which question to ask of it.
 */

/** Only ever a ceiling here; the sweep's largest value is orders below it. */
export const QUIC_VARINT_MAX = 2 ** 62 - 1;
export const DATAGRAM_CHANNEL_CAPACITY_CEILING = 2048;

/** Shipped defaults, from crates/native/src/limits.rs. */
export const DEFAULT_MAX_DATAGRAM_SIZE = 1200;
export const DEFAULT_QUEUED_BYTES_PER_STREAM = 256 * 1024;
export const DEFAULT_QUEUED_BYTES_PER_SESSION = 2 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 2000;
const SHIPPED_PER_SESSION_BUDGET = 2 * 1024 * 1024;
/** The rig this axis runs on. The worst case is stated against it, not hidden. */
const RIG_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;

export type WindowMath = {
	perStream: number;
	perSession: number;
	streamReceiveWindow: number;
	receiveWindow: number;
	sendWindow: number;
	datagramChannelCapacity: number;
	/** receive + send + channel x maxDatagramSize. Advertised, not allocated. */
	perSessionWorstCaseBytes: number;
	atArmSessionsBytes: number;
	atMaxSessionsBytes: number;
	/** Whether the rung's per-session governor is still the shipped 2 MiB budget. */
	insideShippedPerSessionBudget: boolean;
	/** Advertised worst case at max_sessions as a fraction of the rig's 8 GB. */
	atMaxSessionsFractionOfRig: number;
};

/**
 * What a peer is licensed to make the server buffer for one session, derived the
 * way crates/native/src/transport_memory.rs derives it. This is an advertisement
 * ceiling, never an allocation: a rung whose observed RSS sits far below this
 * number has not contradicted it.
 */
export function windowMath(
	perStream: number,
	perSession: number,
	sessions: number,
	maxSessions = DEFAULT_MAX_SESSIONS,
	maxDatagramSize = DEFAULT_MAX_DATAGRAM_SIZE,
): WindowMath {
	const clamp = (v: number) => Math.min(Math.max(v, 1), QUIC_VARINT_MAX);
	const dgram = Math.max(maxDatagramSize, 1);
	const streamReceiveWindow = clamp(Math.max(perStream, dgram));
	const receiveWindow = clamp(Math.max(perSession, streamReceiveWindow));
	const sendWindow = receiveWindow;
	const datagramChannelCapacity = Math.min(
		Math.max(Math.ceil(Math.max(perSession, 1) / dgram), 1),
		DATAGRAM_CHANNEL_CAPACITY_CEILING,
	);
	const perSessionWorstCaseBytes =
		receiveWindow + sendWindow + datagramChannelCapacity * dgram;
	return {
		perStream,
		perSession,
		streamReceiveWindow,
		receiveWindow,
		sendWindow,
		datagramChannelCapacity,
		perSessionWorstCaseBytes,
		atArmSessionsBytes: perSessionWorstCaseBytes * sessions,
		atMaxSessionsBytes: perSessionWorstCaseBytes * maxSessions,
		insideShippedPerSessionBudget: perSession <= SHIPPED_PER_SESSION_BUDGET,
		atMaxSessionsFractionOfRig:
			(perSessionWorstCaseBytes * maxSessions) / RIG_MEMORY_BYTES,
	};
}

/**
 * A mirror that has drifted from the code it mirrors produces a memory column
 * describing a server that is not running, so the run refuses to start. The
 * expected values are the ones asserted by transport_memory.rs's own
 * `derives_default_flow_control_and_slot_snapshot` test.
 */
export function assertWindowMathMirror(): void {
	const m = windowMath(
		DEFAULT_QUEUED_BYTES_PER_STREAM,
		DEFAULT_QUEUED_BYTES_PER_SESSION,
		1,
	);
	const expected = {
		streamReceiveWindow: 256 * 1024,
		receiveWindow: 2 * 1024 * 1024,
		sendWindow: 2 * 1024 * 1024,
		datagramChannelCapacity: 1748,
	};
	for (const [key, want] of Object.entries(expected)) {
		const got = m[key as keyof typeof expected];
		if (got !== want) {
			throw new Error(
				`window math mirror drifted from crates/native/src/transport_memory.rs: ${key} derived ${got}, transport_memory.rs asserts ${want}`,
			);
		}
	}
}

/**
 * Carried in the artifact so neither memory number can be read as the other.
 *
 * The derived figure is an *advertisement*: the bytes a peer is licensed to make
 * the server buffer, receive_window + send_window + datagram channel, summed
 * over sessions. Nothing allocates it up front, so an observed RSS far below it
 * is the expected loopback result and not a refutation. The observed figure is
 * process-wide resident memory, which includes the harness and tracks delivered
 * throughput as well as window size, so it is not attributable to the windows
 * alone. And `maxQueuedBytesGlobal` (512 MiB) governs queued application bytes;
 * it does not bound the advertised window memory above.
 */
export const WINDOW_MEMORY_NOTE =
	"peak committed memory is reported as a pair that is never merged: " +
	"advertised worst case per session (receive_window + send_window + " +
	"datagramChannel x maxDatagramSize, derived from transport_memory.rs, an " +
	"exposure ceiling that nothing allocates up front) and observed resident " +
	"peak (process-wide RSS, which includes the harness and tracks delivered " +
	"throughput as well as window size). maxQueuedBytesGlobal does NOT bound " +
	"the advertised figure";

export type WindowRungRole = "ladder" | "tie-in" | "retention-falsifier";

/** The per-rung facts the verdict rules are allowed to see. */
export type WindowRungFacts = {
	rung: string;
	role: WindowRungRole;
	math: WindowMath;
	bucket: string;
	incomplete: boolean;
	deliveredMbps: number;
	rssMbBaseline: number;
	rssMbPeak: number;
};

/**
 * Arm W's verdict: the pre-registered knee rule, the retention falsifier and the
 * two STOP conditions.
 */
export function evaluateWindowSweep(rungs: WindowRungFacts[]) {
	const ladder = rungs.filter((r) => r.role === "ladder");
	const complete = ladder.filter((r) => !r.incomplete);
	const repeat = rungs.find((r) => r.role === "retention-falsifier");
	const first = ladder[0];

	// W-repeat coming back near W1 means the rungs above it were not simply
	// served from memory an earlier rung had already taken.
	const memoryRetention =
		repeat && first && !repeat.incomplete && !first.incomplete
			? repeat.rssMbPeak <= 1.2 * first.rssMbPeak
				? "CLEAN"
				: "CONTAMINATED"
			: "UNKNOWN";
	const rssDeltasReportable = memoryRetention === "CLEAN";

	const stops: string[] = [];
	if (complete.length < 3) {
		stops.push(
			`W-STOP-A: ${complete.length} complete ladder rungs (<3); no knee and no memory curve`,
		);
	}
	if (!rssDeltasReportable) {
		stops.push(
			`W-STOP-B: memoryRetention=${memoryRetention}; per-rung RSS deltas are not quoted, the memory statement rests on the advertised worst case and the absolute peak series`,
		);
	}

	let knee: WindowRungFacts | null = null;
	let kneeNote: string;
	const top = ladder[ladder.length - 1];
	if (complete.length < 3) {
		kneeNote = "W-STOP-A fired: no knee derived";
	} else if (top && !top.incomplete && top.bucket === "window-scaling") {
		// The sweep never bracketed the knee, so the honest output is an open
		// interval. Naming the top rung would be naming the edge of the ladder.
		kneeNote = `top rung ${top.rung} is still window-scaling: the sweep did not bracket the knee; knee is at or above perStream=${top.math.perStream}`;
	} else {
		const best = complete.reduce((a, b) =>
			b.deliveredMbps > a.deliveredMbps ? b : a,
		);
		knee =
			complete.find((r) => r.deliveredMbps >= 0.95 * best.deliveredMbps) ??
			null;
		kneeNote = knee
			? `smallest complete rung delivering >= 95% of the best complete rung (${best.rung})`
			: "no complete rung met the 95% rule";
	}

	const rungRow = (r: WindowRungFacts) => ({
		rung: r.rung,
		role: r.role,
		perStream: r.math.perStream,
		perSession: r.math.perSession,
		bucket: r.bucket,
		incomplete: r.incomplete,
		deliveredGbps: r.deliveredMbps / 1000,
		advertisedWorstCasePerSessionBytes: r.math.perSessionWorstCaseBytes,
		advertisedAtArmSessionsBytes: r.math.atArmSessionsBytes,
		advertisedAtMaxSessionsBytes: r.math.atMaxSessionsBytes,
		advertisedAtMaxSessionsFractionOfRig: r.math.atMaxSessionsFractionOfRig,
		insideShippedPerSessionBudget: r.math.insideShippedPerSessionBudget,
		observedRssMbBaseline: r.rssMbBaseline,
		observedRssMbPeak: r.rssMbPeak,
		observedRssMbDelta: rssDeltasReportable
			? r.rssMbPeak - r.rssMbBaseline
			: null,
	});

	return {
		memoryRetention,
		rssDeltasReportable,
		stops,
		knee: knee ? rungRow(knee) : null,
		kneeNote,
		curve: rungs.map(rungRow),
		memoryNote: WINDOW_MEMORY_NOTE,
		decisionNote:
			"Arm W measures; it decides nothing. Decoupling the windows from the " +
			"byte governors versus raising the governors is ticket 09's call",
	};
}
