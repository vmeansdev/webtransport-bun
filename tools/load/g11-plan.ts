/**
 * Gate G11 (bidirectional tunnel / proxy) — the scenario arithmetic, as
 * functions over the scenario's constants rather than as numbers typed into a
 * harness.
 *
 * The contract is docs/research/preregistrations/gate-g11-bidi.md, committed
 * before this file existed. Every constant here is one the document derives on
 * its own page (§1), and every derived figure the document prints is produced
 * here by the same arithmetic — so that if the two ever disagree, a test fails
 * instead of a run being reported against a page that says something else.
 *
 * Mechanising the arithmetic is also what catches the arithmetic. G6's
 * pre-registration claimed a datagram count its own constants did not produce,
 * and only a module like this one found it.
 */

// --- Scenario constants (pre-registration §1.3, §1.5) -----------------------

/** Full-MSS inner segment of a tunnelled TCP flow. */
export const INNER_PACKET_BYTES = 1400;
/** Length prefix a stream-framed tunnel puts in front of each inner packet. */
export const FRAME_PREFIX_BYTES = 2;
/** One inner packet is one write(), which is one N-API crossing (ledger K13). */
export const FRAME_BYTES = INNER_PACKET_BYTES + FRAME_PREFIX_BYTES;

/**
 * Per-direction per-tunnel rate: the effort's desktop-share constant applied to
 * both directions. The symmetry is a stress shape, not a traffic model — see
 * the pre-registration §1.3, which says so before the run.
 */
export const TUNNEL_MBPS_PER_DIRECTION = 3;

/** The gate's session ladder; `T-200` is exploratory and not a gate rung. */
export const TUNNEL_LADDER = [25, 50, 100] as const;
export const TUNNEL_GATE_RUNG = 100;
export const TUNNEL_EXPLORATORY_RUNG = 200;

/**
 * How many repeats of the gate cell §5 grades, straight off the §2 Arm T row
 * (`| **T-100** | **100** | off | **2** | the gate cell |`) and §5's heading
 * ("all evaluated on cell `T-100`, both repeats").
 *
 * It lives here, in the registration module, because it is registration text —
 * not a dispatch input. `G11_REPEATS` decides how many repeats a run *drives*;
 * this decides how many a PASS *requires*. Reading both sides of that
 * comparison off the same environment variable would make the check
 * unfailable-by-dispatch: a run asked for one repeat would bank one, compare it
 * against one, and stamp PASS on a shape §5 does not grade.
 */
export const REGISTERED_GATE_REPEATS = 2;

/** Arm X (acceptance path): the collab/RPC exchange. */
export const EXCHANGE_REQUEST_BYTES = 120;
export const EXCHANGE_RESPONSE_BYTES = 120;
/** An actively-typing collaborator emits an op batch every 500 ms. */
export const EXCHANGES_PER_SESSION_PER_SEC = 2;
export const EXCHANGE_LADDER = [250, 500, 1000] as const;
export const EXCHANGE_GATE_RUNG = 1000;

// --- Shipped governors, read out of the tree (crates/native/src/limits.rs) ---

export const SHIPPED_QUEUED_BYTES_PER_STREAM = 256 * 1024;
export const SHIPPED_QUEUED_BYTES_PER_SESSION = 2 * 1024 * 1024;
export const SHIPPED_QUEUED_BYTES_GLOBAL = 512 * 1024 * 1024;
export const SHIPPED_BACKPRESSURE_TIMEOUT_MS = 5000;
export const SHIPPED_MAX_STREAMS_PER_SESSION_BIDI = 200;

// --- Interaction budget (pre-registration §1.6) -----------------------------

export const PERCEIVED_INTERACTIVE_MS = 150;
export const INPUT_FRAME_MS = 16.7;
export const PUBLIC_INTERNET_RTT_MS = 60;
export const RENDER_FRAME_MS = 16.7;

/**
 * What the budget leaves for a round trip through the transport, floored to the
 * round number the gate states. G6 derived the same 50 ms from the same budget
 * for a realm round trip; this gate halves it for one traversal, so the two
 * numbers differ by exactly the factor that difference implies.
 */
