/**
 * Gate G10 — mass broadcast. Every constant and every derivation §1 of the
 * pre-registration states, mechanized.
 *
 * `docs/research/preregistrations/gate-g10-broadcast.md` fixed all of it before
 * this file existed. It lives in code for one reason: G6's amendment 1 caught a
 * scenario constant whose stated arithmetic did not produce the stated result,
 * and the only thing that caught it was mechanizing the page. Nothing here
 * decides anything — the numbers are transcriptions, and the tests assert that
 * the transcriptions still add up.
 */

/* -------------------------------------------------------------------------- */
/* §1.1–§1.2 — the fleet and the message                                      */
/* -------------------------------------------------------------------------- */

/** §1.1. The only subscriber count. G1 settled the count; the ladder is on rate. */
export const SUBSCRIBERS = 10_000;

/** §1.2. ~150 B of quote record plus the 48-byte stamp. */
export const MESSAGE_PAYLOAD_BYTES = 200;
/** §6.1. The stamp is v4 and still 48 B — the arm byte came out of v3's reserved. */
export const STAMP_BYTES_V4 = 48;
/** §1.2. What is left for the record itself once the stamp is paid. */
export function recordBytes(): number {
	return MESSAGE_PAYLOAD_BYTES - STAMP_BYTES_V4;
}

/* -------------------------------------------------------------------------- */
/* §1.3 — the wire                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Bytes one UDP datagram occupies on Ethernet, including the parts a naive
 * bitrate calculation forgets: preamble and inter-frame gap. Ticket 29 §3 fixed
 * this arithmetic; it is repeated here rather than imported so a change to
 * another gate's plan module cannot silently move this gate's cable STOP.
 */
export function wireBytes(payloadBytes: number): number {
	return (
		payloadBytes +
		8 /* UDP */ +
		20 /* IPv4 */ +
		14 /* Eth */ +
		4 /* FCS */ +
		8 /* preamble */ +
		12 /* IFG */
	);
}

export const GIGABIT = 1_000_000_000;
export const TWO_POINT_FIVE_GIGABIT = 2_500_000_000;

/** Packets/s a link of `linkBitsPerSec` carries at this payload size. */
export function wirePpsCeiling(
	payloadBytes: number,
	linkBitsPerSec = GIGABIT,
): number {
	return Math.floor(linkBitsPerSec / (wireBytes(payloadBytes) * 8));
}

/**
 * §1.5. Milliseconds a link needs to serialize one whole broadcast.
 *
 * This is the floor under every spread number this gate can produce: the last
 * subscriber cannot receive before the wire has carried all `subscribers`
 * packets. It is arithmetic, not a measurement, and it is the reason §1.5
 * rejects a 5 ms fairness bound.
 */
export function broadcastSerializationMs(
	subscribers = SUBSCRIBERS,
	payloadBytes = MESSAGE_PAYLOAD_BYTES,
	linkBitsPerSec = GIGABIT,
): number {
	return (subscribers * wireBytes(payloadBytes) * 8 * 1000) / linkBitsPerSec;
}

/* -------------------------------------------------------------------------- */
/* §1.4 — the message-rate ladder                                             */
/* -------------------------------------------------------------------------- */

/** §1.4 as amended (Amendment 4). The rungs that run, in order. */
export const RATE_LADDER = [1, 5] as const;
/**
 * §1.4. Rungs the arithmetic removed, each a tested fact rather than a
 * sentence: 10,000 × 50 pps is 1.064× a 1 GbE cable's ceiling at 200 B, and
 * 10,000 × 20 pps is 2× the *measured* path's clean ceiling (Amendment 4 —
 * `PATH_CLEAN_PPS`; the same §1.4 rule that removed 50 against the ideal wire
 * removes 20 against the real one).
 */
export const RATE_EXCLUDED = [50, 20] as const;
/** §1.4. Retail market-data conflation cadence is 100–250 ms; 5 Hz is standard. */
export const GATE_RATE = 5;

/** §1.4. Egress the fleet demands at a rate rung. */
export function egressPps(rate: number, subscribers = SUBSCRIBERS): number {
	return rate * subscribers;
}

/** §1.4. Fraction of a link one rung's egress occupies. */
export function wireOccupancy(
	rate: number,
	subscribers = SUBSCRIBERS,
	payloadBytes = MESSAGE_PAYLOAD_BYTES,
	linkBitsPerSec = GIGABIT,
): number {
	return (
		egressPps(rate, subscribers) / wirePpsCeiling(payloadBytes, linkBitsPerSec)
	);
}