export function roundTripBudgetMs(): number {
	const remainder =
		PERCEIVED_INTERACTIVE_MS -
		INPUT_FRAME_MS -
		PUBLIC_INTERNET_RTT_MS -
		RENDER_FRAME_MS;
	return Math.floor(remainder / 10) * 10;
}

/** Arm T's clause: one traversal, per direction, raw p99. */
export function oneWayBoundMs(): number {
	return roundTripBudgetMs() / 2;
}

/** Arm X's clause: a genuine round trip, unhalved. */
export function exchangeRttBoundMs(): number {
	return roundTripBudgetMs();
}

// --- Arm T arithmetic -------------------------------------------------------

export type TunnelRung = {
	sessions: number;
	/** Bytes per second, one direction, one tunnel. */
	bytesPerSecPerDirectionPerTunnel: number;
	/** Frames per second, one direction, one tunnel. */
	framesPerSecPerTunnel: number;
	/** Seconds between frames on one tunnel in one direction. */
	frameIntervalMs: number;
	/** Aggregate offered rate in one direction. */
	mbpsPerDirection: number;
	/** Both directions summed. */
	mbpsTotal: number;
	/** Aggregate frames per second in one direction. */
	framesPerSecPerDirection: number;
	/**
	 * The number that matters: server-side JS boundary crossings per second with
	 * the chunk-batching knob off — one read crossing per inbound frame plus one
	 * write crossing per outbound frame (ledger K13: there is no stream
	 * send-side batching).
	 */
	serverCrossingsPerSec: number;
};

export function bytesPerSecPerDirection(): number {
	return (TUNNEL_MBPS_PER_DIRECTION * 1_000_000) / 8;
}

export function tunnelRung(sessions: number): TunnelRung {
	if (!Number.isInteger(sessions) || sessions <= 0) {
		throw new Error(`g11: tunnel rung must be a positive integer: ${sessions}`);
	}
	const bytesPerSec = bytesPerSecPerDirection();
	const framesPerSecPerTunnel = bytesPerSec / FRAME_BYTES;
	const framesPerSecPerDirection = framesPerSecPerTunnel * sessions;
	return {
		sessions,
		bytesPerSecPerDirectionPerTunnel: bytesPerSec,
		framesPerSecPerTunnel,
		frameIntervalMs: (FRAME_BYTES / bytesPerSec) * 1000,
		mbpsPerDirection: TUNNEL_MBPS_PER_DIRECTION * sessions,
		mbpsTotal: TUNNEL_MBPS_PER_DIRECTION * sessions * 2,
		framesPerSecPerDirection,
		serverCrossingsPerSec: framesPerSecPerDirection * 2,
	};
}

// --- Arm X arithmetic -------------------------------------------------------

export type ExchangeRung = {
	sessions: number;
	exchangesPerSec: number;
	/** One bidi stream open per exchange. */
	bidiOpensPerSec: number;
	bytesPerSec: number;
};

export function exchangeRung(sessions: number): ExchangeRung {
	if (!Number.isInteger(sessions) || sessions <= 0) {
		throw new Error(
			`g11: exchange rung must be a positive integer: ${sessions}`,
		);
	}
	const exchangesPerSec = sessions * EXCHANGES_PER_SESSION_PER_SEC;
	return {
		sessions,
		exchangesPerSec,
		bidiOpensPerSec: exchangesPerSec,
		bytesPerSec:
			exchangesPerSec * (EXCHANGE_REQUEST_BYTES + EXCHANGE_RESPONSE_BYTES),
	};
}

// --- Arm D arithmetic (the cross-direction budget probe) --------------------

/** Inbound-backlog targets as fractions of the shipped per-stream budget. */
export const BACKLOG_FRACTIONS = [0, 0.25, 0.75, 0.95] as const;

export function backlogTargetBytes(fraction: number): number {
	if (fraction < 0 || fraction > 1) {
		throw new Error(`g11: backlog fraction out of range: ${fraction}`);
	}
	return Math.floor(SHIPPED_QUEUED_BYTES_PER_STREAM * fraction);
}

/**
 * How much of a loaded cell's registered backlog target has to show up in the
 * cell's own queued-bytes counter before the cell is allowed to produce a
 * reading at all.
 *
 * Half. A withholding reader's peak is sawtooth — it drains at the target and
 * refills — so demanding the full target would fire on a correctly-shaped run
 * that happened to be sampled mid-drain. Half is far above any sampling
 * artefact and far below "the backlog was never built", which is the only case
 * this is here to catch.
 */
export const BACKLOG_WITNESS_FRACTION = 0.5;

/**
 * The floor a loaded Arm D cell's peak queued bytes must clear for its numbers
 * to mean anything. Below it, the cell did not run the shape it is labelled
 * with, and a flat latency curve across it is a statement about a backlog that
 * never accumulated rather than about the budget under test.
 */
export function backlogWitnessBytes(fraction: number): number {
	return Math.floor(backlogTargetBytes(fraction) * BACKLOG_WITNESS_FRACTION);
}

/**
 * How long the slow end must withhold consumption to accumulate `targetBytes` of
 * unconsumed inbound reservation at the arm's inbound frame rate. This is the
 * **total** accumulation time for the whole backlog, not a per-frame delay — at
 * f = 0.95 it is 664 ms — and both call sites hold it once per drained batch of
 * `targetBytes / FRAME_BYTES` frames. Do not divide it by the frame count.
 */
export function consumptionDelayMsForBacklog(targetBytes: number): number {
	const framesToHold = targetBytes / FRAME_BYTES;
	const rung = tunnelRung(1);
	return framesToHold * rung.frameIntervalMs;
}

// --- Pacer residual (pre-registration §5 C5, §8) ----------------------------

/**
 * The cumulative-deadline pacer's worst-case residual over a step: one frame
 * interval, expressed as a fraction of the step. It is quoted in the fairness
 * clause's derivation to show the 5% band is not measuring the pacer.
 */
export function pacerResidualFraction(stepSeconds: number): number {
	if (stepSeconds <= 0) throw new Error("g11: step seconds must be positive");
	return tunnelRung(1).frameIntervalMs / 1000 / stepSeconds;
}

// --- Downstream emitter spreading (pre-registration §8) ---------------------

/**
 * The server's downstream emitter offsets each session's virtual clock by
 * `index / sessions` of one frame interval, so N sessions do not fire one
 * N-frame impulse per tick. G6's lesson, on this gate's egress side.
 */
export function emitterOffsetMs(index: number, sessions: number): number {
	if (!Number.isInteger(index) || index < 0 || index >= sessions) {
		throw new Error(`g11: emitter index ${index} outside 0..${sessions - 1}`);
	}
	return (tunnelRung(1).frameIntervalMs * index) / sessions;
}

// --- Memory statement (clause C8) -------------------------------------------

export const SHIPPED_MAX_DATAGRAM_SIZE = 1200;
export const DATAGRAM_CHANNEL_SLOT_CAP = 2048;

/**
 * The advertised per-session worst case on the shipped governors:
 * receive_window + send_window + the datagram channel. Both windows derive from
 * maxQueuedBytesPerSession (transport_memory.rs), and the channel holds
 * `ceil(perSession / maxDatagram)` slots clamped at 2048. This gate sends no
 * datagrams, but the figure includes the channel because the server allocates
 * it regardless — and because G5b's memory statement was computed this way, so
 * clause C8 has to be comparable to it.
 */
export function advertisedPerSessionBytes(
	perSession = SHIPPED_QUEUED_BYTES_PER_SESSION,
	maxDatagram = SHIPPED_MAX_DATAGRAM_SIZE,
): number {
	const slots = Math.min(
		DATAGRAM_CHANNEL_SLOT_CAP,
		Math.ceil(perSession / maxDatagram),
	);
	return perSession * 2 + slots * maxDatagram;
}