/** A rung the wire cannot carry is not a gate rung (§1.4). */
export function rateFitsWire(
	rate: number,
	subscribers = SUBSCRIBERS,
	payloadBytes = MESSAGE_PAYLOAD_BYTES,
	linkBitsPerSec = GIGABIT,
): boolean {
	return wireOccupancy(rate, subscribers, payloadBytes, linkBitsPerSec) <= 1;
}

/* -------------------------------------------------------------------------- */
/* §1.5a — the measured impulse path (Amendment 4)                            */
/* -------------------------------------------------------------------------- */

/**
 * Amendment 4. The delivered clean-pps ceiling of the real cable path, pinned
 * from the registered pre-flight artifact (`g10-preflight-2026-08-19.json`,
 * `ceiling.cleanPps` at 200 B under the 0.5% loss bound). §1.5's 1 GbE
 * line-rate arithmetic survives above as the ideal wire; this is the path the
 * impulse actually crosses — the burst probe measured a 10,000-packet impulse
 * taking 75–95 ms end to end, not §1.5's 21.28 ms.
 */
export const PATH_CLEAN_PPS = 100_071;

/**
 * Amendment 4. The sink's allowance on top of path serialization. The burst
 * probe measured the Mac draining at wire pace (drain p99 ≈ the sender's own
 * emission time), so the original V-SP intent — the sink adds at most 20% —
 * carries over unchanged onto the measured path.
 */
export const PATH_SINK_MARGIN = 0.2;

/** Amendment 4. What the measured path needs to move one impulse. */
export function pathImpulseSerializationMs(subscribers = SUBSCRIBERS): number {
	return (subscribers / PATH_CLEAN_PPS) * 1000;
}

/* -------------------------------------------------------------------------- */
/* §1.6 — the spread bound (as amended — Amendment 4)                         */
/* -------------------------------------------------------------------------- */

/**
 * §1.6 as amended. The path's own impulse serialization plus the sink margin:
 * `10,000/100,071 × 1.2 ≈ 119.91 ms`. The original `0.25 × 1000/R`
 * emitter-period bound rested on §1.5's 21.28 ms line-rate premise, which the
 * burst probe disproved; the rate no longer sets the bound, it decides
 * applicability (below). The rate parameter is gone rather than underscored:
 * `spreadCrossoverRate` used to pass a literal `0` for it, which is meaningless
 * as a rate and would become a division by zero the day anyone reintroduced a
 * rate term.
 */
export function spreadBoundMs(subscribers = SUBSCRIBERS): number {
	return pathImpulseSerializationMs(subscribers) * (1 + PATH_SINK_MARGIN);
}

/**
 * §1.6 as amended. Whether the spread clause is satisfiable at all at this
 * rung: one impulse must fit inside its own message period, or broadcasts
 * overlap in the path and the spread measures queueing, not the fan-out.
 *
 * At 10,000 subscribers on the measured path the crossover is R < 8.34.
 */
export function spreadClauseApplies(
	rate: number,
	subscribers = SUBSCRIBERS,
	_payloadBytes = MESSAGE_PAYLOAD_BYTES,
	_linkBitsPerSec = GIGABIT,
): boolean {
	return 1000 / rate > spreadBoundMs(subscribers);
}

/** §1.6 as amended. How much of the bound the sink margin leaves on top of the path. */
export function spreadHeadroom(
	_rate: number,
	subscribers = SUBSCRIBERS,
	_payloadBytes = MESSAGE_PAYLOAD_BYTES,
	_linkBitsPerSec = GIGABIT,
): number {
	return spreadBoundMs(subscribers) / pathImpulseSerializationMs(subscribers);
}

/** §1.6. The rate above which the wire floor swallows the bound. */
export function spreadCrossoverRate(
	subscribers = SUBSCRIBERS,
	_payloadBytes = MESSAGE_PAYLOAD_BYTES,
	_linkBitsPerSec = GIGABIT,
): number {
	return 1000 / spreadBoundMs(subscribers);
}

/* -------------------------------------------------------------------------- */
/* §1.7 — the RTT budget                                                      */
/* -------------------------------------------------------------------------- */

/** §1.7. The point at which a trading UI's tape reads as lagging, not live. */
export const QUOTE_STALENESS_BUDGET_MS = 100;
/** §1.7. Regional internet path round trip, typical. */
export const INTERNET_RTT_MS = 60;
/** §1.7. One frame at 60 fps, to render the update. */
export const CLIENT_RENDER_FRAME_MS = 1000 / 60;

/** §1.7. What the budget leaves for the server-side round trip, unrounded. */
export function rttResidueMs(): number {
	return QUOTE_STALENESS_BUDGET_MS - INTERNET_RTT_MS - CLIENT_RENDER_FRAME_MS;
}

/** §1.7. The clause: the residue rounded down to a registered figure. */
export const RTT_BOUND_MS = 20;

/* -------------------------------------------------------------------------- */
/* §1.9 — the probe cohort and the rung's total load                          */
/* -------------------------------------------------------------------------- */

/** §1.9. Subscribers that also run the independent RTT loop. */
export const PROBE_COHORT = 100;
/** §1.9. The probe's own send cadence — unrelated to the broadcast. */
export const PROBE_HZ = 2;

/**
 * §1.9. Fan-out indices the probe cohort occupies: evenly spaced, so the cohort
 * spans the fan-out order instead of sampling its head.
 */
export function probeIndices(
	subscribers = SUBSCRIBERS,
	cohort = PROBE_COHORT,
): number[] {
	const stride = Math.floor(subscribers / cohort);
	const out: number[] = [];
	for (let i = 0; i < cohort; i += 1) out.push(i * stride);
	return out;
}

export type ArmShape = {
	rate: number;
	subscribers: number;
	payloadBytes: number;
	/** Broadcast copies leaving the server per second. */
	broadcastEgressPps: number;
	/** Probe datagrams arriving per second. */
	probeUpPps: number;
	/** Probe echoes leaving per second. */
	probeDownPps: number;
	/** The publisher's own tick. */
	publisherUpPps: number;
	serverInPps: number;
	serverOutPps: number;
	serverTotalPps: number;
	wireOccupancy: number;
	serializationMs: number;
	spreadBoundMs: number;
	spreadClauseApplies: boolean;
};

/** §1.9, computed rather than transcribed. */
export function armShape(
	rate: number,
	subscribers = SUBSCRIBERS,
	payloadBytes = MESSAGE_PAYLOAD_BYTES,
	linkBitsPerSec = GIGABIT,
): ArmShape {
	const broadcast = egressPps(rate, subscribers);
	const probeUp = PROBE_COHORT * PROBE_HZ;
	const probeDown = probeUp;
	const publisherUp = rate;
	const serverIn = probeUp + publisherUp;
	const serverOut = broadcast + probeDown;
	return {
		rate,
		subscribers,
		payloadBytes,
		broadcastEgressPps: broadcast,
		probeUpPps: probeUp,
		probeDownPps: probeDown,
		publisherUpPps: publisherUp,
		serverInPps: serverIn,
		serverOutPps: serverOut,
		serverTotalPps: serverIn + serverOut,
		wireOccupancy: wireOccupancy(
			rate,
			subscribers,
			payloadBytes,
			linkBitsPerSec,
		),
		serializationMs: broadcastSerializationMs(
			subscribers,
			payloadBytes,
			linkBitsPerSec,
		),
		spreadBoundMs: spreadBoundMs(),
		spreadClauseApplies: spreadClauseApplies(
			rate,
			subscribers,
			payloadBytes,
			linkBitsPerSec,
		),
	};
}

/* -------------------------------------------------------------------------- */
/* §1.10 — the provenance ledger's cost entries (K16 / K17)                   */
/* -------------------------------------------------------------------------- */

/**
 * Measured ns/target from `tools/bench/mirror-send/RUNS.md`, payload 200 B,
 * N = 10,000. These are microbench cells on a shared Mac: **no absolute number
 * here is a result**, and the addon omits quinn's mutex, framing, the byte
 * governor and all IO, so every mirror-vs-baseline ratio derived from them is a
 * lower bound on the mirror's advantage.
 */
export const EMITTER_COST_NS_PER_TARGET = {
	/** K16, runs 1 / 3 / 5 — the landed promise-free path A1 and A2 both take. */
	landedTrySend: [331, 334, 343],
	/** K16 — the retired per-target promise path. Never a comparand (§2.4). */
	retiredPromise: [2879, 2772, 3367],
	/** K17 — mirror with a `string[]` target list. */
	mirrorStringTargets: [84, 84, 86],
	/** K17 — mirror with a `Uint32Array` target list. */
	mirrorUint32Targets: [28, 28, 30],
	/** K17 — mirror with a native group handle. */
	mirrorGroupHandle: [11, 11, 11],
} as const;

/** Milliseconds one broadcast costs in JS at a given per-target cost. */
export function emitterFloorMs(
	nsPerTarget: number,
	subscribers = SUBSCRIBERS,
): number {
	return (nsPerTarget * subscribers) / 1e6;
}

/** The worst (slowest) recorded cell for a shape — the honest direction. */
export function worstCostNs(
	shape: keyof typeof EMITTER_COST_NS_PER_TARGET,
): number {
	return Math.max(...EMITTER_COST_NS_PER_TARGET[shape]);
}

/** The best (fastest) recorded cell for a shape. */
export function bestCostNs(
	shape: keyof typeof EMITTER_COST_NS_PER_TARGET,
): number {
	return Math.min(...EMITTER_COST_NS_PER_TARGET[shape]);
}

/**
 * §1.10 / §9 P3. The largest spread improvement the mirror API could possibly
 * show at this gate: the whole landed emitter's cost, minus the mirror's own.
 *
 * Computed from the worst landed cell and the best mirror cell — the pairing
 * that flatters the lever most — so a prediction registered against it cannot be
 * accused of having been set low.
 */
export function maxMirrorSpreadGainMs(subscribers = SUBSCRIBERS): number {
	return (
		emitterFloorMs(worstCostNs("landedTrySend"), subscribers) -
		emitterFloorMs(bestCostNs("mirrorGroupHandle"), subscribers)
	);
}

/** That gain as a fraction of the wire floor it has to hide behind. */
export function maxMirrorGainAsWireFraction(
	subscribers = SUBSCRIBERS,
	payloadBytes = MESSAGE_PAYLOAD_BYTES,
	linkBitsPerSec = GIGABIT,
): number {
	return (
		maxMirrorSpreadGainMs(subscribers) /
		broadcastSerializationMs(subscribers, payloadBytes, linkBitsPerSec)
	);
}

/** §9 P3's registered ceiling on the lever's spread value at this gate. */
export const MIRROR_GAIN_PREDICTION_MS = 4;

/* -------------------------------------------------------------------------- */
/* §1.11 — the JS-thread stall budget (K19 / K20)                             */
/* -------------------------------------------------------------------------- */

/**
 * `DATAGRAM_MIRROR_MAX` as M1 shipped it
 * (`packages/webtransport/src/datagram-mirror.ts`).
 *
 * Transcribed rather than imported: this module has to state the number the gate
 * was designed against even when it runs on a tree with no mirror in it at all
 * (composition option C, prereg §11.1). `mirrorCapAgreesWithProduct` is the
 * reconciliation, and the conductor calls it when the entry point resolves.
 */
export const DATAGRAM_MIRROR_MAX = 10_000;

/**
 * §1.11 / C7. The stall bound, taken from M1's own cap derivation rather than
 * invented here: the mirror's cap exists to keep one synchronous call inside a
 * millisecond of JS thread, so a millisecond is what the gate holds it to.
 */
export const JS_STALL_BUDGET_MS = 1;

/** A2's chunk — the batch machinery's own size, and K14's deadline boundary. */
export const A2_CHUNK_TARGETS = 256;

/** §3.0. The arm this gate's verdict is taken on. A judgment, registered. */
export const VERDICT_ARM = "A2";

/**
 * §1.11. Targets a `JS_STALL_BUDGET_MS` stall admits at a per-target cost.
 *
 * This is M1's cap derivation, run forwards: at the worst measured cost of the
 * shipped `string[]` shape it yields ~11,628, and 10,000 is the round number
 * under it. The gate asserts the derivation reproduces rather than trusting the
 * comment it came from.
 */
export function stallBudgetTargets(nsPerTarget: number): number {
	return Math.floor((JS_STALL_BUDGET_MS * 1e6) / nsPerTarget);
}

/**
 * §1.11's headline: this gate's fleet is exactly the API's cap, so A3 is the
 * largest mirror call the product permits, five times a second.
 */
export function fleetSitsOnMirrorCap(subscribers = SUBSCRIBERS): boolean {
	return subscribers === DATAGRAM_MIRROR_MAX;
}

/** Whether a fleet can be mirrored in one call at all (the wrapper throws above). */
export function fleetFitsMirrorCap(subscribers = SUBSCRIBERS): boolean {
	return subscribers <= DATAGRAM_MIRROR_MAX;
}

/** Reconciliation against the product constant, once the entry point resolves. */
export function mirrorCapAgreesWithProduct(productCap: number): boolean {
	return productCap === DATAGRAM_MIRROR_MAX;
}

export type ArmStallFloor = {
	arm: "A1" | "A2" | "A3";
	/** The synchronous span C7 reads, in targets. */
	targetsPerSpan: number;
	nsPerTarget: number;
	floorMs: number;
	/** Whether §1.10's arithmetic already puts this arm inside the budget. */
	insideBudget: boolean;
	/**
	 * True when the floor is a *lower bound* rather than a prediction — the
	 * mirror's microbench omits quinn's connection mutex, which the landed call
	 * takes once per target (§1.11).
	 */
	lowerBoundOnly: boolean;
};

/**
 * §1.11's table. Each arm's stall floor is the cost of its own uninterrupted
 * span, not of the whole broadcast: A1 never yields, A2 yields every chunk, A3
 * is one call.
 *
 * The worst recorded cell is used throughout, which is the honest direction for
 * a bound a clause has to be read against.
 */
export function armStallFloors(subscribers = SUBSCRIBERS): ArmStallFloor[] {
	const landed = worstCostNs("landedTrySend");
	const mirror = worstCostNs("mirrorStringTargets");
	const chunk = Math.min(A2_CHUNK_TARGETS, subscribers);
	const rows: ArmStallFloor[] = [
		{
			arm: "A1",
			targetsPerSpan: subscribers,
			nsPerTarget: landed,
			floorMs: 0,
			insideBudget: false,
			lowerBoundOnly: false,
		},
		{
			arm: "A2",
			targetsPerSpan: chunk,
			nsPerTarget: landed,
			floorMs: 0,
			insideBudget: false,
			lowerBoundOnly: false,
		},
		{
			arm: "A3",
			targetsPerSpan: subscribers,
			nsPerTarget: mirror,
			floorMs: 0,
			insideBudget: false,
			lowerBoundOnly: true,
		},
	];
	for (const row of rows) {
		row.floorMs = (row.targetsPerSpan * row.nsPerTarget) / 1e6;
		row.insideBudget = row.floorMs <= JS_STALL_BUDGET_MS;
	}
	return rows;
}

/** P8. The multiple of A3's microbench floor the prediction registers. */
export const MIRROR_STALL_UNDERPRICING_FACTOR = 2;

/**
 * §9 P8. The mirror's stall floor from a microbench with no connection mutex in
 * it — a lower bound on the landed call, never a prediction of it.
 */
export function mirrorStallFloorMs(subscribers = SUBSCRIBERS): number {
	return emitterFloorMs(worstCostNs("mirrorStringTargets"), subscribers);
}

/** §6.6b. The loop-lag sampler's period: a quarter of the RTT bound. */
export const LOOP_LAG_SAMPLE_MS = 5;
/** V-L. Ticks the sampler must have recorded, as a fraction of the implied count. */
export const LOOP_LAG_MIN_TICK_FRACTION = 0.9;

/** V-L. Ticks a window of this many seconds implies at the sampler's period. */
export function expectedLoopLagTicks(windowSeconds: number): number {
	return Math.floor((windowSeconds * 1000) / LOOP_LAG_SAMPLE_MS);
}

/* -------------------------------------------------------------------------- */
/* §3 / §7 — the registered thresholds                                        */
/* -------------------------------------------------------------------------- */

/** C2a — fleet delivery. */
export const DELIVERY_FLOOR = 0.999;
/** C2b — subscribers that must individually clear `DELIVERY_FLOOR`. */
export const PER_SUBSCRIBER_COHORT_FLOOR = 0.99;
/** C1 — completeness a message needs before its spread counts. */
export const MESSAGE_COMPLETENESS_FLOOR = 0.999;
/** V-X — messages the completeness guard may exclude before C1 loses force. */
export const MAX_EXCLUDED_MESSAGE_FRACTION = 0.01;
/** C5 — residual the stage ledger may carry. */
export const STAGE_RESIDUAL_FRACTION = 0.001;
/** C6 — fraction of `messages × subscribers` the emitter must have issued. */
export const EMITTED_FRACTION_FLOOR = 0.99;
/** V-G — probe offered ratio. */
export const OFFERED_RATIO_FLOOR = 0.99;
/** V-K — histogram skew. */
export const HISTOGRAM_SKEW_FRACTION = 0.001;
/** V-A — arm comparability: the spread across arms of a lag percentile. */
export const ARM_LAG_SPREAD_LIMIT = 2;
/** V-S — the sink pre-check drives this multiple of the arm's downstream. */
export const SINK_HEADROOM_FACTOR = 1.5;
/** V-S — delivery the sink must hold at that multiple. */
export const SINK_DELIVERY_FLOOR = 0.995;
/**
 * V-F — probe schedule-lag ceiling, as a fraction of the RTT bound.
 *
 * 0.25, not 0.1 (Amendment 3): with the sleep-then-spin crossing, interactive
 * thread QoS and a 10 ms spin window all in place, this generator's honest
 * floor over the cable is p99 3.12 ms — the macOS scheduler's own tail for an
 * sshd-launched process. scheduleLag never enters the RTT arithmetic (§6.3
 * differences two *actual* instants); it only perturbs the sampling grid,
 * which held (0 skipped, offered ratio 1.0) in every measured run. The max
 * stays disclosed.
 */
export const PROBE_FLOOR_RTT_FRACTION = 0.25;

/** V-S, in pps (§11a step 0b). */
export function sinkPrecheckPps(rate = GATE_RATE): number {
	return Math.round(SINK_HEADROOM_FACTOR * egressPps(rate));
}

/**
 * V-SP as amended (Amendments 4 and 5), in ms: the sink may take at most the same 20%
 * margin on top of what the sender needed to emit the impulse. The original
 * loopback-spread form (20% of §1.5's wire floor, 4.26 ms) asked the loopback
 * to do something no loopback can — offer a line-rate impulse — so its number
 * measured the local emitter, not the sink. The burst probe measures the sink
 * against the real NIC's impulse, and this ceiling bounds it.
 *
 * Amendment 5: the argument is the sender's emission **net of its own backoff
 * sleeps**. Gross emission folded the sender's `setTimeout(0)` waits into the
 * sink's allowance, so a sender having a bad day raised the very bar the sink
 * was judged against — the ceiling grew with the noise it exists to exclude.
 */
export function sinkDrainCeilingMs(netEmitMaxMs: number): number {
	return netEmitMaxMs * (1 + PATH_SINK_MARGIN);
}

/** V-F, in ms (§7). */
export function probeFloorLagCeilingMs(): number {
	return PROBE_FLOOR_RTT_FRACTION * RTT_BOUND_MS;
}

/* -------------------------------------------------------------------------- */
/* §8 — the cable STOP                                                        */
/* -------------------------------------------------------------------------- */

export const PREFLIGHT_MAX_LOSS_PCT = 0.1;
export const PREFLIGHT_MIN_MTU_BYTES = 1280;

/** §8. 10% of the RTT bound — tighter than G6's because this budget is tighter. */
export function preflightMaxIdleRttP99Ms(): number {
	return RTT_BOUND_MS / 10;
}

export type PreflightRequirementSpec = {
	name: "R-down" | "R-up";
	offeredPps: number;
	payloadBytes: number;
	maxLossPct: number;
	minMtuBytes: number;
	maxIdleRttP99Ms: number;
};

/**
 * §8's two requirements, derived from the gate rung's own shape so a change to
 * the scenario cannot leave the cable STOP checking the old rate.
 */
export function preflightRequirements(
	rate = GATE_RATE,
): PreflightRequirementSpec[] {
	const shape = armShape(rate);
	const idle = preflightMaxIdleRttP99Ms();
	return [
		{
			name: "R-down",
			offeredPps: shape.broadcastEgressPps,
			payloadBytes: shape.payloadBytes,
			maxLossPct: PREFLIGHT_MAX_LOSS_PCT,
			minMtuBytes: PREFLIGHT_MIN_MTU_BYTES,
			maxIdleRttP99Ms: idle,
		},
		{
			name: "R-up",
			offeredPps: shape.serverInPps,
			payloadBytes: shape.payloadBytes,
			maxLossPct: PREFLIGHT_MAX_LOSS_PCT,
			minMtuBytes: PREFLIGHT_MIN_MTU_BYTES,
			maxIdleRttP99Ms: idle,
		},
	];
}

/**
 * §8's disclosed gap: C2a allows 0.1% end-to-end loss and the standing link
 * bound is also 0.1%, so a link at exactly the bound would consume the clause's
 * whole budget. This returns the loss the link *should* contribute — a fifth —
 * so the artifact can print both and the reader can see the difference.
 */
export function derivedLinkLossBudgetPct(): number {
	return ((1 - DELIVERY_FLOOR) * 100) / 5;
}
